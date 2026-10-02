import type { APIGatewayProxyEvent, Context } from 'aws-lambda'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Draverij, LockedAdvice } from './lib/analysis'
import { signToken } from './lib/crypto'
import type { BoardReading, KoersdagRecord } from './lib/koersdag'
import type { AiConfig, SessionRecord, UserRecord } from './lib/store'

// In-memory stand-ins for DynamoDB, S3, Secrets Manager, Claude and the worker invoke
const db = vi.hoisted(() => ({
  users: new Map<string, UserRecord>(),
  ai: undefined as AiConfig | undefined,
  usage: new Map<string, number>(),
  draverijen: new Map<string, Draverij>(),
  advice: new Map<string, LockedAdvice>(),
  koersdagen: new Map<string, KoersdagRecord>(),
  board: [] as { draverijId: string; reading: BoardReading }[],
  photos: new Map<string, { bytes: Uint8Array; contentType: string }>(),
  sessions: [] as { userId: string; session: SessionRecord }[],
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
    putUser: async (_a: string, user: UserRecord) => void db.users.set(user.id, clone(user)),
    usageOn: async () => new Map(db.usage),
    incrementUsage: async (_a: string, _day: string, userId: string) =>
      void db.usage.set(userId, (db.usage.get(userId) ?? 0) + 1),
    getAiConfig: async () => clone(db.ai),
    putAiConfig: async (_a: string, config: AiConfig) => void (db.ai = clone(config)),
    putSession: async (_a: string, userId: string, session: SessionRecord) => void db.sessions.push({ userId, session }),
  }
})

vi.mock('./lib/analysisStore', async () => {
  const clone = <T>(v: T): T => structuredClone(v)
  const key = (userId: string, id: string) => `${userId}/${id}`
  return {
    listDraverijen: async (_a: string, from: string) => [...db.draverijen.values()].filter((d) => d.date >= from),
    getDraverij: async (_a: string, id: string) => clone(db.draverijen.get(id)),
    putDraverij: async (_a: string, d: Draverij) => void db.draverijen.set(d.id, clone(d)),
    getAdvice: async (_a: string, userId: string, id: string) => clone(db.advice.get(key(userId, id))),
    listAdvice: async (_a: string, userId: string) =>
      [...db.advice.entries()].filter(([k]) => k.startsWith(`${userId}/`)).map(([, v]) => clone(v)),
    getInstruction: async () => undefined,
  }
})

vi.mock('./lib/koersdagStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/koersdagStore')>()
  const clone = <T>(v: T): T => structuredClone(v)
  const key = (userId: string, id: string) => `${userId}/${id}`
  return {
    KoersdagChangedError: actual.KoersdagChangedError,
    getKoersdag: async (_a: string, userId: string, id: string) => clone(db.koersdagen.get(key(userId, id))),
    putKoersdag: async (_a: string, record: KoersdagRecord, opts: { expectUpdatedAt?: string; create?: boolean } = {}) => {
      const k = key(record.userId, record.draverij.id)
      const current = db.koersdagen.get(k)
      if (opts.create && current) throw new actual.KoersdagChangedError()
      if (opts.expectUpdatedAt && current?.updatedAt !== opts.expectUpdatedAt) throw new actual.KoersdagChangedError()
      db.koersdagen.set(k, clone(record))
    },
    putBoardReading: async (_a: string, draverijId: string, reading: BoardReading) =>
      void db.board.push({ draverijId, reading: clone(reading) }),
    listBoardReadings: async (_a: string, draverijId: string, omloop: number) =>
      db.board
        .filter((b) => b.draverijId === draverijId && b.reading.omloop === omloop)
        .map((b) => clone(b.reading))
        .reverse(),
  }
})

vi.mock('./lib/zeturf', () => ({ zeturfOmlopen: async () => null }))

const { handler: koersdag } = await import('./koersdag')
const { handler: worker } = await import('./koersdagWorker')
const { askClaude } = await import('./lib/claude')
const { dayOf } = await import('./lib/store')

