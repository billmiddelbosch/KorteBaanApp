import { http, HttpResponse, delay } from 'msw'
import type { AiConnection, Friend, IssuedLink, LinkType, Me } from '@/types/account'
import type { AiInstruction, Chat, ChatMessage, ChatSummary, Draverij, Source } from '@/types/analyse'
import {
  analyseDb,
  db,
  issueToken,
  MOCK_DEFAULT_INSTRUCTION,
  newLinkToken,
  userForLink,
  userForToken,
  type MockChat,
  type MockUser,
} from './data'

// Mirrors the Lambda handlers in lambda/src (auth, me, friends, aiConnection, analysis,
// aiInstruction):
// same routes, response shapes and Dutch messages.

const BASE = '/api'
const LAG = 300 // simulated network delay in ms

const DAY = 24 * 60 * 60 * 1000
const LINK_TTL: Record<LinkType, number> = { invite: 7 * DAY, reset: DAY }
const DEFAULT_DAILY_LIMIT = 10

const LINK_GONE = 'Deze link werkt niet meer. Vraag de eigenaar om een nieuwe link.'
const PAUSED = 'Je toegang is gepauzeerd. Vraag de eigenaar om je weer toegang te geven.'

const fail = (status: number, message: string) => HttpResponse.json({ message }, { status })

type Guard = { user: MockUser; error?: never } | { user?: never; error: Response }

// Resolve the logged-in user from the Authorization header
function resolveUser(request: Request): MockUser | null {
  const token = (request.headers.get('Authorization') ?? '').replace('Bearer ', '')
  return userForToken(token) ?? null
}

function authenticate(request: Request): Guard {
  const user = resolveUser(request)
  if (!user || user.status === 'invited') return { error: fail(401, 'Niet ingelogd') }
  if (user.status === 'paused') return { error: fail(403, PAUSED) }
  user.lastActiveAt = new Date().toISOString()
  return { user }
}

function requireOwner(request: Request): Guard {
  const guard = authenticate(request)
  if (guard.user && guard.user.role !== 'owner') {
    return { error: fail(403, 'Alleen de eigenaar kan dit beheren.') }
  }
  return guard
}

function toMe(user: MockUser): Me {
  return {
    id: user.id,
    name: user.name,
    username: user.username ?? '',
    role: user.role,
    ai: {
      status: db.ai.status,
      usedToday: db.usageToday[user.id] ?? 0,
      dailyLimit: user.role === 'owner' ? null : user.dailyLimit,
    },
  }
}

function toFriend(user: MockUser): Friend {
  const expired = !user.link || user.link.expiresAt <= Date.now()
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    status: user.status === 'invited' ? (expired ? 'expired' : 'invited') : user.status,
    lastActiveAt: user.lastActiveAt,
    usedToday: db.usageToday[user.id] ?? 0,
    dailyLimit: user.dailyLimit,
    linkExpiresAt:
      user.link?.type === 'invite' ? new Date(user.link.expiresAt).toISOString() : null,
  }
}

function issueLink(user: MockUser, type: LinkType): IssuedLink {
  user.link = { token: newLinkToken(), type, expiresAt: Date.now() + LINK_TTL[type] }
  return { token: user.link.token, type, expiresAt: new Date(user.link.expiresAt).toISOString() }
}

function aiOverview(): AiConnection {
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(Date.now() - (6 - i) * DAY).toISOString().slice(0, 10)
    const count =
      i === 6
        ? Object.values(db.usageToday).reduce((sum, n) => sum + n, 0)
        : (db.usagePastDays[i] ?? 0)
    return { date, count }
  })
  return {
    ...db.ai,
    usage: {
      today: db.users
        .filter((u) => u.status !== 'invited')
        .map((u) => ({
          userId: u.id,
          name: u.name,
          count: db.usageToday[u.id] ?? 0,
          dailyLimit: u.role === 'owner' ? null : u.dailyLimit,
        }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'nl')),
      days,
    },
  }
}

const SETUP_TOKEN = /^sk-ant-[A-Za-z0-9_-]{20,}$/

