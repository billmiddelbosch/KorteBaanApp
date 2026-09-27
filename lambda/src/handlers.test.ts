import type { APIGatewayProxyEvent, Context } from 'aws-lambda'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashPassword, signToken } from './lib/crypto'
import type { AiConfig, UserRecord } from './lib/store'

// In-memory stand-in for DynamoDB and Secrets Manager
const db = vi.hoisted(() => ({
  users: new Map<string, UserRecord>(),
  links: new Map<string, string>(),
  ai: undefined as AiConfig | undefined,
  claudeToken: null as string | null,
}))

vi.mock('./lib/secrets', () => ({
  jwtSecret: async () => 'test-secret',
  readClaudeToken: async () => db.claudeToken,
  writeClaudeToken: async (_alias: string, token: string | null) => {
    db.claudeToken = token
  },
}))

vi.mock('./lib/claude', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/claude')>()),
  testClaudeToken: vi.fn<typeof import('./lib/claude').testClaudeToken>(async () => ({ ok: true })),
}))

vi.mock('./lib/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/store')>()
  const clone = <T>(v: T): T => structuredClone(v)
  return {
    dayOf: actual.dayOf,
    UsernameTakenError: actual.UsernameTakenError,
    getUser: async (_a: string, id: string) => clone(db.users.get(id)),
    getUserByUsername: async (_a: string, username: string) =>
      clone([...db.users.values()].find((u) => u.username === username)),
    listUsers: async () => [...db.users.values()].map(clone),
    putUser: async (_a: string, user: UserRecord) => void db.users.set(user.id, clone(user)),
    claimUsername: async (_a: string, user: UserRecord) => {
      if ([...db.users.values()].some((u) => u.username === user.username && u.id !== user.id)) {
        throw new actual.UsernameTakenError()
      }
      db.users.set(user.id, clone(user))
    },
    deleteUser: async (_a: string, user: UserRecord) => void db.users.delete(user.id),
    setLink: async (
      _a: string,
      user: UserRecord,
      link: { hash: string; type: 'invite' | 'reset'; expiresAt: number },
    ) => {
      if (user.linkHash) db.links.delete(user.linkHash)
      db.links.set(link.hash, user.id)
      const updated = { ...user, linkHash: link.hash, linkType: link.type, linkExpiresAt: link.expiresAt }
      db.users.set(user.id, clone(updated))
      return updated
    },
    findLinkUser: async (_a: string, hash: string) => {
      const user = db.users.get(db.links.get(hash) ?? '')
      return user?.linkHash === hash ? clone(user) : undefined
    },
    clearLink: async (_a: string, user: UserRecord) => {
      if (user.linkHash) db.links.delete(user.linkHash)
      const { linkHash: _h, linkType: _t, linkExpiresAt: _e, ...rest } = user
      return rest
    },
    usageOn: async () => new Map([['friend-1', 3]]),
    listSessions: async () => [
      { id: 's1', date: '2026-08-12', draverij: 'Wolvega', staked: 20, paidOut: 34.5 },
      { id: 's2', date: '2026-08-05', draverij: 'Sint-Annaparochie', staked: 15, paidOut: 0 },
    ],
    getAiConfig: async () => clone(db.ai),
    putAiConfig: async (_a: string, config: AiConfig) => void (db.ai = clone(config)),
    deleteAiConfig: async () => void (db.ai = undefined),
  }
})

const { handler: auth } = await import('./auth')
const { handler: me } = await import('./me')
const { handler: friends } = await import('./friends')
const { handler: aiConnection } = await import('./aiConnection')
const { testClaudeToken } = await import('./lib/claude')

const context = {
  invokedFunctionArn: 'arn:aws:lambda:eu-west-2:123456789012:function:kortebaan-x:dev',
} as Context

function call(
  handler: typeof auth,
  method: string,
  resource: string,
  opts: { body?: unknown; params?: Record<string, string>; as?: UserRecord } = {},
) {
  const headers: Record<string, string> = { origin: 'http://localhost:5173' }
  if (opts.as) {
    headers.Authorization = `Bearer ${signToken({ sub: opts.as.id, ver: opts.as.tokenVersion }, 'test-secret', 60)}`
  }
  const event = {
    httpMethod: method,
    resource,
    headers,
    pathParameters: opts.params ?? null,
    body: opts.body === undefined ? null : JSON.stringify(opts.body),
  } as unknown as APIGatewayProxyEvent
  return handler(event, context).then((res) => ({ status: res.statusCode, body: JSON.parse(res.body) }))
}

