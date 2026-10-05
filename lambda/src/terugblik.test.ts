import type { APIGatewayProxyEvent, Context } from 'aws-lambda'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { signToken } from './lib/crypto'
import type { KoersdagRecord } from './lib/koersdag'
import type { AiConfig, SessionRecord, UserRecord } from './lib/store'

// In-memory stand-ins for DynamoDB, S3, Secrets Manager, Claude and the worker invoke
const db = vi.hoisted(() => ({
  users: new Map<string, UserRecord>(),
  ai: undefined as AiConfig | undefined,
  usage: new Map<string, number>(),
  koersdagen: new Map<string, KoersdagRecord>(),
  photos: new Map<string, { bytes: Uint8Array; contentType: string }>(),
  sessions: new Map<string, SessionRecord & { userId: string }>(),
  lessons: [] as { id: string; tekst: string; baan?: string; draverijId: string; createdAt: string }[],
  jobs: [] as { userId: string; draverijId: string; thinkingSince: string }[],
}))

vi.mock('./lib/secrets', () => ({
  jwtSecret: async () => 'test-secret',
  readClaudeToken: async () => 'fake-token',
}))

vi.mock('./lib/worker', () => ({
  startWorker: async (_a: string, job: (typeof db.jobs)[number]) => void db.jobs.push(job),
}))

vi.mock('./lib/claude', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/claude')>()),
  askClaude: vi.fn<typeof import('./lib/claude').askClaude>(),
}))

vi.mock('./lib/photos', () => ({
  putPhoto: async (_a: string, key: string, bytes: Uint8Array, contentType: string) =>
    void db.photos.set(key, { bytes, contentType }),
  readPhoto: async (_a: string, key: string) => Buffer.from(db.photos.get(key)!.bytes).toString('base64'),
  deletePhoto: async (_a: string, key: string) => void db.photos.delete(key),
}))

vi.mock('./lib/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/store')>()
  const clone = <T>(v: T): T => structuredClone(v)
  return {
    dayOf: actual.dayOf,
    getUser: async (_a: string, id: string) => clone(db.users.get(id)),
    putUser: async (_a: string, u: UserRecord) => void db.users.set(u.id, clone(u)),
    listUsers: async () => [...db.users.values()].map(clone),
    usageOn: async () => new Map(db.usage),
    incrementUsage: async (_a: string, _day: string, userId: string) =>
      void db.usage.set(userId, (db.usage.get(userId) ?? 0) + 1),
    getAiConfig: async () => clone(db.ai),
    putAiConfig: async (_a: string, config: AiConfig) => void (db.ai = clone(config)),
    listSessions: async (_a: string, userId: string) =>
      [...db.sessions.values()]
        .filter((s) => s.userId === userId)
        .sort((a, b) => b.date.localeCompare(a.date))
        .map(({ userId: _u, ...s }) => clone(s)),
    putSession: async (_a: string, userId: string, session: SessionRecord) =>
      void db.sessions.set(`${userId}/${session.id}`, { ...clone(session), userId }),
  }
})

vi.mock('./lib/analysisStore', async () => ({
  getAdvice: async () => undefined,
  getInstruction: async () => undefined,
}))

vi.mock('./lib/kb/service', async () => ({
  kbConfigured: () => true,
  evaluationContext: async () => ({ scorecard: null, lessonsToCheck: [] }),
  checkLessons: async () => undefined,
  saveLessons: async (_a: string, lessons: { tekst: string; baan?: string }[], draverijId: string) =>
    void db.lessons.push(
      ...lessons.map((l, i) => ({ ...l, id: `l-${db.lessons.length + i}`, draverijId, createdAt: '2026-08-15T19:00:00.000Z' })),
    ),
  listLessons: async () => [...db.lessons],
  removeLesson: async (_a: string, id: string) => {
    const index = db.lessons.findIndex((l) => l.id === id)
    if (index < 0) return false
    db.lessons.splice(index, 1)
    return true
  },
  promoteLesson: async (id: string) => {
    const index = db.lessons.findIndex((l) => l.id === id)
    if (index < 0) return false
    db.lessons.splice(index, 1)
    return true
  },
}))

vi.mock('./lib/koersdagStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/koersdagStore')>()
  const clone = <T>(v: T): T => structuredClone(v)
  const key = (userId: string, id: string) => `${userId}/${id}`
  return {
    KoersdagChangedError: actual.KoersdagChangedError,
    getKoersdag: async (_a: string, userId: string, id: string) => clone(db.koersdagen.get(key(userId, id))),
    putKoersdag: async (_a: string, record: KoersdagRecord, opts: { expectUpdatedAt?: string } = {}) => {
      const k = key(record.userId, record.draverij.id)
      if (opts.expectUpdatedAt && db.koersdagen.get(k)?.updatedAt !== opts.expectUpdatedAt) {
        throw new actual.KoersdagChangedError()
      }
      db.koersdagen.set(k, clone(record))
    },
  }
})