// In the mock, any well-formed token works unless it contains "ongeldig"
function testToken(token: string) {
  const ok = !token.includes('ongeldig')
  db.ai = {
    ...db.ai,
    status: ok ? 'connected' : 'error',
    lastTestedAt: new Date().toISOString(),
    lastError: ok
      ? null
      : 'Claude weigert dit token (401). Maak een nieuw token met `claude setup-token` en plak dat hier.',
  }
}

let storedToken: string | null = 'stored'

const validName = (name: unknown) => (typeof name === 'string' ? name.trim() : '')

function checkName(name: unknown): string | Response {
  const value = validName(name)
  if (!value) return fail(400, 'Vul een naam in.')
  if (value.length > 40) return fail(400, 'Houd de naam korter dan 40 tekens.')
  return value
}

function checkLimit(limit: unknown): number | null | Response {
  if (limit === null) return null
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > 1000) {
    return fail(400, 'Kies een daglimiet tussen 0 en 1000, of geen limiet.')
  }
  return limit
}

function checkPassword(password: unknown): string | Response {
  if (typeof password !== 'string' || password.length < 10) {
    return fail(400, 'Kies een wachtwoord van minimaal 10 tekens.')
  }
  return password
}

// ── Analyse helpers ─────────────────────────────────────────────────────

const CHAT_GONE = 'Deze analyse bestaat niet (meer). Misschien is de draverij al voorbij.'
const AI_REPLY_DELAY = 1200

const todayIso = () => new Date().toISOString().slice(0, 10)
const chatKey = (userId: string, id: string) => `${userId}/${id}`

function findChat(user: MockUser, id: unknown): MockChat | undefined {
  const entry = analyseDb.chats[chatKey(user.id, String(id))]
  return entry && entry.chat.draverij.date >= todayIso() ? entry : undefined
}

function chatView(entry: MockChat): Chat {
  return { ...entry.chat, advice: analyseDb.advice[chatKey(entry.userId, entry.chat.id)] ?? null }
}

let messageSeq = 0

function userMessage(text: string): ChatMessage {
  return {
    id: `m-mock-${++messageSeq}`,
    role: 'user',
    text,
    sources: [],
    proposal: null,
    createdAt: new Date().toISOString(),
  }
}

