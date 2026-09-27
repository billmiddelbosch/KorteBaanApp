import { http, HttpResponse, delay } from 'msw'
import type { AiConnection, Friend, IssuedLink, LinkType, Me } from '@/types/account'
import { db, issueToken, newLinkToken, userForLink, userForToken, type MockUser } from './data'

// Mirrors the Lambda handlers in lambda/src (auth, me, friends, aiConnection):
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
]