// Obviously fake setup-token shaped values, only used to exercise validation
const fakeSetupToken = (tail: string) => ['sk', 'ant', 'oat01', tail].join('-')

const PASSWORD = 'goed-wachtwoord'
let owner: UserRecord
let friend: UserRecord

beforeEach(async () => {
  db.users.clear()
  db.links.clear()
  db.ai = { status: 'connected', tokenHint: '…abcd', connectedAt: '2026-09-01T10:00:00.000Z' }
  db.claudeToken = fakeSetupToken('existing-token-abcd')
  const passwordHash = await hashPassword(PASSWORD)
  const base = { tokenVersion: 0, failedLogins: 0, createdAt: '2026-09-01T10:00:00.000Z', passwordHash }
  owner = { ...base, id: 'owner-1', name: 'Bill', username: 'bill', role: 'owner', status: 'active', dailyLimit: null }
  friend = { ...base, id: 'friend-1', name: 'Kees', username: 'kees', role: 'friend', status: 'active', dailyLimit: 5 }
  db.users.set(owner.id, structuredClone(owner))
  db.users.set(friend.id, structuredClone(friend))
})

describe('auth', () => {
  it('logs in with username and password', async () => {
    const res = await call(auth, 'POST', '/auth/login', { body: { username: 'Kees', password: PASSWORD } })
    expect(res.status).toBe(200)
    expect(res.body.token).toBeTruthy()
    expect(res.body.user).toMatchObject({ id: 'friend-1', role: 'friend', ai: { usedToday: 3, dailyLimit: 5 } })
  })

  it('gives the same message for an unknown user and a wrong password', async () => {
    const unknown = await call(auth, 'POST', '/auth/login', { body: { username: 'niemand', password: PASSWORD } })
    const wrong = await call(auth, 'POST', '/auth/login', { body: { username: 'kees', password: 'fout-fout-fout' } })
    expect(unknown).toEqual(wrong)
    expect(wrong.status).toBe(401)
  })

  it('locks the account after 5 failed attempts', async () => {
    for (let i = 0; i < 4; i++) {
      expect((await call(auth, 'POST', '/auth/login', { body: { username: 'kees', password: 'nope-nope-nope' } })).status).toBe(401)
    }
    expect((await call(auth, 'POST', '/auth/login', { body: { username: 'kees', password: 'nope-nope-nope' } })).status).toBe(429)
    // Even the right password is refused while locked
    expect((await call(auth, 'POST', '/auth/login', { body: { username: 'kees', password: PASSWORD } })).status).toBe(429)
  })

  it('refuses a paused friend after a correct password', async () => {
    db.users.set(friend.id, { ...friend, status: 'paused' })
    const res = await call(auth, 'POST', '/auth/login', { body: { username: 'kees', password: PASSWORD } })
    expect(res.status).toBe(403)
    expect(res.body.message).toMatch(/gepauzeerd/)
  })

  it('accepts an invite link once, and lets a taken username be retried', async () => {
    const created = await call(friends, 'POST', '/friends', { body: { name: 'Anne' }, as: owner })
    const token = created.body.link.token as string

    const info = await call(auth, 'GET', '/auth/links/{token}', { params: { token } })
    expect(info.body).toMatchObject({ type: 'invite', name: 'Anne' })

    const taken = await call(auth, 'POST', '/auth/links/{token}/accept', {
      params: { token },
      body: { username: 'kees', password: PASSWORD },
    })
    expect(taken.status).toBe(409)

    const accepted = await call(auth, 'POST', '/auth/links/{token}/accept', {
      params: { token },
      body: { username: 'anne', password: PASSWORD },
    })
    expect(accepted.status).toBe(200)
    expect(accepted.body.user).toMatchObject({ name: 'Anne', username: 'anne', role: 'friend' })

    const again = await call(auth, 'GET', '/auth/links/{token}', { params: { token } })
    expect(again.status).toBe(410)
  })

  it('rejects an expired link', async () => {
    const created = await call(friends, 'POST', '/friends', { body: { name: 'Anne' }, as: owner })
    const stored = db.users.get(created.body.friend.id)!
    db.users.set(stored.id, { ...stored, linkExpiresAt: Date.now() - 1 })
    const res = await call(auth, 'GET', '/auth/links/{token}', { params: { token: created.body.link.token } })
    expect(res.status).toBe(410)
  })

  it('signs out old sessions after a reset link is used', async () => {
    const link = await call(friends, 'POST', '/friends/{id}/link', { params: { id: 'friend-1' }, as: owner })
    expect(link.body.link.type).toBe('reset')
    const res = await call(auth, 'POST', '/auth/links/{token}/accept', {
      params: { token: link.body.link.token },
      body: { password: 'nieuw-wachtwoord' },
    })
    expect(res.status).toBe(200)
    expect((await call(me, 'GET', '/me', { as: friend })).status).toBe(401)
  })
})