const context = {
  invokedFunctionArn: 'arn:aws:lambda:eu-west-2:123456789012:function:kortebaan-x:dev',
} as Context

function call(
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
  return koersdag(event, context).then((res) => ({ status: res.statusCode, body: JSON.parse(res.body) }))
}

const runWorker = async () => {
  const job = db.jobs.shift()
  if (!job) throw new Error('no worker job queued')
  await worker(job, context)
}

const reply = (body: unknown) => ({ text: `<koersdag>${JSON.stringify(body)}</koersdag>`, sources: [] })

const KEPT = reply({
  bevindingen: ['Geen afmeldingen'],
  oordeel: 'blijft staan',
  advies: { toelichting: 'Houd vast.', keuzes: [{ koers: '1e omloop', inzet: 'Winnaar: Fleur', bedrag: 20 }] },
})

// A tiny valid PNG header is enough for the byte sniffing
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')

let user: UserRecord
let friend: UserRecord
let today: string

beforeEach(() => {
  for (const map of [db.users, db.usage, db.draverijen, db.advice, db.koersdagen, db.photos]) map.clear()
  db.jobs.length = 0
  db.sessions.length = 0
  db.board.length = 0
  db.ai = { status: 'connected', tokenHint: '…abcd', connectedAt: '2026-09-01T10:00:00.000Z' }
  const base = { tokenVersion: 0, failedLogins: 0, createdAt: '2026-09-01T10:00:00.000Z', status: 'active' as const }
  user = { ...base, id: 'owner-1', name: 'Bill', username: 'bill', role: 'owner', dailyLimit: null }
  friend = { ...base, id: 'friend-1', name: 'Jan', username: 'jan', role: 'friend', dailyLimit: 1 }
  db.users.set(user.id, user)
  db.users.set(friend.id, friend)
  today = dayOf()
  vi.mocked(askClaude).mockReset()
})

async function start(as = user, body: Record<string, unknown> = { place: 'Wolvega', budget: 50 }) {
  const res = await call('POST', '/koersdagen', { as, body })
  return res
}

describe('starting a koersdag', () => {
  it('validates the budget and the draverij', async () => {
    expect((await start(user, { place: 'Wolvega' })).body.message).toBe('Vul een budget in van meer dan € 0.')
    expect((await start(user, { place: 'Wolvega', budget: 0 })).status).toBe(400)
    expect((await start(user, { place: 'Wolvega', budget: 20_000 })).status).toBe(400)
    expect((await start(user, { budget: 10 })).body.message).toBe('Kies de draverij van vandaag.')
    expect((await start(user, { place: '!!!', budget: 10 })).status).toBe(400)
    db.draverijen.set('2020-01-01-lisse', { id: '2020-01-01-lisse', place: 'Lisse', date: '2020-01-01' })
    expect((await start(user, { draverijId: '2020-01-01-lisse', budget: 10 })).status).toBe(404)
    expect((await call('POST', '/koersdagen', { body: { place: 'Wolvega', budget: 10 } })).status).toBe(401)
  })

  it('starts with the first AI update and continues the same koersdag on a second start', async () => {
    const created = await start()
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      id: `${today}-wolvega`,
      status: 'thinking',
      step: 'fetch',
      omloop: 1,
      remaining: 50,
    })
    expect(db.draverijen.has(`${today}-wolvega`)).toBe(true)

    vi.mocked(askClaude).mockResolvedValueOnce(KEPT)
    await runWorker()
    const loaded = await call('GET', '/koersdagen/{id}', { as: user, params: { id: created.body.id } })
    expect(loaded.body.status).toBe('idle')
    // No locked advice: the first update is the first advice
    expect(loaded.body.updates[0]).toMatchObject({ verdict: 'first', kind: 'fetch', adviceNote: 'Houd vast.' })

    const again = await start()
    expect(again.status).toBe(200)
    expect(again.body.updates).toHaveLength(1)

    const todays = await call('GET', '/koersdagen/today', { as: user })
    expect(todays.body.current.id).toBe(created.body.id)
    expect(todays.body.options).toEqual([{ draverij: expect.objectContaining({ place: 'Wolvega' }), advice: null }])
    // Koersdagen are private
    expect((await call('GET', '/koersdagen/{id}', { as: friend, params: { id: created.body.id } })).status).toBe(404)
  })

  it('compares with the locked advice', async () => {
    const draverij = { id: `${today}-alkmaar`, place: 'Alkmaar', date: today }
    db.draverijen.set(draverij.id, draverij)
    db.advice.set(`${user.id}/${draverij.id}`, {
      draverij,
      messageId: 'm-1',
      proposal: { summary: 'Rustig', budget: 50, picks: [] },
      lockedAt: '2026-09-20T10:00:00.000Z',
    })
    const created = await start(user, { draverijId: draverij.id, budget: 50 })
    expect(created.body.lockedAdvice).toMatchObject({ messageId: 'm-1' })
    vi.mocked(askClaude).mockResolvedValueOnce(KEPT)
    await runWorker()
    expect(db.koersdagen.get(`${user.id}/${draverij.id}`)?.updates[0].verdict).toBe('kept')
  })

  it('keeps the koersdag with the reason when the AI cannot start', async () => {
    db.usage.set(friend.id, 1)
    const created = await start(friend)
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ status: 'error', error: expect.stringMatching(/daglimiet/) })
    expect(db.jobs).toHaveLength(0)
  })
})

