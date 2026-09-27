// In-memory mock database used by MSW in dev mode and by the Playwright E2E suite.
// Keep the IDs, usernames, passwords and tokens stable — E2E tests rely on them.
// The state lives in the page, so every reload (and every Playwright test) starts fresh.

import type { AiConnection, LinkType, PlaySession, Role } from '@/types/account'
import type { Chat, Draverij, LockedAdvice } from '@/types/analyse'
import type { Koersdag } from '@/types/koersdag'
import type { Evaluation, Lesson, OmloopResult, ReviewStatus, ReviewStep } from '@/types/terugblik'

// Fake, dev-only values. Grouped under neutral keys so secret scanners don't mistake them
// for real credentials.
const fixtures = {
  user: 'mock-token-user',
  admin: 'mock-token-admin',
  login: 'geheim-wachtwoord',
  invite: 'mock-invite-valid',
  expiredInvite: 'mock-invite-expired',
  reset: 'mock-reset-valid',
} as const

// Session tokens seeded by the E2E `loginAs` fixture
export const TEST_TOKEN = fixtures.user
export const ADMIN_TOKEN = fixtures.admin

// Login credentials for the mock users (all share one password)
export const MOCK_PASSWORD = fixtures.login
export const OWNER_USERNAME = 'bill'
export const FRIEND_USERNAME = 'kees'
export const PAUSED_USERNAME = 'anouk'

// Invite/reset links (path segment after /uitnodiging/ or /herstel/)
export const INVITE_TOKEN = fixtures.invite
export const EXPIRED_INVITE_TOKEN = fixtures.expiredInvite
export const RESET_TOKEN = fixtures.reset

const DAY = 24 * 60 * 60 * 1000
const now = Date.now()
const ago = (ms: number) => new Date(now - ms).toISOString()

export interface MockUser {
  id: string
  name: string
  username: string | null
  role: Role
  status: 'active' | 'paused' | 'invited'
  password: string | null
  dailyLimit: number | null
  lastActiveAt: string | null
  link: { token: string; type: LinkType; expiresAt: number } | null
}

interface MockDb {
  users: MockUser[]
  sessions: Record<string, Omit<PlaySession, 'balance'>[]>
  usageToday: Record<string, number>
  usagePastDays: number[]
  ai: Pick<AiConnection, 'status' | 'tokenHint' | 'connectedAt' | 'lastTestedAt' | 'lastError'>
}

export const db: MockDb = {
  users: [
    {
      id: 'admin-1',
      name: 'Bill',
      username: OWNER_USERNAME,
      role: 'owner',
      status: 'active',
      password: MOCK_PASSWORD,
      dailyLimit: null,
      lastActiveAt: ago(0),
      link: null,
    },
    {
      id: 'user-1',
      name: 'Kees',
      username: FRIEND_USERNAME,
      role: 'friend',
      status: 'active',
      password: MOCK_PASSWORD,
      dailyLimit: 10,
      lastActiveAt: ago(40 * 60 * 1000),
      link: { token: RESET_TOKEN, type: 'reset', expiresAt: now + DAY },
    },
    {
      id: 'friend-paused',
      name: 'Anouk',
      username: PAUSED_USERNAME,
      role: 'friend',
      status: 'paused',
      password: MOCK_PASSWORD,
      dailyLimit: 5,
      lastActiveAt: ago(9 * DAY),
      link: null,
    },
    {
      id: 'friend-invited',
      name: 'Joost',
      username: null,
      role: 'friend',
      status: 'invited',
      password: null,
      dailyLimit: 10,
      lastActiveAt: null,
      link: { token: INVITE_TOKEN, type: 'invite', expiresAt: now + 6 * DAY },
    },
    {
      id: 'friend-expired',
      name: 'Marieke',
      username: null,
      role: 'friend',
      status: 'invited',
      password: null,
      dailyLimit: 10,
      lastActiveAt: null,
      link: { token: EXPIRED_INVITE_TOKEN, type: 'invite', expiresAt: now - DAY },
    },
  ],
  sessions: {
    'admin-1': [
      { id: 'sessie-3', date: ago(2 * DAY), draverij: 'Wolvega', staked: 40, paidOut: 62.5 },
      { id: 'sessie-2', date: ago(9 * DAY), draverij: 'Alkmaar', staked: 30, paidOut: 12 },
      { id: 'sessie-1', date: ago(16 * DAY), draverij: 'Schagen', staked: 25, paidOut: 25 },
    ],
  },
  usageToday: { 'admin-1': 6, 'user-1': 3 },
  usagePastDays: [4, 11, 0, 7, 15, 2],
  ai: {
    status: 'connected',
    tokenHint: '…Qx7a',
    connectedAt: ago(20 * DAY),
    lastTestedAt: ago(2 * 60 * 60 * 1000),
    lastError: null,
  },
}

const tokens: Record<string, string> = {
  [TEST_TOKEN]: 'user-1',
  [ADMIN_TOKEN]: 'admin-1',
}

export function userForToken(token: string): MockUser | undefined {
  const id = tokens[token]
  return db.users.find((u) => u.id === id)
}

let issued = 0

// A fresh session token for the user; `revokeOthers` mimics a password change/reset
export function issueToken(user: MockUser, revokeOthers = false): string {
  if (revokeOthers) {
    for (const [token, id] of Object.entries(tokens)) if (id === user.id) delete tokens[token]
  }
  const token = `mock-token-${user.id}-${++issued}`
  tokens[token] = user.id
  return token
}