const { handler: terugblik } = await import('./terugblik')
const { handler: worker } = await import('./terugblikWorker')
const { askClaude } = await import('./lib/claude')

const context = {
  invokedFunctionArn: 'arn:aws:lambda:eu-west-2:123456789012:function:kortebaan-x:dev',
} as Context
const prodContext = { invokedFunctionArn: 'arn:aws:lambda:eu-west-2:123456789012:function:kortebaan-x:prod' } as Context

function call(
  method: string,
  resource: string,
  opts: { body?: unknown; params?: Record<string, string>; as?: UserRecord; prod?: boolean } = {},
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
  return terugblik(event, opts.prod ? prodContext : context).then((res) => ({ status: res.statusCode, body: JSON.parse(res.body) }))
}

const runWorker = async () => {
  const job = db.jobs.shift()
  if (!job) throw new Error('no worker job queued')
  await worker(job, context)
}

const ID = '2026-08-15-wolvega'
const params = { id: ID }

const RESULTS = {
  text: `<uitslagen>${JSON.stringify({ gevonden: true, omlopen: [{ omloop: 2, winnaar: 'Hessel B', plaatsen: '' }, { omloop: 1, winnaar: 'Fleur', plaatsen: '2e: Jan' }] })}</uitslagen>`,
  sources: [{ url: 'https://example.nl/uitslag', title: 'Uitslag' }],
  truncated: false,
}
const EVALUATION = {
  text: `<evaluatie>${JSON.stringify({
    oordeel: 'Wisselende dag.',
    omlopen: [
      { omloop: 1, klopte: true, advies: 'Winnaar: Fleur', winnaar: 'Fleur', waarom: 'Sterk gestart.' },
      { omloop: 2, klopte: false, advies: 'Winnaar: Jan', winnaar: 'Hessel B', waarom: 'Jan galoppeerde.' },
    ],
    lessen: ['Op zware baan wint Hessel B vaker.'],
  })}</evaluatie>`,
  sources: [],
  truncated: false,
}

let user: UserRecord
let friend: UserRecord

function seedKoersdag(owner: UserRecord, finished = true) {
  const record: KoersdagRecord = {
    draverij: { id: ID, place: 'Wolvega', date: '2026-08-15' },
    userId: owner.id,
    budget: 50,
    status: 'idle',
    omloop: 2,
    updates: [],
    bets: [
      { id: 'b-1', omloop: 1, suggestionId: null, bet: 'Winnaar: Fleur', amount: 10, winnings: 25, createdAt: '' },
      { id: 'b-2', omloop: 2, suggestionId: null, bet: 'Winnaar: Jan', amount: 10, winnings: null, createdAt: '' },
    ],
    finishedAt: finished ? '2026-08-15T18:00:00.000Z' : undefined,
    createdAt: '2026-08-15T10:00:00.000Z',
    updatedAt: '2026-08-15T18:00:00.000Z',
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
  }
  db.koersdagen.set(`${owner.id}/${ID}`, record)
  db.sessions.set(`${owner.id}/${ID}`, { userId: owner.id, id: ID, date: '2026-08-15', draverij: 'Wolvega', staked: 20, paidOut: 25 })
}

beforeEach(() => {
  for (const map of [db.users, db.usage, db.koersdagen, db.photos, db.sessions]) map.clear()
  db.jobs.length = 0
  db.lessons.length = 0
  db.ai = { status: 'connected', tokenHint: '…abcd', connectedAt: '2026-09-01T10:00:00.000Z' }
  const base = { tokenVersion: 0, failedLogins: 0, createdAt: '2026-09-01T10:00:00.000Z', status: 'active' as const }
  user = { ...base, id: 'owner-1', name: 'Bill', username: 'bill', role: 'owner', dailyLimit: null }
  friend = { ...base, id: 'friend-1', name: 'Jan', username: 'jan', role: 'friend', dailyLimit: 1 }
  db.users.set(user.id, user)
  db.users.set(friend.id, friend)
  vi.mocked(askClaude).mockReset()
})

