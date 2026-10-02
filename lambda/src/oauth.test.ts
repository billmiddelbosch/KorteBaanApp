import type { APIGatewayProxyEvent, Context } from 'aws-lambda'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { signToken } from './lib/crypto'
import type { UserRecord } from './lib/store'

// In-memory stand-in for the OAuth items and users in DynamoDB
const db = vi.hoisted(() => ({
  users: new Map<string, UserRecord>(),
  items: new Map<string, Record<string, unknown> & { expiresAt: number }>(),
}))

vi.mock('./lib/secrets', () => ({ jwtSecret: async () => 'test-secret' }))

vi.mock('./lib/store', async (importOriginal) => ({
  dayOf: (await importOriginal<typeof import('./lib/store')>()).dayOf,
  getUser: async (_a: string, id: string) => structuredClone(db.users.get(id)),
  putUser: async (_a: string, user: UserRecord) => void db.users.set(user.id, structuredClone(user)),
}))

vi.mock('./lib/oauthStore', () => {
  const live = <T extends { expiresAt: number }>(v: T | undefined) => (v && v.expiresAt > Date.now() / 1000 ? structuredClone(v) : undefined)
  const take = (key: string) => {
    const v = db.items.get(key)
    db.items.delete(key)
    return live(v)
  }
  return {
    putClient: async (_a: string, c: { clientId: string; expiresAt: number }) => void db.items.set(`client:${c.clientId}`, structuredClone(c)),
    getClient: async (_a: string, id: string) => live(db.items.get(`client:${id}`)),
    putCode: async (_a: string, hash: string, code: { expiresAt: number }) => void db.items.set(`code:${hash}`, structuredClone(code)),
    takeCode: async (_a: string, hash: string) => take(`code:${hash}`),
    putToken: async (_a: string, hash: string, kind: string, t: { expiresAt: number }) =>
      void db.items.set(`${kind}:${hash}`, structuredClone(t)),
    getToken: async (_a: string, hash: string, kind: string) => live(db.items.get(`${kind}:${hash}`)),
    takeToken: async (_a: string, hash: string, kind: string) => take(`${kind}:${hash}`),
  }
})

const { handler } = await import('./oauth')
const { authenticateBearer } = await import('./lib/oauth')

const context = { invokedFunctionArn: 'arn:aws:lambda:eu-west-2:123456789012:function:kortebaan-oauth:prod' } as Context
const BASE = 'https://api.example.com/prod'
const REDIRECT = 'http://localhost:33418/callback'
const VERIFIER = 'v'.repeat(50)
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')

const user = (id: string, role: UserRecord['role']): UserRecord => ({
  id,
  name: id,
  username: id,
  role,
  status: 'active',
  dailyLimit: null,
  tokenVersion: 1,
  failedLogins: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActiveAt: new Date().toISOString(),
})

function call(
  method: string,
  resource: string,
  opts: { body?: string; json?: unknown; query?: Record<string, string>; as?: UserRecord; form?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { Host: 'api.example.com' }
  let body: string | null = opts.body ?? null
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json)
    headers['Content-Type'] = 'application/json'
  }
  if (opts.form) {
    body = new URLSearchParams(opts.form).toString()
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }
  if (opts.as) headers.Authorization = `Bearer ${signToken({ sub: opts.as.id, ver: opts.as.tokenVersion }, 'test-secret', 3600)}`
  const event = {
    httpMethod: method,
    resource,
    headers,
    body,
    isBase64Encoded: false,
    queryStringParameters: opts.query ?? null,
    pathParameters: null,
    requestContext: { stage: 'prod' },
  } as unknown as APIGatewayProxyEvent
  return handler(event, context).then((r) => ({ ...r, json: r.body ? (JSON.parse(r.body) as Record<string, unknown>) : null }))
}

async function registerClient(redirect = REDIRECT) {
  const res = await call('POST', '/oauth/register', { json: { client_name: 'Claude Code', redirect_uris: [redirect] } })
  return res.json!.client_id as string
}

const authorizeQuery = (clientId: string, extra: Record<string, string> = {}) => ({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: REDIRECT,
  code_challenge: CHALLENGE,
  code_challenge_method: 'S256',
  state: 'xyz',
  ...extra,
})

async function approve(clientId: string, as: UserRecord, extra: Record<string, string> = {}) {
  const res = await call('POST', '/oauth/authorize', { json: { ...authorizeQuery(clientId, extra), approve: true }, as })
  expect(res.statusCode).toBe(200)
  const url = new URL(res.json!.redirectTo as string)
  return url.searchParams.get('code')!
}

const redeem = (clientId: string, code: string, verifier = VERIFIER) =>
  call('POST', '/oauth/token', {
    form: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId },
  })

const bearer = (token: string) =>
  ({ headers: { Authorization: `Bearer ${token}` } }) as unknown as APIGatewayProxyEvent

let owner: UserRecord
let friend: UserRecord
beforeEach(() => {
  db.users.clear()
  db.items.clear()
  owner = user('owner-1', 'owner')
  friend = user('friend-1', 'friend')
  db.users.set(owner.id, owner)
  db.users.set(friend.id, friend)
})

describe('oauth discovery', () => {
  it('describes the protected resource and the authorization server', async () => {
    const pr = await call('GET', '/.well-known/oauth-protected-resource')
    expect(pr.json).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] })
    for (const resource of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      const as = await call('GET', resource)
      expect(as.json).toMatchObject({
        issuer: BASE,
        authorization_endpoint: 'https://kortebaan.nl/oauth/authorize',
        token_endpoint: `${BASE}/oauth/token`,
        registration_endpoint: `${BASE}/oauth/register`,
        code_challenge_methods_supported: ['S256'],
      })
    }
  })
})