const kickoffText = (d: Draverij) =>
  `Ik wil een inzetadvies voor de kortebaan in ${d.place} op ${new Intl.DateTimeFormat('nl-NL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${d.date}T12:00:00`))}.`

const MOCK_SOURCES: Source[] = [
  { url: 'https://www.kortebaan.nl/uitslagen', title: 'Uitslagen kortebaan' },
  { url: 'https://www.draverijen.nl/nieuws', title: 'Nieuws van de draverijen' },
]

// Canned AI: asks questions first, proposes advice once the user has answered.
// A message containing "fout" makes the mock AI fail, to show the error state.
function mockReply(chat: Chat): ChatMessage | { error: string } {
  const last = chat.messages.at(-1)
  if (last?.role === 'user' && /fout/i.test(last.text)) {
    return { error: 'Claude reageert even niet. Probeer het zo opnieuw.' }
  }
  const answered = chat.messages.some((m) => m.role === 'assistant')
  const base = {
    id: `m-mock-${++messageSeq}`,
    role: 'assistant' as const,
    createdAt: new Date().toISOString(),
  }
  if (!answered) {
    return {
      ...base,
      text: `Ik heb de recente uitslagen voor **${chat.draverij.place}** bekeken. Een paar vragen voordat ik een advies maak:\n\n- Wat is je budget voor de dag?\n- Speel je liever op zeker, of mag er wat risico in?\n- Zijn er paarden of pikeurs die je extra wilt meewegen?`,
      sources: MOCK_SOURCES,
      proposal: null,
    }
  }
  return {
    ...base,
    text: 'Op basis van de recente vorm en jouw antwoorden is dit mijn voorstel. Fleur de Lis liep de laatste drie koersen sterk op gras.',
    sources: MOCK_SOURCES.slice(0, 1),
    proposal: {
      summary:
        'Vooral inzetten op de favorieten in de eerste omlopen, met een kleine gok in de finale.',
      budget: 50,
      picks: [
        {
          race: '1e omloop, koppel 3',
          bet: 'Winnaar: Fleur de Lis',
          amount: 20,
          reasoning: 'Won twee van de laatste drie koersen, pikeur kent de baan goed.',
        },
        {
          race: '2e omloop, koppel 1',
          bet: 'Winnaar: Hessel B',
          amount: 15,
          reasoning: 'Sterke starter; de tegenstander liep vorige week slecht.',
        },
        {
          race: 'Finale',
          bet: 'Winnaar: Ilse van de Heide',
          amount: 15,
          reasoning: 'Buitenkans met hoge quote; loopt goed op een zware baan.',
        },
      ],
    },
  }
}

// Checks the AI connection and daily limit like the Lambda, then answers after a short delay
function startTurn(user: MockUser, entry: MockChat, message?: ChatMessage): Response | null {
  if (db.ai.status === 'none') {
    return fail(409, 'De AI is nog niet gekoppeld. Vraag de eigenaar om de AI-koppeling in te stellen.')
  }
  if (db.ai.status !== 'connected') {
    return fail(503, 'De AI-koppeling werkt op dit moment niet. De eigenaar is op de hoogte gebracht.')
  }
  const today = todayIso()
  if (entry.countedDay !== today) {
    const used = db.usageToday[user.id] ?? 0
    if (user.role !== 'owner' && user.dailyLimit !== null && used >= user.dailyLimit) {
      return fail(
        429,
        `Je hebt je daglimiet van ${user.dailyLimit} analyses bereikt. Morgen kun je weer verder.`,
      )
    }
    db.usageToday[user.id] = used + 1
    entry.countedDay = today
  }

  const { chat } = entry
  if (message) chat.messages.push(message)
  const turn = `${Date.now()}-${++messageSeq}`
  entry.turn = turn
  Object.assign(chat, { status: 'thinking', error: null, updatedAt: new Date().toISOString() })
  setTimeout(() => {
    // Restarted meanwhile: this answer is no longer wanted
    if (entry.turn !== turn || chat.status !== 'thinking') return
    const reply = mockReply(chat)
    if ('error' in reply) {
      Object.assign(chat, { status: 'error', error: reply.error })
    } else {
      chat.messages.push(reply)
      Object.assign(chat, { status: 'idle', error: null, updatedAt: reply.createdAt })
    }
  }, AI_REPLY_DELAY)
  return null
}

function instructionView(): AiInstruction {
  const { text, updatedAt, previous } = analyseDb.instruction
  return {
    text,
    isDefault: text === MOCK_DEFAULT_INSTRUCTION,
    updatedAt,
    hasPrevious: previous !== null,
    defaultText: MOCK_DEFAULT_INSTRUCTION,
  }
}

function saveInstruction(text: string) {
  analyseDb.instruction = {
    text,
    updatedAt: new Date().toISOString(),
    previous: analyseDb.instruction.text,
  }
}

type Body = Record<string, unknown>

export const handlers = [
  http.get(`${BASE}/health`, async () => {
    await delay(LAG)
    return HttpResponse.json({ status: 'ok' })
  }),

  // ── Auth ──────────────────────────────────────────────────────────────

  http.post(`${BASE}/auth/login`, async ({ request }) => {
    await delay(LAG)
    const body = (await request.json()) as Body
    const username = validName(body.username).toLowerCase()
    const password = typeof body.password === 'string' ? body.password : ''
    if (!username) return fail(400, 'Vul je gebruikersnaam in.')
    if (!password) return fail(400, 'Vul je wachtwoord in.')

    const user = db.users.find((u) => u.username === username)
    if (!user?.password || user.password !== password) {
      return fail(401, 'Gebruikersnaam of wachtwoord klopt niet.')
    }
    if (user.status === 'paused') return fail(403, PAUSED)
    user.lastActiveAt = new Date().toISOString()
    return HttpResponse.json({ token: issueToken(user), user: toMe(user) })
  }),

  http.get(`${BASE}/auth/links/:token`, async ({ params }) => {
    await delay(LAG)
    const user = userForLink(String(params.token))
    if (!user?.link) return fail(410, LINK_GONE)
    return HttpResponse.json({ type: user.link.type, name: user.name, username: user.username })
  }),

  http.post(`${BASE}/auth/links/:token/accept`, async ({ params, request }) => {
    await delay(LAG)
    const user = userForLink(String(params.token))
    if (!user?.link) return fail(410, LINK_GONE)
    const body = (await request.json()) as Body

    const password = checkPassword(body.password)
    if (password instanceof Response) return password

    if (user.link.type === 'invite') {
      const username = validName(body.username).toLowerCase()
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
        return fail(400, 'Gebruik 3 tot 30 tekens: letters, cijfers, punt, streepje of underscore.')
      }
      if (db.users.some((u) => u.username === username && u.id !== user.id)) {
        return fail(409, 'Deze gebruikersnaam is al bezet. Kies een andere.')
      }
      if (body.name !== undefined) {
        const name = checkName(body.name)
        if (name instanceof Response) return name
        user.name = name
      }
      user.username = username
      user.status = 'active'
    }
    user.password = password
    user.link = null
    user.lastActiveAt = new Date().toISOString()
    return HttpResponse.json({ token: issueToken(user, true), user: toMe(user) })
  }),

  // ── Me ────────────────────────────────────────────────────────────────

  http.get(`${BASE}/me`, async ({ request }) => {
    await delay(LAG)
    const { user, error } = authenticate(request)
    if (error) return error
    return HttpResponse.json(toMe(user))
  }),

  http.patch(`${BASE}/me`, async ({ request }) => {
    await delay(LAG)
    const { user, error } = authenticate(request)
    if (error) return error
    const name = checkName(((await request.json()) as Body).name)
    if (name instanceof Response) return name
    user.name = name
    return HttpResponse.json(toMe(user))
  }),

  http.put(`${BASE}/me/password`, async ({ request }) => {
    await delay(LAG)
    const { user, error } = authenticate(request)
    if (error) return error
    const body = (await request.json()) as Body
    if (!body.currentPassword) return fail(400, 'Vul je huidige wachtwoord in.')
    if (body.currentPassword !== user.password) return fail(400, 'Je huidige wachtwoord klopt niet.')
    const password = checkPassword(body.newPassword)
    if (password instanceof Response) return password
    user.password = password
    return HttpResponse.json({ token: issueToken(user, true) })
  }),

  http.get(`${BASE}/me/sessions`, async ({ request }) => {
    await delay(LAG)
    const { user, error } = authenticate(request)
    if (error) return error
    const sessions = (db.sessions[user.id] ?? []).map((s) => ({ ...s, balance: s.paidOut - s.staked }))
    const staked = sessions.reduce((sum, s) => sum + s.staked, 0)
    const paidOut = sessions.reduce((sum, s) => sum + s.paidOut, 0)
    return HttpResponse.json({ sessions, totals: { staked, paidOut, balance: paidOut - staked } })
  }),

  // ── Friends (owner only) ──────────────────────────────────────────────

  http.get(`${BASE}/friends`, async ({ request }) => {
    await delay(LAG)
    const { error } = requireOwner(request)
    if (error) return error
    const friends = db.users
      .filter((u) => u.role === 'friend')
      .sort((a, b) => a.name.localeCompare(b.name, 'nl'))
      .map(toFriend)
    return HttpResponse.json({ friends })
  }),

  http.post(`${BASE}/friends`, async ({ request }) => {
    await delay(LAG)
    const { error } = requireOwner(request)
    if (error) return error
    const body = (await request.json()) as Body
    const name = checkName(body.name)
    if (name instanceof Response) return name
    const dailyLimit = body.dailyLimit === undefined ? DEFAULT_DAILY_LIMIT : checkLimit(body.dailyLimit)
    if (dailyLimit instanceof Response) return dailyLimit

    const friend: MockUser = {
      id: `friend-${crypto.randomUUID()}`,
      name,
      username: null,
      role: 'friend',
      status: 'invited',
      password: null,
      dailyLimit,
      lastActiveAt: null,
      link: null,
    }
    const link = issueLink(friend, 'invite')
    db.users.push(friend)
    return HttpResponse.json({ friend: toFriend(friend), link }, { status: 201 })
  }),

  http.patch(`${BASE}/friends/:id`, async ({ params, request }) => {
    await delay(LAG)
    const { error } = requireOwner(request)
    if (error) return error
    const friend = db.users.find((u) => u.id === params.id && u.role === 'friend')
    if (!friend) return fail(404, 'Deze vriend bestaat niet (meer).')
    const body = (await request.json()) as Body

    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'paused') {
        return fail(400, 'Kies actief of gepauzeerd.')
      }
      if (friend.status === 'invited') {
        return fail(409, 'Deze vriend heeft de uitnodiging nog niet geaccepteerd.')
      }
    }
    const dailyLimit = body.dailyLimit === undefined ? friend.dailyLimit : checkLimit(body.dailyLimit)
    if (dailyLimit instanceof Response) return dailyLimit

    if (body.status !== undefined) friend.status = body.status as 'active' | 'paused'
    friend.dailyLimit = dailyLimit
    return HttpResponse.json({ friend: toFriend(friend) })
  }),

  http.delete(`${BASE}/friends/:id`, async ({ params, request }) => {
    await delay(LAG)
    const { error } = requireOwner(request)
    if (error) return error
    const i = db.users.findIndex((u) => u.id === params.id && u.role === 'friend')
    if (i < 0) return fail(404, 'Deze vriend bestaat niet (meer).')
    db.users.splice(i, 1)
    return HttpResponse.json({ ok: true })
  }),

  http.post(`${BASE}/friends/:id/link`, async ({ params, request }) => {
    await delay(LAG)
    const { error } = requireOwner(request)
    if (error) return error
    const friend = db.users.find((u) => u.id === params.id && u.role === 'friend')
    if (!friend) return fail(404, 'Deze vriend bestaat niet (meer).')
    const link = issueLink(friend, friend.status === 'invited' ? 'invite' : 'reset')
    return HttpResponse.json({ friend: toFriend(friend), link })
  }),

  // ── AI connection (owner only) ────────────────────────────────────────

  http.get(`${BASE}/ai-connection`, async ({ request }) => {
    await delay(LAG)
    const { error } = requireOwner(request)
    if (error) return error
    return HttpResponse.json(aiOverview())
  }),

  http.put(`${BASE}/ai-connection`, async ({ request }) => {
    await delay(LAG)
    const { error } = requireOwner(request)
    if (error) return error
    const token = validName(((await request.json()) as Body).token)
    if (!token) return fail(400, 'Plak je setup-token.')
    if (!SETUP_TOKEN.test(token)) {
      return fail(
        400,
        'Dit lijkt geen setup-token. Het begint met "sk-ant-" — kopieer de volledige uitvoer van `claude setup-token`.',
      )
    }
    storedToken = token
    db.ai = { ...db.ai, tokenHint: `…${token.slice(-4)}`, connectedAt: new Date().toISOString() }
    testToken(token)
    return HttpResponse.json(aiOverview())
  }),

  http.post(`${BASE}/ai-connection/test`, async ({ request }) => {
    await delay(LAG)
    const { error } = requireOwner(request)
    if (error) return error
    if (!storedToken || db.ai.status === 'none') {
      return fail(409, 'Er is nog geen setup-token gekoppeld.')
    }
    testToken(storedToken)
    return HttpResponse.json(aiOverview())
  }),

  http.delete(`${BASE}/ai-connection`, async ({ request }) => {
    await delay(LAG)
    const { error } = requireOwner(request)
    if (error) return error
    storedToken = null
    db.ai = { status: 'none', tokenHint: null, connectedAt: null, lastTestedAt: null, lastError: null }
    return HttpResponse.json(aiOverview())
  }),
  // ── Analyse ───────────────────────────────────────────────────────────

  http.get(`${BASE}/draverijen`, async ({ request }) => {
    await delay(LAG)
    const { error } = authenticate(request)
    if (error) return error
    const today = todayIso()
    return HttpResponse.json(
      analyseDb.draverijen.filter((d) => d.date >= today).sort((a, b) => a.id.localeCompare(b.id)),
    )
  }),

  http.get(`${BASE}/analyses`, async ({ request }) => {
    await delay(LAG)
    const { user, error } = authenticate(request)
    if (error) return error
    const summaries: ChatSummary[] = Object.values(analyseDb.chats)
      .filter((entry) => entry.userId === user.id && entry.chat.draverij.date >= todayIso())
      .map(({ chat }) => ({
        id: chat.id,
        draverij: chat.draverij,
        status: chat.status,
        hasAdvice: !!analyseDb.advice[chatKey(user.id, chat.id)],
        messageCount: chat.messages.length,
        updatedAt: chat.updatedAt,
      }))
      .sort((a, b) => a.draverij.date.localeCompare(b.draverij.date))
    return HttpResponse.json(summaries)
  }),

  http.post(`${BASE}/analyses`, async ({ request }) => {
    await delay(LAG)
    const { user, error } = authenticate(request)
    if (error) return error
    const body = (await request.json()) as Body
    let draverij: Draverij | undefined
    if (typeof body.draverijId === 'string') {
      draverij = analyseDb.draverijen.find((d) => d.id === body.draverijId && d.date >= todayIso())
      if (!draverij) return fail(404, 'Deze draverij staat niet (meer) in de lijst.')
    } else {
      const place = validName(body.place)
      const date = typeof body.date === 'string' ? body.date : ''
      if (!place) return fail(400, 'Vul de plaats van de draverij in.')
      if (place.length > 40) return fail(400, 'De plaats mag maximaal 40 tekens zijn.')
      if (!date) return fail(400, 'Kies de datum van de draverij.')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
        return fail(400, 'Kies een geldige datum.')
      }
      if (date < todayIso()) {
        return fail(400, 'Deze draverij is al voorbij. Kies een datum vanaf vandaag.')
      }
      const slug = place
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
      if (!slug) return fail(400, 'Gebruik letters in de plaatsnaam.')
      const id = `${date}-${slug}`
      draverij = analyseDb.draverijen.find((d) => d.id === id)
      if (!draverij) {
        draverij = { id, place, date }
        analyseDb.draverijen.push(draverij)
      }
    }

    const existing = analyseDb.chats[chatKey(user.id, draverij.id)]
    if (existing) return HttpResponse.json(chatView(existing))

    const entry: MockChat = {
      userId: user.id,
      countedDay: null,
      chat: {
        id: draverij.id,
        draverij,
        status: 'idle',
        error: null,
        advice: null,
        updatedAt: new Date().toISOString(),
        messages: [userMessage(kickoffText(draverij))],
      },
    }
    const refused = startTurn(user, entry)
    if (refused) return refused
    analyseDb.chats[chatKey(user.id, draverij.id)] = entry
    return HttpResponse.json(chatView(entry), { status: 201 })
  }),

  http.get(`${BASE}/analyses/:id`, async ({ params, request }) => {
    await delay(LAG)
    const { user, error } = authenticate(request)
    if (error) return error
    const entry = findChat(user, params.id)
    if (!entry) return fail(404, CHAT_GONE)
    return HttpResponse.json(chatView(entry))
  }),

  http.post(`${BASE}/analyses/:id/messages`, async ({ params, request }) => {
    await delay(LAG)
    const { user, error } = authenticate(request)
    if (error) return error
    const entry = findChat(user, params.id)
    if (!entry) return fail(404, CHAT_GONE)
    const text = validName(((await request.json()) as Body).text)
    if (!text) return fail(400, 'Typ eerst een bericht.')
    if (text.length > 2000) return fail(400, 'Je bericht mag maximaal 2000 tekens zijn.')
    if (entry.chat.status === 'thinking') {
      return fail(409, 'De AI is nog bezig met een antwoord. Wacht even.')
    }
    if (entry.chat.messages.length >= 40) {
      return fail(
        409,
        'Deze chat is vol. Begin opnieuw om verder te praten; je vastgelegde advies blijft staan.',
      )
    }
    const refused = startTurn(user, entry, userMessage(text))
    if (refused) return refused
    return HttpResponse.json(chatView(entry), { status: 202 })
  }),

  http.post(`${BASE}/analyses/:id/retry`, async ({ params, request }) => {
    await delay(LAG)
    const { user, error } = authenticate(request)
    if (error) return error
    const entry = findChat(user, params.id)
    if (!entry) return fail(404, CHAT_GONE)
    if (entry.chat.status !== 'error') return fail(409, 'Er is niets om opnieuw te proberen.')
    const refused = startTurn(user, entry)
    if (refused) return refused
    return HttpResponse.json(chatView(entry), { status: 202 })
  }),

  http.post(`${BASE}/analyses/:id/restart`, async ({ params, request }) => {
    await delay(LAG)
    const { user, error } = authenticate(request)
    if (error) return error
    const entry = findChat(user, params.id)
    if (!entry) return fail(404, CHAT_GONE)
    const previous = entry.chat.messages
    entry.chat.messages = [userMessage(kickoffText(entry.chat.draverij))]
    const refused = startTurn(user, entry)
    if (refused) {
      entry.chat.messages = previous
      return refused
    }
    return HttpResponse.json(chatView(entry), { status: 202 })
  }),

  http.post(`${BASE}/analyses/:id/advice`, async ({ params, request }) => {
    await delay(LAG)
    const { user, error } = authenticate(request)
    if (error) return error
    const entry = findChat(user, params.id)
    if (!entry) return fail(404, CHAT_GONE)
    const messageId = ((await request.json()) as Body).messageId
    const message = entry.chat.messages.find((m) => m.id === messageId && m.role === 'assistant')
    if (!message?.proposal) return fail(404, 'Dit adviesvoorstel bestaat niet (meer).')
    analyseDb.advice[chatKey(user.id, entry.chat.id)] = {
      draverij: entry.chat.draverij,
      messageId: message.id,
      proposal: message.proposal,
      lockedAt: new Date().toISOString(),
    }
    return HttpResponse.json(chatView(entry))
  }),

  // ── AI-instructie ─────────────────────────────────────────────────────

  http.get(`${BASE}/ai-instruction`, async ({ request }) => {
    await delay(LAG)
    const { error } = requireOwner(request)
    if (error) return error
    return HttpResponse.json(instructionView())
  }),

  http.put(`${BASE}/ai-instruction`, async ({ request }) => {
    await delay(LAG)
    const { error } = requireOwner(request)
    if (error) return error
    const body = (await request.json()) as Body
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) return fail(400, 'De instructie mag niet leeg zijn.')
    if (text.length > 8000) return fail(400, 'De instructie mag maximaal 8000 tekens zijn.')
    if (text !== analyseDb.instruction.text) saveInstruction(text)
    return HttpResponse.json(instructionView())
  }),

  http.post(`${BASE}/ai-instruction/revert`, async ({ request }) => {
    await delay(LAG)
    const { error } = requireOwner(request)
    if (error) return error
    const to = ((await request.json()) as Body).to
    if (to === 'default') {
      if (analyseDb.instruction.text !== MOCK_DEFAULT_INSTRUCTION) {
        saveInstruction(MOCK_DEFAULT_INSTRUCTION)
      }
      return HttpResponse.json(instructionView())
    }
    if (to === 'previous') {
      const previous = analyseDb.instruction.previous
      if (previous === null) return fail(409, 'Er is geen vorige versie om naar terug te zetten.')
      saveInstruction(previous)
      return HttpResponse.json(instructionView())
    }
    return fail(400, 'Kies of je terugzet naar de vorige of de standaardversie.')
  }),
]