describe('terugblik list and detail', () => {
  it('lists own finished koersdagen with totals', async () => {
    seedKoersdag(user)
    const res = await call('GET', '/terugblik', { as: user })
    expect(res.body).toEqual({
      koersdagen: [{ id: ID, date: '2026-08-15', draverij: 'Wolvega', staked: 20, paidOut: 25, balance: 5, evaluated: false }],
      totals: { staked: 20, paidOut: 25, balance: 5 },
    })
    expect((await call('GET', '/terugblik', { as: friend })).body.koersdagen).toEqual([])
    expect((await call('GET', '/terugblik')).status).toBe(401)
  })

  it('shows the detail only to its player and only once finished', async () => {
    seedKoersdag(user)
    const res = await call('GET', '/terugblik/{id}', { as: user, params })
    expect(res.body).toMatchObject({ id: ID, balance: 5, status: 'idle', results: null, evaluation: null })
    expect((await call('GET', '/terugblik/{id}', { as: friend, params })).status).toBe(404)
    seedKoersdag(user, false)
    expect((await call('GET', '/terugblik/{id}', { as: user, params })).body.message).toBe('Rond eerst de koersdag af.')
  })
})

describe('uitslagen and evaluation', () => {
  it('fetches uitslagen, confirms them, evaluates and stores lessons', async () => {
    seedKoersdag(user)
    const started = await call('POST', '/terugblik/{id}/results/fetch', { as: user, params })
    expect(started).toMatchObject({ status: 202, body: { status: 'thinking', step: 'results' } })

    vi.mocked(askClaude).mockResolvedValueOnce(RESULTS)
    await runWorker()
    const fetched = await call('GET', '/terugblik/{id}', { as: user, params })
    expect(fetched.body).toMatchObject({ status: 'idle', resultsConfirmedAt: null })
    expect(fetched.body.results).toEqual([
      { omloop: 1, winner: 'Fleur', places: '2e: Jan' },
      { omloop: 2, winner: 'Hessel B', places: '' },
    ])

    const invalid = await call('PUT', '/terugblik/{id}/results', {
      as: user,
      params,
      body: { results: [{ omloop: 1, winner: ' ' }] },
    })
    expect(invalid.body.message).toBe('Vul de winnaar van de 1e omloop in.')

    const confirmed = await call('PUT', '/terugblik/{id}/results', {
      as: user,
      params,
      body: { results: [...fetched.body.results].reverse() },
    })
    expect(confirmed).toMatchObject({ status: 202, body: { status: 'thinking', step: 'evaluate' } })
    expect(confirmed.body.resultsConfirmedAt).toEqual(expect.any(String))

    vi.mocked(askClaude).mockResolvedValueOnce(EVALUATION)
    await runWorker()
    const evaluated = await call('GET', '/terugblik/{id}', { as: user, params })
    expect(evaluated.body.evaluation).toMatchObject({
      summary: 'Wisselende dag.',
      omlopen: [
        { omloop: 1, correct: true, winner: 'Fleur' },
        { omloop: 2, correct: false, reason: 'Jan galoppeerde.' },
      ],
    })
    // Lessons are for the kennisbank, not in the player's view
    expect(JSON.stringify(evaluated.body)).not.toContain('zware baan')
    expect(db.lessons).toEqual([
      expect.objectContaining({ tekst: 'Op zware baan wint Hessel B vaker.', draverijId: ID, baan: 'Wolvega' }),
    ])
    expect((await call('GET', '/terugblik', { as: user })).body.koersdagen[0].evaluated).toBe(true)
    // Fetching the uitslagen and evaluating counted once for today
    expect(db.usage.get(user.id)).toBe(1)
  })

  it('reports uitslagen that were not found', async () => {
    seedKoersdag(user)
    await call('POST', '/terugblik/{id}/results/fetch', { as: user, params })
    vi.mocked(askClaude).mockResolvedValueOnce({ text: '<uitslagen>{"gevonden": false, "omlopen": []}</uitslagen>', sources: [], truncated: false })
    await runWorker()
    const res = await call('GET', '/terugblik/{id}', { as: user, params })
    expect(res.body).toMatchObject({ status: 'error', error: expect.stringContaining('Vul ze zelf in') })
  })

  it('reads a photo of the uitslagbord and deletes it afterwards', async () => {
    seedKoersdag(user)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
    expect(
      (await call('POST', '/terugblik/{id}/results/photo', { as: user, params, body: { mediaType: 'image/gif', image: png } })).status,
    ).toBe(400)
    const res = await call('POST', '/terugblik/{id}/results/photo', { as: user, params, body: { mediaType: 'image/png', image: png } })
    expect(res.body).toMatchObject({ status: 'thinking', step: 'photo' })
    expect(db.photos.size).toBe(1)

    vi.mocked(askClaude).mockResolvedValueOnce(RESULTS)
    await runWorker()
    expect(vi.mocked(askClaude).mock.calls[0]![1].turns[0]!.images).toHaveLength(1)
    expect(db.photos.size).toBe(0)
  })

  it('keeps manual uitslagen confirmed when the daily limit is reached', async () => {
    seedKoersdag(friend)
    db.usage.set(friend.id, 1)
    expect((await call('POST', '/terugblik/{id}/results/fetch', { as: friend, params })).status).toBe(429)

    const res = await call('PUT', '/terugblik/{id}/results', {
      as: friend,
      params,
      body: { results: [{ omloop: 1, winner: 'Fleur', places: '' }] },
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'error', step: 'evaluate', resultsConfirmedAt: expect.any(String) })
    expect(res.body.error).toContain('daglimiet')

    db.usage.clear()
    const retry = await call('POST', '/terugblik/{id}/evaluate', { as: friend, params })
    expect(retry.body).toMatchObject({ status: 'thinking', step: 'evaluate' })
  })

  it('refuses to evaluate before the uitslagen are confirmed', async () => {
    seedKoersdag(user)
    const res = await call('POST', '/terugblik/{id}/evaluate', { as: user, params })
    expect(res).toMatchObject({ status: 409, body: { message: 'Bevestig eerst de uitslagen.' } })
    expect(db.usage.size).toBe(0)
  })
})