describe('oauth register', () => {
  it('registers public clients with https or loopback redirects only', async () => {
    const res = await call('POST', '/oauth/register', { json: { client_name: 'claude.ai', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] } })
    expect(res.statusCode).toBe(201)
    expect(res.json).toMatchObject({ client_name: 'claude.ai', token_endpoint_auth_method: 'none' })

    const http = await call('POST', '/oauth/register', { json: { redirect_uris: ['http://evil.example/cb'] } })
    expect(http.json).toMatchObject({ error: 'invalid_redirect_uri' })
    const secret = await call('POST', '/oauth/register', {
      json: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' },
    })
    expect(secret.json).toMatchObject({ error: 'invalid_client_metadata' })
  })
})

describe('oauth authorize', () => {
  it('needs the app login and shows the app and the scopes it gets', async () => {
    const clientId = await registerClient()
    expect((await call('GET', '/oauth/authorize', { query: authorizeQuery(clientId) })).statusCode).toBe(401)

    const asOwner = await call('GET', '/oauth/authorize', { query: authorizeQuery(clientId), as: owner })
    expect(asOwner.json).toMatchObject({ client: { name: 'Claude Code', redirectHost: 'localhost:33418' } })
    expect((asOwner.json!.scopes as { scope: string }[]).map((s) => s.scope)).toEqual(['kb:read', 'kb:write', 'kb:sql'])

    const asFriend = await call('GET', '/oauth/authorize', { query: authorizeQuery(clientId), as: friend })
    expect((asFriend.json!.scopes as { scope: string }[]).map((s) => s.scope)).toEqual(['kb:read'])
    const onlyWrite = await call('GET', '/oauth/authorize', { query: authorizeQuery(clientId, { scope: 'kb:write' }), as: friend })
    expect(onlyWrite.statusCode).toBe(403)
  })

  it('rejects unknown clients, other redirects and a missing PKCE challenge', async () => {
    const clientId = await registerClient()
    const bad = [
      authorizeQuery('nope'),
      authorizeQuery(clientId, { redirect_uri: 'https://evil.example/cb' }),
      authorizeQuery(clientId, { code_challenge_method: 'plain' }),
      authorizeQuery(clientId, { resource: 'https://other.example/mcp' }),
    ]
    for (const query of bad) expect((await call('GET', '/oauth/authorize', { query, as: owner })).statusCode).toBe(400)
    // Loopback redirects may change port
    const otherPort = await call('GET', '/oauth/authorize', {
      query: authorizeQuery(clientId, { redirect_uri: 'http://localhost:5555/callback', resource: `${BASE}/mcp` }),
      as: owner,
    })
    expect(otherPort.statusCode).toBe(200)
  })

  it('sends a refusal back to the app', async () => {
    const clientId = await registerClient()
    const res = await call('POST', '/oauth/authorize', { json: { ...authorizeQuery(clientId), approve: false }, as: owner })
    const url = new URL(res.json!.redirectTo as string)
    expect(url.searchParams.get('error')).toBe('access_denied')
    expect(url.searchParams.get('state')).toBe('xyz')
  })
})

describe('oauth token', () => {
  it('exchanges a code once, with the right PKCE verifier', async () => {
    const clientId = await registerClient()
    const code = await approve(clientId, owner)
    expect((await redeem(clientId, code, 'w'.repeat(50))).json).toMatchObject({ error: 'invalid_grant' })

    const code2 = await approve(clientId, owner)
    const res = await redeem(clientId, code2)
    expect(res.statusCode).toBe(200)
    expect(res.headers?.['Cache-Control']).toBe('no-store')
    expect(res.json).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'kb:read kb:write kb:sql' })
    expect((await redeem(clientId, code2)).json).toMatchObject({ error: 'invalid_grant' })

    const auth = await authenticateBearer('prod', bearer(res.json!.access_token as string))
    expect(auth?.user.id).toBe(owner.id)
    expect(auth?.scopes).toEqual(['kb:read', 'kb:write', 'kb:sql'])
  })

  it('rotates refresh tokens and can narrow the scopes', async () => {
    const clientId = await registerClient()
    const first = (await redeem(clientId, await approve(clientId, owner))).json!
    const refresh = (scope?: string) =>
      call('POST', '/oauth/token', {
        form: { grant_type: 'refresh_token', refresh_token: first.refresh_token as string, client_id: clientId, ...(scope ? { scope } : {}) },
      })
    const second = await refresh('kb:read')
    expect(second.json).toMatchObject({ scope: 'kb:read' })
    expect((await refresh()).json).toMatchObject({ error: 'invalid_grant' })
  })

  it('stops working after a password change or when the role changes', async () => {
    const clientId = await registerClient()
    const tokens = (await redeem(clientId, await approve(clientId, owner))).json!
    const access = bearer(tokens.access_token as string)

    db.users.set(owner.id, { ...owner, role: 'friend' })
    expect((await authenticateBearer('prod', access))?.scopes).toEqual(['kb:read'])

    db.users.set(owner.id, { ...owner, tokenVersion: 2 })
    expect(await authenticateBearer('prod', access)).toBeNull()
    const refreshed = await call('POST', '/oauth/token', {
      form: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token as string, client_id: clientId },
    })
    expect(refreshed.json).toMatchObject({ error: 'invalid_grant' })
  })

  it('rejects unknown grant types', async () => {
    const res = await call('POST', '/oauth/token', { form: { grant_type: 'password' } })
    expect(res.json).toMatchObject({ error: 'unsupported_grant_type' })
  })
})
