import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda'
import { createHandler, HttpError, ok, type RouteRequest } from './lib/api'
import { sha256 } from './lib/crypto'
import { aliasOf, type Alias } from './lib/http'
import {
  authorizationServerMetadata,
  baseUrlOf,
  CLIENT_TTL_SECONDS,
  CODE_TTL_SECONDS,
  grantScopes,
  grantUser,
  isValidChallenge,
  isValidRedirectUri,
  issueTokens,
  newClientId,
  newSecret,
  protectedResourceMetadata,
  redirectMatches,
  resourceOf,
  SCOPES,
  verifyPkce,
} from './lib/oauth'
import { getClient, putClient, putCode, takeCode, takeToken } from './lib/oauthStore'
import { authenticate } from './lib/session'

// A registration that is never used for an authorization is gone after a day
const PENDING_CLIENT_TTL_SECONDS = 24 * 60 * 60

// Metadata, registration and token requests come from Claude's OAuth client, not from the app
function publicJson(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  }
}

const oauthError = (error: string, description: string, status = 400) =>
  publicJson(status, { error, error_description: description })

function readForm(event: APIGatewayProxyEvent): Record<string, string> {
  if (!event.body) return {}
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body
  const type = event.headers?.['Content-Type'] ?? event.headers?.['content-type'] ?? ''
  if (type.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      return Object.fromEntries(Object.entries(parsed ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v : '']))
    } catch {
      return {}
    }
  }
  return Object.fromEntries(new URLSearchParams(raw))
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

// ── Discovery ────────────────────────────────────────────────────────────

// POST /oauth/register — dynamic client registration (RFC 7591), public clients only
async function register(event: APIGatewayProxyEvent, alias: Alias) {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '')) as Record<string, unknown>
  } catch {
    return oauthError('invalid_client_metadata', 'Body is not JSON')
  }
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : []
  if (!redirectUris.length || redirectUris.length > 10 || !redirectUris.every(isValidRedirectUri)) {
    return oauthError('invalid_redirect_uri', 'redirect_uris must be https or http loopback URLs')
  }
  const method = body.token_endpoint_auth_method
  if (method !== undefined && method !== 'none') {
    return oauthError('invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none") are supported')
  }
  const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : 'Onbekende app'
  const client = {
    clientId: newClientId(),
    name,
    redirectUris,
    createdAt: new Date().toISOString(),
    expiresAt: nowSeconds() + PENDING_CLIENT_TTL_SECONDS,
  }
  await putClient(alias, client)
  return publicJson(201, {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
    client_name: client.name,
    redirect_uris: client.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  })
}

// POST /oauth/token — authorization_code (with PKCE) and refresh_token (rotated)
async function token(event: APIGatewayProxyEvent, alias: Alias) {
  const form = readForm(event)
  const clientId = form.client_id ?? ''
  if (form.grant_type === 'authorization_code') {
    if (!form.code || !form.code_verifier || !form.redirect_uri || !clientId) {
      return oauthError('invalid_request', 'code, code_verifier, redirect_uri and client_id are required')
    }
    const code = await takeCode(alias, sha256(form.code))
    if (!code || code.clientId !== clientId || code.redirectUri !== form.redirect_uri) {
      return oauthError('invalid_grant', 'Unknown, expired or already used code')
    }
    if (!verifyPkce(form.code_verifier, code.codeChallenge)) return oauthError('invalid_grant', 'PKCE verification failed')
    const { redirectUri: _r, codeChallenge: _c, expiresAt: _e, ...grant } = code
    if (!(await grantUser(alias, grant))) return oauthError('invalid_grant', 'The user no longer has access')
    return publicJson(200, await issueTokens(alias, grant))
  }
  if (form.grant_type === 'refresh_token') {
    if (!form.refresh_token || !clientId) return oauthError('invalid_request', 'refresh_token and client_id are required')
    const old = await takeToken(alias, sha256(form.refresh_token), 'REFRESH')
    if (!old || old.clientId !== clientId) return oauthError('invalid_grant', 'Unknown or expired refresh token')
    const { expiresAt: _e, ...grant } = old
    const current = await grantUser(alias, grant)
    if (!current) return oauthError('invalid_grant', 'The user no longer has access')
    // A refresh may narrow the scopes, never widen them
    const asked = (form.scope ?? '').split(' ').filter(Boolean)
    const scopes = asked.length ? current.scopes.filter((s) => asked.includes(s)) : current.scopes
    if (!scopes.length) return oauthError('invalid_scope', 'None of the requested scopes were granted')
    return publicJson(200, await issueTokens(alias, { ...grant, scopes }))
  }
  return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token')
}