describe('bets after the koersdag', () => {
  it('fills in an open payout and updates the speelsessie', async () => {
    seedKoersdag(user)
    const res = await call('PATCH', '/terugblik/{id}/bets/{betId}', {
      as: user,
      params: { ...params, betId: 'b-2' },
      body: { winnings: 0, amount: 12 },
    })
    expect(res.body).toMatchObject({ staked: 22, paidOut: 25, balance: 3 })
    expect(db.sessions.get(`${user.id}/${ID}`)).toMatchObject({ staked: 22, paidOut: 25 })
    const missing = await call('PATCH', '/terugblik/{id}/bets/{betId}', {
      as: user,
      params: { ...params, betId: 'b-9' },
      body: { winnings: 0 },
    })
    expect(missing.status).toBe(404)
  })
})

describe('owner', () => {
  it('sees totals per user and all koersdagen', async () => {
    seedKoersdag(user)
    seedKoersdag(friend)
    const res = await call('GET', '/terugblik/overview', { as: user })
    expect(res.body.users).toEqual([
      expect.objectContaining({ id: 'owner-1', name: 'Bill', koersdagen: 1, balance: 5 }),
      expect.objectContaining({ id: 'friend-1', name: 'Jan', koersdagen: 1, balance: 5 }),
    ])
    expect(res.body.koersdagen.map((k: { userName: string }) => k.userName)).toEqual(['Bill', 'Jan'])
    expect((await call('GET', '/terugblik/overview', { as: friend })).status).toBe(403)
  })

  it('lists and deletes lessons', async () => {
    db.lessons.push({ id: 'l-1', tekst: 'Les', createdAt: '2026-08-15T19:00:00.000Z', draverijId: ID, baan: 'Wolvega' })
    expect((await call('GET', '/lessons', { as: friend })).status).toBe(403)
    expect((await call('GET', '/lessons', { as: user })).body.lessons).toHaveLength(1)
    expect((await call('DELETE', '/lessons/{id}', { as: friend, params: { id: 'l-1' } })).status).toBe(403)
    expect((await call('DELETE', '/lessons/{id}', { as: user, params: { id: 'l-1' } })).status).toBe(200)
    expect(db.lessons).toEqual([])
    expect((await call('DELETE', '/lessons/{id}', { as: user, params: { id: 'l-1' } })).status).toBe(404)
  })

  it('moves a test lesson to production, only from test', async () => {
    db.lessons.push({ id: 'l-1', tekst: 'Les', createdAt: '2026-08-15T19:00:00.000Z', draverijId: ID, baan: 'Wolvega' })
    expect((await call('GET', '/lessons', { as: user })).body.canPromote).toBe(true)
    expect((await call('GET', '/lessons', { as: user, prod: true })).body.canPromote).toBe(false)
    expect((await call('POST', '/lessons/{id}/promote', { as: friend, params: { id: 'l-1' } })).status).toBe(403)
    const fromProd = await call('POST', '/lessons/{id}/promote', { as: user, params: { id: 'l-1' }, prod: true })
    expect(fromProd).toEqual({ status: 409, body: { message: 'Alleen lessen uit de testomgeving kunnen naar productie.' } })
    expect((await call('POST', '/lessons/{id}/promote', { as: user, params: { id: 'l-1' } })).status).toBe(200)
    expect(db.lessons).toEqual([])
    expect((await call('POST', '/lessons/{id}/promote', { as: user, params: { id: 'l-1' } })).status).toBe(404)
  })
})
