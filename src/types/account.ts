// Shapes returned by the Account API (lambda/src/me.ts, friends.ts, aiConnection.ts, auth.ts)

export type Role = 'owner' | 'friend'
export type AiStatus = 'connected' | 'error' | 'none'

export interface Me {
  id: string
  name: string
  username: string
  role: Role
  ai: {
    status: AiStatus
    usedToday: number
    // null = no limit (always for the owner)
    dailyLimit: number | null
  }
}

export interface AuthResponse {
  token: string
  user: Me
}

export type LinkType = 'invite' | 'reset'

export interface LinkInfo {
  type: LinkType
  name: string
  username: string | null
}

export interface IssuedLink {
  token: string
  type: LinkType
  expiresAt: string
}

export type FriendStatus = 'active' | 'paused' | 'invited' | 'expired'

export interface Friend {
  id: string
  name: string
  username: string | null
  status: FriendStatus
  lastActiveAt: string | null
  usedToday: number
  dailyLimit: number | null
  linkExpiresAt: string | null
}

export interface PlaySession {
  id: string
  date: string
  draverij: string
  staked: number
  paidOut: number
  balance: number
  // Terugblik: the AI evaluated this koersdag
  evaluated?: boolean
}

export interface SessionsOverview {
  sessions: PlaySession[]
  totals: { staked: number; paidOut: number; balance: number }
}

export interface AiConnection {
  status: AiStatus
  tokenHint: string | null
  connectedAt: string | null
  lastTestedAt: string | null
  lastError: string | null
  usage: {
    today: { userId: string; name: string; count: number; dailyLimit: number | null }[]
    days: { date: string; count: number }[]
  }
}
