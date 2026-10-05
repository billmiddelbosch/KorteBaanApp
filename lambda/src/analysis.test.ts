import type { APIGatewayProxyEvent, Context } from 'aws-lambda'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRecord, Draverij, InstructionRecord, LockedAdvice } from './lib/analysis'
import { signToken } from './lib/crypto'
import type { AiConfig, UserRecord } from './lib/store'

// In-memory stand-ins for DynamoDB, Secrets Manager, Claude and the worker invoke
const db = vi.hoisted(() => ({
  users: new Map<string, UserRecord>(),
  ai: undefined as AiConfig | undefined,
  usage: new Map<string, number>(),
  draverijen: new Map<string, Draverij>(),
  chats: new Map<string, ChatRecord>(),
  advice: new Map<string, LockedAdvice>(),
  instruction: undefined as InstructionRecord | undefined,
  facts: [] as unknown[],
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
  }
})

vi.mock('./lib/analysisStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/analysisStore')>()
  const clone = <T>(v: T): T => structuredClone(v)
  const key = (userId: string, id: string) => `${userId}/${id}`
  return {
    ChatChangedError: actual.ChatChangedError,
    listDraverijen: async (_a: string, from: string) =>
      [...db.draverijen.values()].filter((d) => d.date >= from).sort((a, b) => a.id.localeCompare(b.id)),
    getDraverij: async (_a: string, id: string) => clone(db.draverijen.get(id)),
    putDraverij: async (_a: string, d: Draverij) => void db.draverijen.set(d.id, clone(d)),
    getChat: async (_a: string, userId: string, id: string) => clone(db.chats.get(key(userId, id))),
    listChats: async (_a: string, userId: string) =>
      [...db.chats.values()].filter((c) => c.userId === userId).map(clone),
    putChat: async (_a: string, chat: ChatRecord, opts: { expectThinkingSince?: string } = {}) => {
      const k = key(chat.userId, chat.draverij.id)
      if (opts.expectThinkingSince && db.chats.get(k)?.thinkingSince !== opts.expectThinkingSince) {
        throw new actual.ChatChangedError()
      }
      db.chats.set(k, clone(chat))
    },
    getAdvice: async (_a: string, userId: string, id: string) => clone(db.advice.get(key(userId, id))),
    listAdvice: async (_a: string, userId: string) =>
      [...db.advice.entries()].filter(([k]) => k.startsWith(`${userId}/`)).map(([, v]) => clone(v)),
    putAdvice: async (_a: string, userId: string, advice: LockedAdvice) =>
      void db.advice.set(key(userId, advice.draverij.id), clone(advice)),
    getInstruction: async () => clone(db.instruction),
    putInstruction: async (_a: string, record: InstructionRecord) => void (db.instruction = clone(record)),
    saveKnowledge: async (_a: string, facts: unknown[]) => void db.facts.push(...facts),
  }
})

const { handler: analysis } = await import('./analysis')
const { handler: worker } = await import('./analysisWorker')
const { handler: aiInstruction } = await import('./aiInstruction')
const { askClaude, ClaudeError } = await import('./lib/claude')
const { dayOf } = await import('./lib/store')
const { TRUNCATED_NOTE } = await import('./lib/analysis')
const { DEFAULT_INSTRUCTION } = await import('./lib/analysis')

const context = {
  invokedFunctionArn: 'arn:aws:lambda:eu-west-2:123456789012:function:kortebaan-x:dev',
} as Context