describe('during the koersdag', () => {
  async function started() {
    const res = await start()
    vi.mocked(askClaude).mockResolvedValueOnce(KEPT)
    await runWorker()
    return res.body.id as string
  }

  it('records bets and payouts and keeps the budget up to date', async () => {
    const id = await started()
    const suggestion = db.koersdagen.get(`${user.id}/${id}`)!.updates[0].advice[0]
    const bet = (body: unknown) => call('POST', '/koersdagen/{id}/bets', { as: user, params: { id }, body })

    expect((await bet({ bet: 'x', amount: 0 })).body.message).toBe('Vul een inzet in van meer dan € 0.')
    expect((await bet({ bet: '', amount: 5 })).body.message).toBe('Vul in waarop je hebt ingezet.')
    expect((await bet({ bet: 'x', amount: 5, suggestionId: 's-bestaat-niet' })).status).toBe(404)

    const placed = await bet({ bet: '1e omloop: Winnaar: Fleur', amount: 20, suggestionId: suggestion.id })
    expect(placed.status).toBe(201)
    expect(placed.body).toMatchObject({ staked: 20, remaining: 30 })
    // A second tap on the same suggestion doesn't bet twice
    expect((await bet({ bet: '1e omloop: Winnaar: Fleur', amount: 20, suggestionId: suggestion.id })).body.bets).toHaveLength(1)
    const other = await bet({ bet: 'Plaats: Jan', amount: 5 })
    expect(other.body.remaining).toBe(25)

    const [first, second] = other.body.bets
    const patch = (betId: string, body: unknown) =>
      call('PATCH', '/koersdagen/{id}/bets/{betId}', { as: user, params: { id, betId }, body })
    expect((await patch(first.id, {})).status).toBe(400)
    expect((await patch(first.id, { winnings: -1 })).status).toBe(400)
    expect((await patch(first.id, { winnings: 45 })).body).toMatchObject({ paidOut: 45, remaining: 70 })
    expect((await patch(second.id, { winnings: 0 })).body.remaining).toBe(70)
    expect((await patch('b-x', { winnings: 0 })).status).toBe(404)

    const removed = await call('DELETE', '/koersdagen/{id}/bets/{betId}', { as: user, params: { id, betId: second.id } })
    expect(removed.body).toMatchObject({ staked: 20, remaining: 75 })
  })

  it('checks a photo of the board', async () => {
    const id = await started()
    const photo = (body: unknown) => call('POST', '/koersdagen/{id}/photo', { as: user, params: { id }, body })
    expect((await photo({ mediaType: 'image/gif', image: PNG })).status).toBe(400)
    expect((await photo({ mediaType: 'image/png' })).body.message).toBe('Maak eerst een foto.')
    expect((await photo({ mediaType: 'image/png', image: Buffer.from('<svg/>').toString('base64') })).body.message).toBe(
      'Dit bestand is geen foto. Probeer het opnieuw.',
    )

    // The declared type is ignored in favour of the actual bytes
    const sent = await photo({ mediaType: 'image/jpeg', image: PNG })
    expect(sent.status).toBe(202)
    expect(sent.body).toMatchObject({ status: 'thinking', step: 'photo' })
    expect([...db.photos.values()][0].contentType).toBe('image/png')
    // No second run while the AI is busy
    expect((await call('POST', '/koersdagen/{id}/next', { as: user, params: { id } })).status).toBe(409)

    vi.mocked(askClaude).mockResolvedValueOnce(
      reply({
        oordeel: 'aangepast',
        wijzigingen: ['Fleur heeft een hogere quota'],
        foto: { klopt: false, verschillen: ['Quota Fleur 3,2 → 4,1'] },
        bord: { quota: ['3 Fleur: winnend 4,1'], loting: [] },
        advies: { toelichting: 'Minder inzetten', keuzes: [{ inzet: 'Winnaar: Fleur', bedrag: 10, nieuw: true }] },
      }),
    )
    await runWorker()
    const sentTurn = vi.mocked(askClaude).mock.calls[1][1].turns[0]
    expect(sentTurn.images).toEqual([{ mediaType: 'image/png', data: PNG }])
    // The photo is removed once checked
    expect(db.photos.size).toBe(0)

    const loaded = (await call('GET', '/koersdagen/{id}', { as: user, params: { id } })).body
    expect(loaded.updates[1]).toMatchObject({
      kind: 'photo',
      verdict: 'changed',
      photoCheck: { matches: false, differences: ['Quota Fleur 3,2 → 4,1'] },
    })

    // What was read from the board reaches the next visitor's advice for the same omloop
    expect(db.board).toEqual([
      { draverijId: id, reading: expect.objectContaining({ omloop: 1, userId: user.id, quota: ['3 Fleur: winnend 4,1'] }) },
    ])
    await start(friend)
    vi.mocked(askClaude).mockResolvedValueOnce(KEPT)
    await runWorker()
    const friendSystem = vi.mocked(askClaude).mock.calls[2][1].system
    expect(friendSystem).toContain('(foto van een andere bezoeker)')
    expect(friendSystem).toContain('- 3 Fleur: winnend 4,1')
  })

  it('checks several photos of the board in one run', async () => {
    const id = await started()
    const photo = (body: unknown) => call('POST', '/koersdagen/{id}/photo', { as: user, params: { id }, body })
    const png = { mediaType: 'image/png', image: PNG }
    const jpeg = { mediaType: 'image/jpeg', image: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64') }
    expect((await photo({ images: [] })).body.message).toBe('Maak eerst een foto.')
    expect((await photo({ images: [png, png, png, png] })).body.message).toBe("Stuur maximaal 3 foto's tegelijk.")
    expect((await photo({ images: [png, { mediaType: 'image/png' }] })).body.message).toBe('Maak eerst een foto.')
    const big = { mediaType: 'image/png', image: PNG + 'A'.repeat(2_000_000) }
    expect((await photo({ images: [big, big, big] })).status).toBe(413)
    // A refused request leaves nothing behind
    expect(db.photos.size).toBe(0)

    const sent = await photo({ images: [png, jpeg] })
    expect(sent.status).toBe(202)
    expect([...db.photos.values()].map((p) => p.contentType)).toEqual(['image/png', 'image/jpeg'])

    vi.mocked(askClaude).mockResolvedValueOnce(
      reply({ foto: { klopt: true }, bord: { quota: ['3 Fleur: winnend 4,1'], loting: ['Koppel 1: Fleur – Hessel'] }, advies: { keuzes: [] } }),
    )
    await runWorker()
    const ask = vi.mocked(askClaude).mock.calls[1][1]
    expect(ask.turns[0].images).toEqual([
      { mediaType: 'image/png', data: PNG },
      { mediaType: 'image/jpeg', data: jpeg.image },
    ])
    expect(ask.turns[0].text).toContain("Bijgevoegd zijn 2 foto's")
    // Both photos are removed once checked, and the board is read as one
    expect(db.photos.size).toBe(0)
    expect(db.board).toHaveLength(1)
    expect(db.koersdagen.get(`${user.id}/${id}`)).toMatchObject({ status: 'idle', photos: undefined })
  })

  it('still checks the single photo of a run started by the older API', async () => {
    const id = await started()
    expect((await call('POST', '/koersdagen/{id}/photo', { as: user, params: { id }, body: { mediaType: 'image/png', image: PNG } })).status).toBe(202)
    // Rewrite the run as the older API stored it
    const record = db.koersdagen.get(`${user.id}/${id}`)!
    const [{ key, mediaType }] = record.photos!
    db.koersdagen.set(`${user.id}/${id}`, { ...record, photos: undefined, photoKey: key, photoMediaType: mediaType })

    vi.mocked(askClaude).mockResolvedValueOnce(reply({ foto: { klopt: true }, advies: { keuzes: [] } }))
    await runWorker()
    const ask = vi.mocked(askClaude).mock.calls[1][1]
    expect(ask.turns[0].images).toEqual([{ mediaType: 'image/png', data: PNG }])
    expect(ask.turns[0].text).toContain('Bijgevoegd is een foto')
    expect(db.photos.size).toBe(0)
  })

  it('moves to the next omloop and records an unreadable reply as an error', async () => {
    const id = await started()
    const next = await call('POST', '/koersdagen/{id}/next', { as: user, params: { id } })
    expect(next.body).toMatchObject({ omloop: 2, status: 'thinking' })
    vi.mocked(askClaude).mockResolvedValueOnce({ text: 'Geen idee', sources: [] })
    await runWorker()
    const failed = (await call('GET', '/koersdagen/{id}', { as: user, params: { id } })).body
    expect(failed).toMatchObject({ status: 'error', error: 'De AI gaf een onleesbaar antwoord. Probeer het opnieuw.' })

    vi.mocked(askClaude).mockResolvedValueOnce(KEPT)
    expect((await call('POST', '/koersdagen/{id}/refresh', { as: user, params: { id } })).status).toBe(202)
    await runWorker()
    expect((await call('GET', '/koersdagen/{id}', { as: user, params: { id } })).body).toMatchObject({
      status: 'idle',
      omloop: 2,
    })
  })

  it('finishes into Terugblik and then locks the koersdag', async () => {
    const id = await started()
    await call('POST', '/koersdagen/{id}/bets', { as: user, params: { id }, body: { bet: 'Winnaar: Fleur', amount: 20 } })
    const withBet = db.koersdagen.get(`${user.id}/${id}`)!
    await call('PATCH', '/koersdagen/{id}/bets/{betId}', {
      as: user,
      params: { id, betId: withBet.bets[0].id },
      body: { winnings: 45 },
    })
    // Finishing while the AI works drops its result
    await call('POST', '/koersdagen/{id}/next', { as: user, params: { id } })

    const finished = await call('POST', '/koersdagen/{id}/finish', { as: user, params: { id } })
    expect(finished.body).toMatchObject({ status: 'idle', finishedAt: expect.any(String) })
    expect(db.sessions).toEqual([
      { userId: user.id, session: { id, date: today, draverij: 'Wolvega', staked: 20, paidOut: 45 } },
    ])

    vi.mocked(askClaude).mockResolvedValueOnce(KEPT)
    await runWorker()
    expect(db.koersdagen.get(`${user.id}/${id}`)?.updates).toHaveLength(1)

    const bet = await call('POST', '/koersdagen/{id}/bets', { as: user, params: { id }, body: { bet: 'x', amount: 5 } })
    expect(bet).toMatchObject({ status: 409, body: { message: 'Deze koersdag is al afgerond.' } })
    expect((await call('POST', '/koersdagen/{id}/finish', { as: user, params: { id } })).status).toBe(409)
    expect((await call('GET', '/koersdagen/today', { as: user })).body.current.finishedAt).not.toBeNull()
  })
})