// ── Consent (called by the app's /oauth/authorize page, with the app session) ──

interface AuthorizeParams {
  clientId: string
  redirectUri: string
  state?: string
  codeChallenge: string
  scope?: string
}

const text = (v: unknown) => (typeof v === 'string' ? v : undefined)

async function readAuthorize(req: RouteRequest, source: Record<string, unknown>) {
  const clientId = text(source.client_id) ?? ''
  const redirectUri = text(source.redirect_uri) ?? ''
  const client = clientId ? await getClient(req.alias, clientId) : undefined
  if (!client) throw new HttpError(400, 'Deze app is niet (meer) bekend. Start het koppelen opnieuw vanuit de app.')
  if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) {
    throw new HttpError(400, 'De terugkeer-adres van deze app klopt niet. Start het koppelen opnieuw.')
  }
  if (text(source.response_type) !== 'code') throw new HttpError(400, 'Deze app vraagt een soort toegang die we niet ondersteunen.')
  const challenge = text(source.code_challenge) ?? ''
  if (text(source.code_challenge_method) !== 'S256' || !isValidChallenge(challenge)) {
    throw new HttpError(400, 'Deze app gebruikt geen veilige koppeling (PKCE). Koppelen kan niet.')
  }
  const resource = text(source.resource)
  if (resource && resource.replace(/\/$/, '') !== resourceOf(baseUrlOf(req.event))) {
    throw new HttpError(400, 'Deze app vraagt toegang tot een onbekende dienst.')
  }
  const params: AuthorizeParams = { clientId, redirectUri, state: text(source.state), codeChallenge: challenge, scope: text(source.scope) }
  return { client, params }
}

function redirectWith(uri: string, values: Record<string, string | undefined>): string {
  const url = new URL(uri)
  for (const [k, v] of Object.entries(values)) if (v !== undefined) url.searchParams.set(k, v)
  return url.toString()
}

// GET /oauth/authorize?<the client's query> — what the consent page shows
async function describe(req: RouteRequest) {
  const user = await authenticate(req)
  const { client, params } = await readAuthorize(req, req.event.queryStringParameters ?? {})
  const scopes = grantScopes(params.scope, user)
  if (!scopes.length) throw new HttpError(403, 'Je account heeft geen toegang tot wat deze app vraagt.')
  return ok({
    client: { name: client.name, redirectHost: new URL(params.redirectUri).host },
    scopes: scopes.map((scope) => ({ scope, description: SCOPES[scope] })),
  })
}

// POST /oauth/authorize — { ...the client's query, approve } → where the browser goes next
async function decide(req: RouteRequest) {
  const user = await authenticate(req)
  const { client, params } = await readAuthorize(req, req.body)
  const iss = baseUrlOf(req.event)
  if (req.body.approve !== true) {
    return ok({ redirectTo: redirectWith(params.redirectUri, { error: 'access_denied', state: params.state, iss }) })
  }
  const scopes = grantScopes(params.scope, user)
  if (!scopes.length) throw new HttpError(403, 'Je account heeft geen toegang tot wat deze app vraagt.')
  const code = newSecret()
  await putCode(req.alias, sha256(code), {
    userId: user.id,
    clientId: client.clientId,
    scopes,
    tokenVersion: user.tokenVersion,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    expiresAt: nowSeconds() + CODE_TTL_SECONDS,
  })
  // A used client stays registered
  await putClient(req.alias, { ...client, expiresAt: nowSeconds() + CLIENT_TTL_SECONDS })
  return ok({ redirectTo: redirectWith(params.redirectUri, { code, state: params.state, iss }) })
}

const consent = createHandler({
  'GET /oauth/authorize': describe,
  'POST /oauth/authorize': decide,
})

export async function handler(event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> {
  const alias = aliasOf(context)
  const route = `${event.httpMethod} ${event.resource}`
  if (event.resource === '/oauth/authorize') return consent(event, context)
  try {
    const base = baseUrlOf(event)
    switch (route) {
      case 'GET /.well-known/oauth-protected-resource':
        return publicJson(200, protectedResourceMetadata(base))
      case 'GET /.well-known/oauth-authorization-server':
      case 'GET /.well-known/openid-configuration':
        return publicJson(200, authorizationServerMetadata(base, alias))
      case 'POST /oauth/register':
        return await register(event, alias)
      case 'POST /oauth/token':
        return await token(event, alias)
      default:
        return oauthError('not_found', 'Unknown endpoint', 404)
    }
  } catch (err) {
    console.error(err)
    return oauthError('server_error', 'Internal error', 500)
  }
}