function call(
  handler: typeof analysis,
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

const runWorker = async () => {
  const job = db.jobs.shift()
  if (!job) throw new Error('no worker job queued')
  await worker(job, context)
}

// A date a few days from now, so it's always upcoming
const upcoming = (days: number) =>
  new Date(Date.parse(`${dayOf()}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

const ADVICE_REPLY = `Mijn voorstel.\n<advies>${JSON.stringify({
  samenvatting: 'Rustig aan.',
  budget: 20,
  keuzes: [{ koers: '1e omloop', inzet: 'Winnaar: Fleur', bedrag: 10, onderbouwing: 'Goede vorm.' }],
})}</advies>\n<feiten>["Fleur won vorige week"]</feiten>`

let owner: UserRecord
let friend: UserRecord

beforeEach(() => {
  for (const map of [db.users, db.usage, db.draverijen, db.chats, db.advice]) map.clear()
  db.jobs.length = 0
  db.facts.length = 0
  db.instruction = undefined
  db.ai = { status: 'connected', tokenHint: '…abcd', connectedAt: '2026-09-01T10:00:00.000Z' }
  const base = { tokenVersion: 0, failedLogins: 0, createdAt: '2026-09-01T10:00:00.000Z', status: 'active' as const }
  owner = { ...base, id: 'owner-1', name: 'Bill', username: 'bill', role: 'owner', dailyLimit: null }
  friend = { ...base, id: 'friend-1', name: 'Jan', username: 'jan', role: 'friend', dailyLimit: 2 }
  db.users.set(owner.id, owner)
  db.users.set(friend.id, friend)
  vi.mocked(askClaude).mockReset()
})

describe('starting an analysis', () => {
  it('validates the place and date', async () => {
    const post = (body: unknown) => call(analysis, 'POST', '/analyses', { as: friend, body })
    expect((await post({ date: upcoming(3) })).body.message).toBe('Vul de plaats van de draverij in.')
    expect((await post({ place: 'Wolvega', date: '2020-01-01' })).body.message).toMatch(/al voorbij/)
    expect((await post({ place: 'Wolvega', date: '2026-02-30' })).body.message).toBe('Kies een geldige datum.')
    expect((await post({ place: 'Wolvega', date: upcoming(400) })).body.message).toBe('Kies een datum binnen een jaar.')
    expect((await post({ place: '!!!', date: upcoming(3) })).status).toBe(400)
    expect((await call(analysis, 'POST', '/analyses', { body: { place: 'Wolvega', date: upcoming(3) } })).status).toBe(401)
  })

  it('creates the chat, counts usage, runs the AI and continues the same chat on a second start', async () => {
    vi.mocked(askClaude).mockResolvedValue({ text: 'Wat is je budget?', sources: [{ url: 'https://a.nl', title: 'A' }], truncated: false })
    const date = upcoming(3)
    const created = await call(analysis, 'POST', '/analyses', { as: friend, body: { place: 'Wolvega', date } })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ id: `${date}-wolvega`, status: 'thinking', advice: null })
    expect(created.body.messages[0].text).toMatch(/^Ik wil een inzetadvies voor de kortebaan in Wolvega/)
    expect(db.usage.get(friend.id)).toBe(1)

    // The draverij is now in the shared list
    const list = await call(analysis, 'GET', '/draverijen', { as: owner })
    expect(list.body).toEqual([{ id: `${date}-wolvega`, place: 'Wolvega', date }])

    await runWorker()
    const chat = await call(analysis, 'GET', '/analyses/{id}', { as: friend, params: { id: created.body.id } })
    expect(chat.body.status).toBe('idle')
    expect(chat.body.messages[1]).toMatchObject({ role: 'assistant', text: 'Wat is je budget?', proposal: null })
    expect(chat.body.messages[1].sources).toEqual([{ url: 'https://a.nl', title: 'A' }])

    const again = await call(analysis, 'POST', '/analyses', { as: friend, body: { draverijId: created.body.id } })
    expect(again.status).toBe(200)
    expect(again.body.messages).toHaveLength(2)

    const summaries = await call(analysis, 'GET', '/analyses', { as: friend })
    expect(summaries.body).toEqual([expect.objectContaining({ id: created.body.id, hasAdvice: false, messageCount: 2 })])
    // Chats are private
    expect((await call(analysis, 'GET', '/analyses', { as: owner })).body).toEqual([])
  })

  it('refuses when the AI is not connected or the daily limit is reached', async () => {
    db.ai = undefined
    const post = () => call(analysis, 'POST', '/analyses', { as: friend, body: { place: 'Lisse', date: upcoming(2) } })
    expect((await post()).status).toBe(409)
    db.ai = { status: 'error', tokenHint: '…abcd', connectedAt: '' }
    expect((await post()).status).toBe(503)
    db.ai = { status: 'connected', tokenHint: '…abcd', connectedAt: '' }
    db.usage.set(friend.id, 2)
    const limited = await post()
    expect(limited.status).toBe(429)
    expect(limited.body.message).toBe('Je hebt je daglimiet van 2 analyses bereikt. Morgen kun je weer verder.')
    expect(db.chats.size).toBe(0)
    // The owner has no limit
    db.usage.set(owner.id, 50)
    expect((await call(analysis, 'POST', '/analyses', { as: owner, body: { place: 'Lisse', date: upcoming(2) } })).status).toBe(201)
  })
})

describe('chatting', () => {
  async function startChat(user = friend) {
    vi.mocked(askClaude).mockResolvedValueOnce({ text: 'Wat is je budget?', sources: [], truncated: false })
    const res = await call(analysis, 'POST', '/analyses', { as: user, body: { place: 'Wolvega', date: upcoming(3) } })
    await runWorker()
    return res.body.id as string
  }

  it('answers messages, counts a chat once per day and locks a proposal', async () => {
    const id = await startChat()
    const send = (text: string) =>
      call(analysis, 'POST', '/analyses/{id}/messages', { as: friend, params: { id }, body: { text } })

    expect((await send('')).body.message).toBe('Typ eerst een bericht.')
    expect((await send('x'.repeat(2001))).status).toBe(400)

    vi.mocked(askClaude).mockResolvedValueOnce({ text: ADVICE_REPLY, sources: [], truncated: false })
    const sent = await send('20 euro, weinig risico')
    expect(sent.status).toBe(202)
    expect(sent.body.status).toBe('thinking')
    // No double-send while the AI is busy
    expect((await send('nog iets')).status).toBe(409)
    await runWorker()
    expect(db.usage.get(friend.id)).toBe(1)
    // Facts go into the kennisbank via kb_record_claim, not from a <feiten> block
    expect(db.facts).toEqual([])

    const chat = (await call(analysis, 'GET', '/analyses/{id}', { as: friend, params: { id } })).body
    const reply = chat.messages[3]
    expect(reply.text).toBe('Mijn voorstel.')
    expect(reply.proposal.picks[0]).toEqual({ race: '1e omloop', bet: 'Winnaar: Fleur', amount: 10, reasoning: 'Goede vorm.' })

    expect(
      (await call(analysis, 'POST', '/analyses/{id}/advice', { as: friend, params: { id }, body: { messageId: chat.messages[1].id } }))
        .status,
    ).toBe(404)
    const locked = await call(analysis, 'POST', '/analyses/{id}/advice', {
      as: friend,
      params: { id },
      body: { messageId: reply.id },
    })
    expect(locked.body.advice).toMatchObject({ messageId: reply.id, proposal: { budget: 20 } })
    expect((await call(analysis, 'GET', '/analyses', { as: friend })).body[0].hasAdvice).toBe(true)

    // Restart clears the chat but keeps the advice
    vi.mocked(askClaude).mockResolvedValueOnce({ text: 'Opnieuw: wat is je budget?', sources: [], truncated: false })
    const restarted = await call(analysis, 'POST', '/analyses/{id}/restart', { as: friend, params: { id } })
    expect(restarted.body.messages).toHaveLength(1)
    expect(restarted.body.advice).not.toBeNull()
    await runWorker()
    expect(db.usage.get(friend.id)).toBe(1)
  })

  it('records AI errors and lets the user retry', async () => {
    const id = await startChat()
    vi.mocked(askClaude).mockRejectedValueOnce(new ClaudeError('auth', 'Claude accepteert het token niet meer.'))
    await call(analysis, 'POST', '/analyses/{id}/messages', { as: friend, params: { id }, body: { text: 'Hoi' } })
    await runWorker()

    const failed = (await call(analysis, 'GET', '/analyses/{id}', { as: friend, params: { id } })).body
    expect(failed).toMatchObject({ status: 'error', error: 'Claude accepteert het token niet meer.' })
    // The user's message is kept
    expect(failed.messages.at(-1).text).toBe('Hoi')
    expect(db.ai?.status).toBe('error')

    db.ai = { status: 'connected', tokenHint: '…abcd', connectedAt: '' }
    vi.mocked(askClaude).mockResolvedValueOnce({ text: 'Hallo!', sources: [], truncated: false })
    expect((await call(analysis, 'POST', '/analyses/{id}/retry', { as: friend, params: { id } })).status).toBe(202)
    await runWorker()
    const retried = (await call(analysis, 'GET', '/analyses/{id}', { as: friend, params: { id } })).body
    expect(retried.status).toBe('idle')
    expect(retried.messages.at(-1).text).toBe('Hallo!')
  })

  it('asks for room for long advice and marks a truncated reply', async () => {
    const id = await startChat()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(askClaude).mockResolvedValueOnce({ text: 'Lang advies.\n<advies>{"keuzes": [{"inzet":', sources: [], truncated: true })
    await call(analysis, 'POST', '/analyses/{id}/messages', { as: friend, params: { id }, body: { text: 'Advies?' } })
    await runWorker()
    expect(vi.mocked(askClaude).mock.lastCall?.[1].maxTokens).toBe(16_000)
    const reply = (await call(analysis, 'GET', '/analyses/{id}', { as: friend, params: { id } })).body.messages.at(-1)
    expect(reply.text).toBe(`Lang advies.\n\n${TRUNCATED_NOTE}`)
    expect(reply.proposal).toBeNull()
  })

  it('drops a worker reply when the chat was restarted meanwhile', async () => {
    const id = await startChat()
    vi.mocked(askClaude).mockResolvedValue({ text: 'Antwoord', sources: [], truncated: false })
    await call(analysis, 'POST', '/analyses/{id}/messages', { as: friend, params: { id }, body: { text: 'Vraag' } })
    await call(analysis, 'POST', '/analyses/{id}/restart', { as: friend, params: { id } })
    await runWorker() // the stale job: ignored
    expect(db.chats.get(`${friend.id}/${id}`)?.messages).toHaveLength(1)
    await runWorker()
    expect(db.chats.get(`${friend.id}/${id}`)?.messages).toHaveLength(2)
  })

  it('returns 404 for unknown or other users’ chats', async () => {
    const id = await startChat()
    expect((await call(analysis, 'GET', '/analyses/{id}', { as: owner, params: { id } })).status).toBe(404)
    expect((await call(analysis, 'GET', '/analyses/{id}', { as: friend, params: { id: '../x' } })).status).toBe(404)
  })
})

describe('AI-instructie', () => {
  it('is owner-only', async () => {
    expect((await call(aiInstruction, 'GET', '/ai-instruction', { as: friend })).status).toBe(403)
  })

  it('edits, reverts to the previous and the default version', async () => {
    const get = await call(aiInstruction, 'GET', '/ai-instruction', { as: owner })
    expect(get.body).toMatchObject({ text: DEFAULT_INSTRUCTION, isDefault: true, hasPrevious: false })

    expect((await call(aiInstruction, 'PUT', '/ai-instruction', { as: owner, body: { text: ' ' } })).status).toBe(400)
    const v1 = await call(aiInstruction, 'PUT', '/ai-instruction', { as: owner, body: { text: 'Versie 1' } })
    expect(v1.body).toMatchObject({ text: 'Versie 1', isDefault: false, hasPrevious: true })
    await call(aiInstruction, 'PUT', '/ai-instruction', { as: owner, body: { text: 'Versie 2' } })

    const back = await call(aiInstruction, 'POST', '/ai-instruction/revert', { as: owner, body: { to: 'previous' } })
    expect(back.body.text).toBe('Versie 1')
    const reset = await call(aiInstruction, 'POST', '/ai-instruction/revert', { as: owner, body: { to: 'default' } })
    expect(reset.body).toMatchObject({ text: DEFAULT_INSTRUCTION, isDefault: true })
    expect((await call(aiInstruction, 'POST', '/ai-instruction/revert', { as: owner, body: { to: 'x' } })).status).toBe(400)
  })
})