describe('me', () => {
  it('requires a session', async () => {
    expect((await call(me, 'GET', '/me')).status).toBe(401)
  })

  it('changes the password only with the current one', async () => {
    const wrong = await call(me, 'PUT', '/me/password', {
      as: friend,
      body: { currentPassword: 'niet-het-goede', newPassword: 'nieuw-wachtwoord' },
    })
    expect(wrong.status).toBe(400)
    const ok = await call(me, 'PUT', '/me/password', {
      as: friend,
      body: { currentPassword: PASSWORD, newPassword: 'nieuw-wachtwoord' },
    })
    expect(ok.status).toBe(200)
    expect(ok.body.token).toBeTruthy()
  })

  it('lists sessions with totals', async () => {
    const res = await call(me, 'GET', '/me/sessions', { as: friend })
    expect(res.body.totals).toEqual({ staked: 35, paidOut: 34.5, balance: -0.5 })
    expect(res.body.sessions[0].balance).toBe(14.5)
  })
})

describe('friends', () => {
  it('is owner-only', async () => {
    const res = await call(friends, 'GET', '/friends', { as: friend })
    expect(res.status).toBe(403)
  })

  it('lists friends with usage and pauses one', async () => {
    const list = await call(friends, 'GET', '/friends', { as: owner })
    expect(list.body.friends).toEqual([
      expect.objectContaining({ id: 'friend-1', status: 'active', usedToday: 3, dailyLimit: 5 }),
    ])
    const paused = await call(friends, 'PATCH', '/friends/{id}', {
      params: { id: 'friend-1' },
      body: { status: 'paused' },
      as: owner,
    })
    expect(paused.body.friend.status).toBe('paused')
    expect((await call(me, 'GET', '/me', { as: friend })).status).toBe(403)
  })

  it('cannot touch the owner through the friends routes', async () => {
    const res = await call(friends, 'DELETE', '/friends/{id}', { params: { id: 'owner-1' }, as: owner })
    expect(res.status).toBe(404)
  })
})

describe('ai connection', () => {
  it('never returns the full token', async () => {
    const res = await call(aiConnection, 'PUT', '/ai-connection', {
      as: owner,
      body: { token: fakeSetupToken('a-brand-new-token-wxyz') },
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'connected', tokenHint: '…wxyz' })
    expect(JSON.stringify(res.body)).not.toContain('brand-new')
    expect(db.claudeToken).toBe(fakeSetupToken('a-brand-new-token-wxyz'))
  })

  it('rejects something that is not a setup-token', async () => {
    const res = await call(aiConnection, 'PUT', '/ai-connection', { as: owner, body: { token: 'hallo' } })
    expect(res.status).toBe(400)
  })

  it('records a failed test', async () => {
    vi.mocked(testClaudeToken).mockResolvedValueOnce({ ok: false, message: 'Token verlopen' })
    const res = await call(aiConnection, 'POST', '/ai-connection/test', { as: owner })
    expect(res.body).toMatchObject({ status: 'error', lastError: 'Token verlopen' })
  })

  it('removes the connection', async () => {
    const res = await call(aiConnection, 'DELETE', '/ai-connection', { as: owner })
    expect(res.body.status).toBe('none')
    expect(db.claudeToken).toBeNull()
  })

  it('is owner-only', async () => {
    expect((await call(aiConnection, 'GET', '/ai-connection', { as: friend })).status).toBe(403)
  })
})