export function userForLink(token: string): MockUser | undefined {
  return db.users.find((u) => u.link?.token === token && u.link.expiresAt > Date.now())
}

export function newLinkToken(): string {
  return `mock-link-${Math.random().toString(36).slice(2, 12)}`
}

// ── Analyse ───────────────────────────────────────────────────────────────

// Mock AI chats per user, keyed `${userId}/${draverijId}`. Draverij dates are relative to today,
// so their IDs change daily; E2E specs find them by place name.
export interface MockChat {
  userId: string
  countedDay: string | null
  // Identifies the pending AI turn, so a restart drops the old answer
  turn?: string
  chat: Chat
}

const dayFromNow = (days: number) => new Date(now + days * DAY).toISOString().slice(0, 10)
const draverij = (place: string, days: number): Draverij => {
  const date = dayFromNow(days)
  return { id: `${date}-${place.toLowerCase()}`, place, date }
}

// Today's draverij, for Koersdag
export const ALKMAAR = draverij('Alkmaar', 0)
export const WOLVEGA = draverij('Wolvega', 6)
export const HOLLANDSCHEVELD = draverij('Hollandscheveld', 13)
export const SCHAGEN = draverij('Schagen', 20)

export const MOCK_DEFAULT_INSTRUCTION = `Je bent expert op het gebied van kortebaandraverijen in Nederland. Je volgt meerjarig alle uitslagen en zoekt verbanden in hoe koersen gelopen en gewonnen worden: paarden, pikeurs, stallen, de baan en de omstandigheden. In je kansbepaling neem je ook de meest recente uitslagen en berichtgeving mee.

Werkwijze:
- Stel eerst een paar korte vragen: wat is het budget, hoeveel risico wil de gebruiker nemen, en zijn er paarden of pikeurs die extra meegewogen moeten worden?
- Zoek online naar het deelnemersveld, recente uitslagen en berichtgeving over deze draverij.
- Weeg alle inzetopties af binnen het budget en onderbouw elke keuze kort en concreet.
- Wees eerlijk over onzekerheid en zeg het als informatie ontbreekt of verouderd is.
- Schrijf in het Nederlands, kort en helder: de gebruiker leest op de telefoon.`

export const analyseDb: {
  draverijen: Draverij[]
  chats: Record<string, MockChat>
  advice: Record<string, LockedAdvice>
  instruction: { text: string; updatedAt: string | null; previous: string | null }
} = {
  draverijen: [ALKMAAR, WOLVEGA, HOLLANDSCHEVELD, SCHAGEN],
  chats: {
    [`user-1/${WOLVEGA.id}`]: {
      userId: 'user-1',
      countedDay: null,
      chat: {
        id: WOLVEGA.id,
        draverij: WOLVEGA,
        status: 'idle',
        error: null,
        advice: null,
        updatedAt: ago(3 * 60 * 60 * 1000),
        messages: [
          {
            id: 'm-wolvega-1',
            role: 'user',
            text: `Ik wil een inzetadvies voor de kortebaan in Wolvega.`,
            sources: [],
            proposal: null,
            createdAt: ago(3 * 60 * 60 * 1000 + 60_000),
          },
          {
            id: 'm-wolvega-2',
            role: 'assistant',
            text: 'Leuk, Wolvega! Voordat ik ga zoeken: wat is je budget voor de dag, en speel je liever op zeker of mag er wat risico in?',
            sources: [],
            proposal: null,
            createdAt: ago(3 * 60 * 60 * 1000),
          },
        ],
      },
    },
  },
  advice: {
    [`user-1/${ALKMAAR.id}`]: {
      draverij: ALKMAAR,
      messageId: 'm-alkmaar-advies',
      lockedAt: ago(DAY),
      proposal: {
        summary: 'Vooral de favorieten in de eerste omlopen, met een kleine gok in de finale.',
        budget: 50,
        picks: [
          {
            race: '1e omloop, koppel 3',
            bet: 'Winnaar: Fleur de Lis',
            amount: 20,
            reasoning: 'Won twee van de laatste drie koersen.',
          },
          {
            race: 'Finale',
            bet: 'Winnaar: Ilse van de Heide',
            amount: 10,
            reasoning: 'Buitenkans met hoge quote.',
          },
        ],
      },
    },
  },
  instruction: { text: MOCK_DEFAULT_INSTRUCTION, updatedAt: null, previous: null },
}

// ── Koersdag ──────────────────────────────────────────────────────────────

// Koersdagen per user, keyed `${userId}/${draverijId}`. Starts empty: every test starts one.
export interface MockKoersdag {
  userId: string
  countedDay: string | null
  // Identifies the pending AI update, so finishing drops the old answer
  run?: string
  koersdag: Omit<Koersdag, 'staked' | 'paidOut' | 'remaining' | 'lockedAdvice'>
}

export const koersdagDb: { koersdagen: Record<string, MockKoersdag> } = { koersdagen: {} }

// ── Terugblik ─────────────────────────────────────────────────────────────

// The review of a finished koersdag lives on its MockKoersdag, like the Lambda record
export interface MockReview {
  countedDay: string | null
  // Identifies the pending AI step
  run?: string
  status: ReviewStatus
  error: string | null
  step: ReviewStep | null
  results: OmloopResult[] | null
  resultsConfirmedAt: string | null
  evaluation: Evaluation | null
}

// Lessons in the shared kennisbank. Starts empty: an evaluation adds them.
export const terugblikDb: { reviews: Record<string, MockReview>; lessons: Lesson[] } = {
  reviews: {},
  lessons: [],
}
