import { http, HttpResponse, delay } from 'msw'
import type { AiConnection, Friend, IssuedLink, LinkType, Me, PlaySession } from '@/types/account'
import type {
  AiInstruction,
  Chat,
  ChatMessage,
  ChatSummary,
  Draverij,
  Source,
} from '@/types/analyse'
import type { Koersdag, KoersdagToday, KoersdagUpdate, UpdateKind } from '@/types/koersdag'
import type { OAuthConsent, OAuthScope } from '@/types/oauth'
import type { OmloopResult, ReviewStep, TerugblikDetail } from '@/types/terugblik'
import {
  analyseDb,
  db,
  issueToken,
  koersdagDb,
  terugblikDb,
  MOCK_DEFAULT_INSTRUCTION,
  MOCK_OAUTH_CLIENT,
  newLinkToken,
  userForLink,
  userForToken,
  type MockChat,
  type MockKoersdag,
  type MockReview,
  type MockUser,
} from './data'

// Mirrors the Lambda handlers in lambda/src (auth, me, friends, aiConnection, analysis,
// aiInstruction, koersdag, terugblik, oauth):
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

// AI connection and daily limit, like lambda/src/lib/aiAccess.ts; counted once per day per item
function claimAiRun(user: MockUser, entry: { countedDay: string | null }): Response | null {
  if (db.ai.status === 'none') {
    return fail(
      409,
      'De AI is nog niet gekoppeld. Vraag de eigenaar om de AI-koppeling in te stellen.',
    )
  }
  if (db.ai.status !== 'connected') {
    return fail(
      503,
      'De AI-koppeling werkt op dit moment niet. De eigenaar is op de hoogte gebracht.',
    )
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
  return null
}

// Checks the AI connection and daily limit like the Lambda, then answers after a short delay
function startTurn(user: MockUser, entry: MockChat, message?: ChatMessage): Response | null {
  const refused = claimAiRun(user, entry)
  if (refused) return refused

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

// ── Koersdag helpers ────────────────────────────────────────────────────

const KOERSDAG_GONE = 'Deze koersdag bestaat niet (meer).'
const KOERSDAG_FINISHED = 'Deze koersdag is al afgerond.'
const MAX_AMOUNT = 10_000
const MAX_PHOTO_BASE64 = 5_000_000 // per photo, and all photos of one board together
const MAX_PHOTOS = 3

const round2 = (n: number) => Math.round(n * 100) / 100
const euro = (n: number) =>
  new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(n)

function koersdagView(entry: MockKoersdag): Koersdag {
  const { koersdag } = entry
  const staked = round2(koersdag.bets.reduce((sum, b) => sum + b.amount, 0))
  const paidOut = round2(koersdag.bets.reduce((sum, b) => sum + (b.winnings ?? 0), 0))
  return {
    ...structuredClone(koersdag),
    staked,
    paidOut,
    remaining: round2(koersdag.budget - staked + paidOut),
    lockedAdvice: analyseDb.advice[chatKey(entry.userId, koersdag.id)] ?? null,
  }
}

// An amount in euro's (winnings may be 0); an error response otherwise
function checkAmount(value: unknown, message: string, allowZero = false): number | Response {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    (!allowZero && value === 0)
  ) {
    return fail(400, message)
  }
  if (value > MAX_AMOUNT) return fail(400, `Een bedrag mag maximaal € ${MAX_AMOUNT} zijn.`)
  return round2(value)
}

// The Lambda sniffs the bytes; the mock checks the base64 prefix
function sniffBase64(image: string): boolean {
  return ['/9j/', 'iVBOR', 'UklGR'].some((prefix) => image.startsWith(prefix))
}

let koersdagSeq = 0
const nextId = (prefix: string) => `${prefix}-mock-${++koersdagSeq}`

// Canned AI per omloop: omloop 1 confirms the advice, omloop 2 changes it, omloop 3 is the
// finale; a photo shows a difference with the board. A draverij whose name contains "fout"
// can't be fetched online, to show the error state (a photo still works).
function mockUpdate(entry: MockKoersdag, kind: UpdateKind): KoersdagUpdate | { error: string } {
  const { koersdag } = entry
  if (kind === 'fetch' && /fout/i.test(koersdag.draverij.place)) {
    return {
      error:
        'De AI kon online niets actueels vinden over deze draverij. Maak een foto van het bord of probeer het opnieuw.',
    }
  }
  const omloop = koersdag.omloop
  const label = `${omloop}e omloop`
  const base = {
    id: nextId('u'),
    omloop,
    kind,
    createdAt: new Date().toISOString(),
    sources: kind === 'fetch' ? MOCK_SOURCES.slice(0, 1) : [],
    photoCheck: null,
    changes: [],
    isFinal: false,
  }
  const pick = (race: string, bet: string, amount: number, reasoning: string, changed = false) => ({
    id: nextId('s'),
    race,
    bet,
    amount,
    reasoning,
    changed,
  })

  if (kind === 'photo') {
    return {
      ...base,
      findings: ['Het bord toont een hogere quote voor Fleur de Lis.'],
      verdict: 'changed',
      changes: ['Minder op Fleur de Lis: de quote steeg, de markt twijfelt.'],
      photoCheck: { matches: false, differences: ['Quota Fleur de Lis 3,2 → 4,1'] },
      adviceNote: 'Zet minder in op Fleur de Lis; de rest blijft staan.',
      advice: [
        pick(`${label}, koppel 3`, 'Winnaar: Fleur de Lis', 10, 'Nog steeds de sterkste.', true),
      ],
    }
  }
  if (omloop >= 3) {
    return {
      ...base,
      findings: ['De finale is bekend: Ilse van de Heide tegen Hessel B.'],
      verdict: 'kept',
      adviceNote: 'Dit is de finale: de gok op Ilse van de Heide blijft staan.',
      advice: [pick('Finale', 'Winnaar: Ilse van de Heide', 10, 'Buitenkans met hoge quote.')],
      isFinal: true,
    }
  }
  if (omloop === 2) {
    return {
      ...base,
      findings: ['Afmelding: Zorro W start niet in koppel 1.'],
      verdict: 'changed',
      changes: ['Nieuw: Hessel B, want zijn sterkste tegenstander is afgemeld.'],
      adviceNote: 'Een kleine extra inzet op Hessel B.',
      advice: [pick(`${label}, koppel 1`, 'Winnaar: Hessel B', 5, 'Tegenstander afgemeld.', true)],
    }
  }
  const hadAdvice =
    !!analyseDb.advice[chatKey(entry.userId, koersdag.id)] || koersdag.updates.length > 0
  return {
    ...base,
    findings: ['Geen afmeldingen voor de 1e omloop.', 'Quota Fleur de Lis 3,2.'],
    verdict: hadAdvice ? 'kept' : 'first',
    adviceNote: hadAdvice
      ? 'Het vastgelegde advies klopt nog: zet in op Fleur de Lis.'
      : `Eerste advies binnen je budget van ${euro(koersdag.budget)}.`,
    advice: [
      pick(`${label}, koppel 3`, 'Winnaar: Fleur de Lis', 20, 'Won twee van de laatste drie.'),
    ],
  }
}

// Like the Lambda: checks the AI connection and daily limit, then answers after a short delay
function startUpdate(
  user: MockUser,
  entry: MockKoersdag,
  kind: UpdateKind,
  prepare: () => void = () => {},
): Response | null {
  const { koersdag } = entry
  if (koersdag.finishedAt) return fail(409, KOERSDAG_FINISHED)
  if (koersdag.status === 'thinking') {
    return fail(409, 'De AI is nog bezig met de vorige update. Wacht even.')
  }
  const refused = claimAiRun(user, entry)
  if (refused) return refused
  prepare()
  const run = nextId('run')
  entry.run = run
  Object.assign(koersdag, {
    status: 'thinking',
    error: null,
    step: kind,
    updatedAt: new Date().toISOString(),
  })
  setTimeout(() => {
    // Finished meanwhile: this answer is no longer wanted
    if (entry.run !== run || koersdag.status !== 'thinking') return
    const result = mockUpdate(entry, kind)
    const updatedAt = new Date().toISOString()
    if ('error' in result) {
      Object.assign(koersdag, { status: 'error', error: result.error, updatedAt })
    } else {
      koersdag.updates.push(result)
      Object.assign(koersdag, { status: 'idle', error: null, updatedAt })
    }
  }, AI_REPLY_DELAY)
  return null
}

type KoersdagGuard =
  | { user: MockUser; entry: MockKoersdag; error?: never }
  | { user?: never; entry?: never; error: Response }

function koersdagFor(request: Request, id: unknown): KoersdagGuard {
  const { user, error } = authenticate(request)
  if (error) return { error }
  const entry = koersdagDb.koersdagen[chatKey(user.id, String(id))]
  if (!entry) return { error: fail(404, KOERSDAG_GONE) }
  return { user, entry }
}

function openKoersdagFor(request: Request, id: unknown): KoersdagGuard {
  const guard = koersdagFor(request, id)
  if (guard.entry?.koersdag.finishedAt) return { error: fail(409, KOERSDAG_FINISHED) }
  return guard
}

// ── Terugblik helpers ───────────────────────────────────────────────────

const RESULTS_NOT_FOUND =
  'De AI vond de uitslagen niet online. Vul ze zelf in of upload een foto van het uitslagbord.'
const REVIEW_BUSY = 'De AI is nog bezig. Wacht even.'
const MAX_OMLOPEN = 12
const MAX_WINNER_LENGTH = 120
const MAX_PLACES_LENGTH = 300
const MOCK_WINNERS = ['Fleur de Lis', 'Beau Gamin', 'Oranje Boven', 'Zilvervos', 'Dolle Mina']

function reviewOf(entry: MockKoersdag): MockReview {
  const key = chatKey(entry.userId, entry.koersdag.id)
  return (terugblikDb.reviews[key] ??= {
    countedDay: null,
    status: 'idle',
    error: null,
    step: null,
    results: null,
    resultsConfirmedAt: null,
    evaluation: null,
  })
}

function terugblikView(entry: MockKoersdag): TerugblikDetail {
  const view = koersdagView(entry)
  const review = reviewOf(entry)
  return {
    id: view.id,
    draverij: view.draverij,
    budget: view.budget,
    staked: view.staked,
    paidOut: view.paidOut,
    balance: round2(view.paidOut - view.staked),
    bets: view.bets,
    finishedAt: view.finishedAt ?? view.updatedAt,
    omloop: view.omloop,
    status: review.status,
    error: review.error,
    step: review.step,
    results: structuredClone(review.results),
    resultsConfirmedAt: review.resultsConfirmedAt,
    evaluation: structuredClone(review.evaluation),
  }
}

// Keeps the speelsessie in step with the koersdag, like writeSession in the Lambda
function writeSession(entry: MockKoersdag) {
  const view = koersdagView(entry)
  const sessions = (db.sessions[entry.userId] ??= [])
  const session = {
    id: view.draverij.id,
    date: view.draverij.date,
    draverij: view.draverij.place,
    staked: view.staked,
    paidOut: view.paidOut,
    evaluated: !!reviewOf(entry).evaluation,
  }
  const index = sessions.findIndex((s) => s.id === session.id)
  if (index >= 0) sessions[index] = session
  else sessions.unshift(session)
}

// Canned AI: the uitslagen of every omloop played (at least 3); a place containing "fout" can't
// be found online (a photo still works). The evaluation checks each bet against the winner.
function mockReviewStep(entry: MockKoersdag, step: ReviewStep): string | null {
  const { koersdag } = entry
  const review = reviewOf(entry)
  if (step === 'evaluate') {
    const omlopen = (review.results ?? []).map((r) => {
      const bets = koersdag.bets.filter((b) => b.omloop === r.omloop)
      const hit = bets.some((b) => b.bet.toLowerCase().includes(r.winner.toLowerCase()))
      return {
        omloop: r.omloop,
        correct: bets.length ? hit : null,
        advice: bets.map((b) => b.bet).join(', '),
        winner: r.winner,
        reason: hit
          ? 'Het paard liep zoals verwacht vanaf de goede kant.'
          : `${r.winner} was sterker in de finale dan de vorm deed vermoeden.`,
      }
    })
    const correct = omlopen.filter((o) => o.correct).length
    const advised = omlopen.filter((o) => o.correct !== null).length
    const createdAt = new Date().toISOString()
    review.evaluation = {
      summary: advised
        ? `${correct} van de ${advised} gespeelde omlopen klopten. De favorieten waren sterk in ${koersdag.draverij.place}.`
        : `Er waren geen inzetten om te vergelijken. De favorieten waren sterk in ${koersdag.draverij.place}.`,
      omlopen,
      createdAt,
    }
    terugblikDb.lessons.unshift({
      id: nextId('les'),
      text: `In ${koersdag.draverij.place} winnen favorieten vaak vanaf de binnenkant.`,
      createdAt,
      draverijId: koersdag.draverij.id,
      place: koersdag.draverij.place,
      date: koersdag.draverij.date,
    })
    writeSession(entry)
    return null
  }
  if (step === 'results' && /fout/i.test(koersdag.draverij.place)) return RESULTS_NOT_FOUND
  const count = Math.min(MAX_OMLOPEN, Math.max(3, koersdag.omloop))
  const horse = (i: number) => MOCK_WINNERS[i % MOCK_WINNERS.length]
  review.results = Array.from({ length: count }, (_, i) => ({
    omloop: i + 1,
    winner: horse(i)!,
    places: `2. ${horse(i + 1)}, 3. ${horse(i + 2)}`,
  }))
  return null
}

function startReviewStep(
  user: MockUser,
  entry: MockKoersdag,
  step: ReviewStep,
  prepare: () => Response | void = () => {},
): Response | null {
  const review = reviewOf(entry)
  if (review.status === 'thinking') return fail(409, REVIEW_BUSY)
  const refused = prepare() ?? claimAiRun(user, review)
  if (refused) return refused
  const run = nextId('run')
  Object.assign(review, { run, status: 'thinking', error: null, step })
  setTimeout(() => {
    if (review.run !== run || review.status !== 'thinking') return
    const error = mockReviewStep(entry, step)
    Object.assign(review, { status: error ? 'error' : 'idle', error })
  }, AI_REPLY_DELAY)
  return null
}

// Validates results the user confirms, like readResults in the Lambda
function readResults(value: unknown): OmloopResult[] | string {
  if (!Array.isArray(value) || value.length === 0)
    return 'Vul de uitslag van minstens één omloop in.'
  if (value.length > MAX_OMLOPEN) return `Je kunt maximaal ${MAX_OMLOPEN} omlopen invullen.`
  const results: OmloopResult[] = []
  for (const item of value) {
    const r = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const omloop = r.omloop
    if (typeof omloop !== 'number' || !Number.isInteger(omloop) || omloop < 1 || omloop > 30) {
      return 'Er klopt iets niet met de omlopen. Probeer het opnieuw.'
    }
    const winner = typeof r.winner === 'string' ? r.winner.trim() : ''
    if (!winner) return `Vul de winnaar van de ${omloop}e omloop in.`
    if (winner.length > MAX_WINNER_LENGTH) {
      return `De winnaar mag maximaal ${MAX_WINNER_LENGTH} tekens zijn.`
    }
    const places = typeof r.places === 'string' ? r.places.trim() : ''
    if (places.length > MAX_PLACES_LENGTH) {
      return `De plaatsen mogen maximaal ${MAX_PLACES_LENGTH} tekens zijn.`
    }
    results.push({ omloop, winner, places })
  }
  if (new Set(results.map((r) => r.omloop)).size !== results.length) {
    return 'Elke omloop mag maar één keer voorkomen.'
  }
  return results.sort((a, b) => a.omloop - b.omloop)
}

function finishedKoersdagFor(request: Request, id: unknown): KoersdagGuard {
  const guard = koersdagFor(request, id)
  if (guard.entry && !guard.entry.koersdag.finishedAt) {
    return { error: fail(409, 'Rond eerst de koersdag af.') }
  }
  return guard
}

const withBalance = (s: Omit<PlaySession, 'balance'>) => ({
  id: s.id,
  date: s.date,
  draverij: s.draverij,
  staked: s.staked,
  paidOut: s.paidOut,
  balance: round2(s.paidOut - s.staked),
  evaluated: s.evaluated === true,
})

function sumUp(rows: { staked: number; paidOut: number }[]) {
  const staked = round2(rows.reduce((sum, r) => sum + r.staked, 0))
  const paidOut = round2(rows.reduce((sum, r) => sum + r.paidOut, 0))
  return { staked, paidOut, balance: round2(paidOut - staked) }
}

type Body = Record<string, unknown>

// ── OAuth (consent page of the kennisbank MCP server) ──

const OAUTH_SCOPES: Record<OAuthScope, string> = {
  'kb:read': 'De kennisbank lezen: paarden, pikeurs, koppels, edities, feiten en lessen.',
  'kb:write': 'Feiten en lessen aan de kennisbank toevoegen.',
  'kb:sql': 'Eigen leesvragen (SQL) op de kennisbank uitvoeren.',
}

// Loopback redirects may use any port, like the Lambda
function oauthRedirectMatches(uri: string): boolean {
  try {
    const url = new URL(uri)
    return MOCK_OAUTH_CLIENT.redirectUris.some((known) => {
      const k = new URL(known)
      return (
        url.protocol === k.protocol && url.hostname === k.hostname && url.pathname === k.pathname
      )
    })
  } catch {
    return false
  }
}

// Checks the client's authorize query; returns the scopes the user gets or an error response
function checkAuthorize(user: MockUser, q: Record<string, unknown>): OAuthScope[] | Response {
  if (q.client_id !== MOCK_OAUTH_CLIENT.clientId) {
    return fail(400, 'Deze app is niet (meer) bekend. Start het koppelen opnieuw vanuit de app.')
  }
  if (typeof q.redirect_uri !== 'string' || !oauthRedirectMatches(q.redirect_uri)) {
    return fail(400, 'De terugkeer-adres van deze app klopt niet. Start het koppelen opnieuw.')
  }
  if (q.response_type !== 'code') {
    return fail(400, 'Deze app vraagt een soort toegang die we niet ondersteunen.')
  }
  if (
    q.code_challenge_method !== 'S256' ||
    typeof q.code_challenge !== 'string' ||
    q.code_challenge.length < 43
  ) {
    return fail(400, 'Deze app gebruikt geen veilige koppeling (PKCE). Koppelen kan niet.')
  }
  const allowed: OAuthScope[] =
    user.role === 'owner' ? ['kb:read', 'kb:write', 'kb:sql'] : ['kb:read']
  const asked = typeof q.scope === 'string' && q.scope.trim() ? q.scope.trim().split(/s+/) : allowed
  const scopes = allowed.filter((s) => asked.includes(s))
  return scopes.length
    ? scopes
    : fail(403, 'Je account heeft geen toegang tot wat deze app vraagt.')
}

function oauthRedirect(uri: string, values: Record<string, unknown>): string {
  const url = new URL(uri)
  for (const [k, v] of Object.entries(values)) if (typeof v === 'string') url.searchParams.set(k, v)
  return url.toString()
}

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
    if (body.currentPassword !== user.password)
      return fail(400, 'Je huidige wachtwoord klopt niet.')
    const password = checkPassword(body.newPassword)
    if (password instanceof Response) return password
    user.password = password
    return HttpResponse.json({ token: issueToken(user, true) })
  }),

  http.get(`${BASE}/me/sessions`, async ({ request }) => {
    await delay(LAG)
    const { user, error } = authenticate(request)
    if (error) return error
    const sessions = (db.sessions[user.id] ?? []).map((s) => ({
      ...s,
      balance: s.paidOut - s.staked,
    }))
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
    const dailyLimit =
      body.dailyLimit === undefined ? DEFAULT_DAILY_LIMIT : checkLimit(body.dailyLimit)
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
    const dailyLimit =
      body.dailyLimit === undefined ? friend.dailyLimit : checkLimit(body.dailyLimit)
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
    db.ai = {
      status: 'none',
      tokenHint: null,
      connectedAt: null,
      lastTestedAt: null,
      lastError: null,
    }
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

  // ── Koersdag ──────────────────────────────────────────────────────────

  http.get(`${BASE}/koersdagen/today`, async ({ request }) => {
    await delay(LAG)
    const { user, error } = authenticate(request)
    if (error) return error
    const today = todayIso()
    const todays = analyseDb.draverijen.filter((d) => d.date === today)
    const entries = todays
      .map((d) => koersdagDb.koersdagen[chatKey(user.id, d.id)])
      .filter((e): e is MockKoersdag => e !== undefined)
    // An open koersdag wins over a finished one
    const current = entries.find((e) => !e.koersdag.finishedAt) ?? entries[0]
    const advice = Object.entries(analyseDb.advice)
      .filter(([key]) => key.startsWith(`${user.id}/`))
      .map(([, a]) => a)
    const next = advice
      .filter((a) => a.draverij.date > today)
      .sort((a, b) => a.draverij.date.localeCompare(b.draverij.date))[0]
    const body: KoersdagToday = {
      current: current ? koersdagView(current) : null,
      options: todays.map((d) => ({
        draverij: d,
        advice: analyseDb.advice[chatKey(user.id, d.id)] ?? null,
      })),
      next: next ?? null,
    }
    return HttpResponse.json(body)
  }),

  http.post(`${BASE}/koersdagen`, async ({ request }) => {
    await delay(LAG)
    const { user, error } = authenticate(request)
    if (error) return error
    const body = (await request.json()) as Body
    const budget = checkAmount(body.budget, 'Vul een budget in van meer dan € 0.')
    if (budget instanceof Response) return budget
    const today = todayIso()
    let draverij: Draverij | undefined
    if (typeof body.draverijId === 'string') {
      draverij = analyseDb.draverijen.find((d) => d.id === body.draverijId)
      if (!draverij || draverij.date !== today) return fail(404, 'Deze draverij is niet vandaag.')
    } else {
      const place = validName(body.place)
      if (!place) return fail(400, 'Kies de draverij van vandaag.')
      if (place.length > 40) return fail(400, 'De plaats mag maximaal 40 tekens zijn.')
      const slug = place
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
      if (!slug) return fail(400, 'Gebruik letters in de plaatsnaam.')
      const id = `${today}-${slug}`
      draverij = analyseDb.draverijen.find((d) => d.id === id)
      if (!draverij) {
        draverij = { id, place, date: today }
        analyseDb.draverijen.push(draverij)
      }
    }

    const key = chatKey(user.id, draverij.id)
    const existing = koersdagDb.koersdagen[key]
    if (existing) return HttpResponse.json(koersdagView(existing))

    const entry: MockKoersdag = {
      userId: user.id,
      countedDay: null,
      koersdag: {
        id: draverij.id,
        draverij,
        budget,
        omloop: 1,
        status: 'idle',
        error: null,
        step: null,
        updates: [],
        bets: [],
        finishedAt: null,
        updatedAt: new Date().toISOString(),
      },
    }
    koersdagDb.koersdagen[key] = entry
    const refused = startUpdate(user, entry, 'fetch')
    if (refused) {
      // The koersdag exists; the AI couldn't start (limit, no connection). Show it with the reason.
      const { message } = (await refused.json()) as { message: string }
      Object.assign(entry.koersdag, { status: 'error', error: message, step: 'fetch' })
    }
    return HttpResponse.json(koersdagView(entry), { status: 201 })
  }),

  http.get(`${BASE}/koersdagen/:id`, async ({ params, request }) => {
    await delay(LAG)
    const { entry, error } = koersdagFor(request, params.id)
    if (error) return error
    return HttpResponse.json(koersdagView(entry))
  }),

  http.post(`${BASE}/koersdagen/:id/refresh`, async ({ params, request }) => {
    await delay(LAG)
    const { user, entry, error } = koersdagFor(request, params.id)
    if (error) return error
    const refused = startUpdate(user, entry, 'fetch')
    if (refused) return refused
    return HttpResponse.json(koersdagView(entry), { status: 202 })
  }),

  http.post(`${BASE}/koersdagen/:id/photo`, async ({ params, request }) => {
    await delay(LAG)
    const { user, entry, error } = koersdagFor(request, params.id)
    if (error) return error
    const body = (await request.json()) as Body
    // Several photos of one board as `images`; the older single-photo body still works
    const list = (Array.isArray(body.images) ? body.images : [body]) as Body[]
    if (!list.length) return fail(400, 'Maak eerst een foto.')
    if (list.length > MAX_PHOTOS) return fail(400, `Stuur maximaal ${MAX_PHOTOS} foto's tegelijk.`)
    let total = 0
    for (const photo of list) {
      if (
        typeof photo?.mediaType !== 'string' ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(photo.mediaType)
      ) {
        return fail(400, 'Gebruik een foto (JPG, PNG of WebP).')
      }
      const image = typeof photo.image === 'string' ? photo.image : ''
      if (!image) return fail(400, 'Maak eerst een foto.')
      if (image.length > MAX_PHOTO_BASE64) {
        return fail(
          413,
          'De foto is te groot. Probeer het opnieuw; de app verkleint de foto automatisch.',
        )
      }
      if (!sniffBase64(image)) return fail(400, 'Dit bestand is geen foto. Probeer het opnieuw.')
      total += image.length
    }
    if (total > MAX_PHOTO_BASE64) {
      return fail(413, "De foto's zijn samen te groot. Stuur minder foto's tegelijk.")
    }
    const refused = startUpdate(user, entry, 'photo')
    if (refused) return refused
    return HttpResponse.json(koersdagView(entry), { status: 202 })
  }),

  http.post(`${BASE}/koersdagen/:id/next`, async ({ params, request }) => {
    await delay(LAG)
    const { user, entry, error } = koersdagFor(request, params.id)
    if (error) return error
    const refused = startUpdate(user, entry, 'fetch', () => {
      entry.koersdag.omloop += 1
    })
    if (refused) return refused
    return HttpResponse.json(koersdagView(entry), { status: 202 })
  }),

  http.post(`${BASE}/koersdagen/:id/finish`, async ({ params, request }) => {
    await delay(LAG)
    const { user, entry, error } = openKoersdagFor(request, params.id)
    if (error) return error
    const now = new Date().toISOString()
    entry.run = undefined
    Object.assign(entry.koersdag, { status: 'idle', error: null, finishedAt: now, updatedAt: now })
    const view = koersdagView(entry)
    const sessions = (db.sessions[user.id] ??= [])
    const session = {
      id: view.draverij.id,
      date: view.draverij.date,
      draverij: view.draverij.place,
      staked: view.staked,
      paidOut: view.paidOut,
    }
    const index = sessions.findIndex((s) => s.id === session.id)
    if (index >= 0) sessions[index] = session
    else sessions.unshift(session)
    return HttpResponse.json(view)
  }),

  http.post(`${BASE}/koersdagen/:id/bets`, async ({ params, request }) => {
    await delay(LAG)
    const { entry, error } = openKoersdagFor(request, params.id)
    if (error) return error
    const body = (await request.json()) as Body
    const text = validName(body.bet).slice(0, 200)
    if (!text) return fail(400, 'Vul in waarop je hebt ingezet.')
    const amount = checkAmount(body.amount, 'Vul een inzet in van meer dan € 0.')
    if (amount instanceof Response) return amount
    const { koersdag } = entry
    const suggestionId = typeof body.suggestionId === 'string' ? body.suggestionId : null
    if (
      suggestionId &&
      !koersdag.updates.some((u) => u.advice.some((s) => s.id === suggestionId))
    ) {
      return fail(404, 'Deze suggestie bestaat niet (meer).')
    }
    if (!suggestionId || !koersdag.bets.some((b) => b.suggestionId === suggestionId)) {
      koersdag.bets.push({
        id: nextId('b'),
        omloop: koersdag.omloop,
        suggestionId,
        bet: text,
        amount,
        winnings: null,
        createdAt: new Date().toISOString(),
      })
      koersdag.updatedAt = new Date().toISOString()
    }
    return HttpResponse.json(koersdagView(entry), { status: 201 })
  }),

  http.patch(`${BASE}/koersdagen/:id/bets/:betId`, async ({ params, request }) => {
    await delay(LAG)
    const { entry, error } = openKoersdagFor(request, params.id)
    if (error) return error
    const body = (await request.json()) as Body
    const hasAmount = 'amount' in body
    const hasWinnings = 'winnings' in body
    if (!hasAmount && !hasWinnings) return fail(400, 'Er is niets om te wijzigen.')
    const amount = hasAmount
      ? checkAmount(body.amount, 'Vul een inzet in van meer dan € 0.')
      : undefined
    if (amount instanceof Response) return amount
    const winnings =
      hasWinnings && body.winnings !== null
        ? checkAmount(body.winnings, 'Vul de uitbetaling in (0 als de inzet verloren is).', true)
        : null
    if (winnings instanceof Response) return winnings
    const bet = entry.koersdag.bets.find((b) => b.id === params.betId)
    if (!bet) return fail(404, 'Deze inzet bestaat niet (meer).')
    if (amount !== undefined) bet.amount = amount
    if (hasWinnings) bet.winnings = winnings
    entry.koersdag.updatedAt = new Date().toISOString()
    return HttpResponse.json(koersdagView(entry))
  }),

  http.delete(`${BASE}/koersdagen/:id/bets/:betId`, async ({ params, request }) => {
    await delay(LAG)
    const { entry, error } = openKoersdagFor(request, params.id)
    if (error) return error
    const { koersdag } = entry
    if (!koersdag.bets.some((b) => b.id === params.betId)) {
      return fail(404, 'Deze inzet bestaat niet (meer).')
    }
    koersdag.bets = koersdag.bets.filter((b) => b.id !== params.betId)
    koersdag.updatedAt = new Date().toISOString()
    return HttpResponse.json(koersdagView(entry))
  }),

  // ── Terugblik ─────────────────────────────────────────────────────────

  http.get(`${BASE}/terugblik`, async ({ request }) => {
    await delay(LAG)
    const { user, error } = authenticate(request)
    if (error) return error
    const koersdagen = (db.sessions[user.id] ?? [])
      .map(withBalance)
      .sort((a, b) => b.date.localeCompare(a.date))
    return HttpResponse.json({ koersdagen, totals: sumUp(koersdagen) })
  }),

  http.get(`${BASE}/terugblik/overview`, async ({ request }) => {
    await delay(LAG)
    const { error } = requireOwner(request)
    if (error) return error
    const perUser = db.users
      .filter((u) => u.status !== 'invited')
      .map((u) => ({ user: u, sessions: (db.sessions[u.id] ?? []).map(withBalance) }))
    return HttpResponse.json({
      users: perUser
        .map(({ user: u, sessions }) => ({
          id: u.id,
          name: u.name,
          role: u.role,
          koersdagen: sessions.length,
          ...sumUp(sessions),
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'nl')),
      koersdagen: perUser
        .flatMap(({ user: u, sessions }) =>
          sessions.map((s) => ({ ...s, userId: u.id, userName: u.name })),
        )
        .sort((a, b) => b.date.localeCompare(a.date) || a.userName.localeCompare(b.userName, 'nl')),
    })
  }),

  http.get(`${BASE}/terugblik/:id`, async ({ params, request }) => {
    await delay(LAG)
    const { entry, error } = finishedKoersdagFor(request, params.id)
    if (error) return error
    return HttpResponse.json(terugblikView(entry))
  }),

  http.post(`${BASE}/terugblik/:id/results/fetch`, async ({ params, request }) => {
    await delay(LAG)
    const { user, entry, error } = finishedKoersdagFor(request, params.id)
    if (error) return error
    const refused = startReviewStep(user, entry, 'results')
    if (refused) return refused
    return HttpResponse.json(terugblikView(entry), { status: 202 })
  }),

  http.post(`${BASE}/terugblik/:id/results/photo`, async ({ params, request }) => {
    await delay(LAG)
    const { user, entry, error } = finishedKoersdagFor(request, params.id)
    if (error) return error
    const body = (await request.json()) as Body
    if (
      typeof body.mediaType !== 'string' ||
      !['image/jpeg', 'image/png', 'image/webp'].includes(body.mediaType)
    ) {
      return fail(400, 'Gebruik een foto (JPG, PNG of WebP).')
    }
    const image = typeof body.image === 'string' ? body.image : ''
    if (!image) return fail(400, 'Maak eerst een foto van het uitslagbord.')
    if (image.length > MAX_PHOTO_BASE64) {
      return fail(
        413,
        'De foto is te groot. Probeer het opnieuw; de app verkleint de foto automatisch.',
      )
    }
    if (!sniffBase64(image)) return fail(400, 'Dit bestand is geen foto. Probeer het opnieuw.')
    const refused = startReviewStep(user, entry, 'photo')
    if (refused) return refused
    return HttpResponse.json(terugblikView(entry), { status: 202 })
  }),

  // Confirms the uitslagen and starts the evaluation; when the AI can't start, the uitslagen
  // stay confirmed and the evaluation can follow later
  http.put(`${BASE}/terugblik/:id/results`, async ({ params, request }) => {
    await delay(LAG)
    const { user, entry, error } = finishedKoersdagFor(request, params.id)
    if (error) return error
    const body = (await request.json()) as Body
    const results = readResults(body.results)
    if (typeof results === 'string') return fail(400, results)
    const review = reviewOf(entry)
    if (review.status === 'thinking') return fail(409, REVIEW_BUSY)
    Object.assign(review, {
      results,
      resultsConfirmedAt: new Date().toISOString(),
      evaluation: null,
    })
    const refused = startReviewStep(user, entry, 'evaluate')
    if (refused) {
      const { message } = (await refused.json()) as { message: string }
      Object.assign(review, { status: 'error', error: message, step: 'evaluate' })
      writeSession(entry)
      return HttpResponse.json(terugblikView(entry))
    }
    return HttpResponse.json(terugblikView(entry), { status: 202 })
  }),

  http.post(`${BASE}/terugblik/:id/evaluate`, async ({ params, request }) => {
    await delay(LAG)
    const { user, entry, error } = finishedKoersdagFor(request, params.id)
    if (error) return error
    const review = reviewOf(entry)
    const refused = startReviewStep(user, entry, 'evaluate', () => {
      if (!review.resultsConfirmedAt || !review.results?.length) {
        return fail(409, 'Bevestig eerst de uitslagen.')
      }
    })
    if (refused) return refused
    return HttpResponse.json(terugblikView(entry), { status: 202 })
  }),

  http.patch(`${BASE}/terugblik/:id/bets/:betId`, async ({ params, request }) => {
    await delay(LAG)
    const { entry, error } = finishedKoersdagFor(request, params.id)
    if (error) return error
    const body = (await request.json()) as Body
    const hasAmount = 'amount' in body
    const hasWinnings = 'winnings' in body
    if (!hasAmount && !hasWinnings) return fail(400, 'Er is niets om te wijzigen.')
    const amount = hasAmount
      ? checkAmount(body.amount, 'Vul een inzet in van meer dan € 0.')
      : undefined
    if (amount instanceof Response) return amount
    const winnings =
      hasWinnings && body.winnings !== null
        ? checkAmount(body.winnings, 'Vul de uitbetaling in (0 als de inzet verloren is).', true)
        : null
    if (winnings instanceof Response) return winnings
    const bet = entry.koersdag.bets.find((b) => b.id === params.betId)
    if (!bet) return fail(404, 'Deze inzet bestaat niet (meer).')
    if (amount !== undefined) bet.amount = amount
    if (hasWinnings) bet.winnings = winnings
    entry.koersdag.updatedAt = new Date().toISOString()
    writeSession(entry)
    return HttpResponse.json(terugblikView(entry))
  }),

  http.get(`${BASE}/lessons`, async ({ request }) => {
    await delay(LAG)
    const { error } = requireOwner(request)
    if (error) return error
    return HttpResponse.json({ lessons: structuredClone(terugblikDb.lessons) })
  }),

  http.delete(`${BASE}/lessons/:id`, async ({ params, request }) => {
    await delay(LAG)
    const { error } = requireOwner(request)
    if (error) return error
    const index = terugblikDb.lessons.findIndex((l) => l.id === params.id)
    if (index < 0) return fail(404, 'Deze les bestaat niet (meer).')
    terugblikDb.lessons.splice(index, 1)
    return HttpResponse.json({ ok: true })
  }),

  // ── OAuth ─────────────────────────────────────────────────────────────

  http.get(`${BASE}/oauth/authorize`, async ({ request }) => {
    await delay(LAG)
    const { user, error } = authenticate(request)
    if (error) return error
    const query = Object.fromEntries(new URL(request.url).searchParams)
    const scopes = checkAuthorize(user, query)
    if (scopes instanceof Response) return scopes
    const consent: OAuthConsent = {
      client: { name: MOCK_OAUTH_CLIENT.name, redirectHost: new URL(query.redirect_uri!).host },
      scopes: scopes.map((scope) => ({ scope, description: OAUTH_SCOPES[scope] })),
    }
    return HttpResponse.json(consent)
  }),

  http.post(`${BASE}/oauth/authorize`, async ({ request }) => {
    await delay(LAG)
    const { user, error } = authenticate(request)
    if (error) return error
    const body = (await request.json()) as Body
    const scopes = checkAuthorize(user, body)
    if (scopes instanceof Response) return scopes
    const uri = body.redirect_uri as string
    const redirectTo =
      body.approve === true
        ? oauthRedirect(uri, { code: 'mock-oauth-code', state: body.state })
        : oauthRedirect(uri, { error: 'access_denied', state: body.state })
    return HttpResponse.json({ redirectTo })
  }),
]
