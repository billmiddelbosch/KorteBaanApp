// Shapes returned by the Koersdag API (lambda/src/koersdag.ts, lambda/src/lib/koersdag.ts)
import type { Draverij, LockedAdvice, Source } from './analyse'

export type KoersdagStatus = 'idle' | 'thinking' | 'error'
// fetch: the AI looked up the latest news online; photo: it checked a photo of the board
export type UpdateKind = 'fetch' | 'photo'

export interface Suggestion {
  id: string
  race: string
  bet: string
  amount: number | null
  reasoning: string
  // New or different compared to the previous advice
  changed: boolean
  // AI's chance (0–1) that the bet pays out; absent on older updates
  chance?: number | null
  // Board quota for this bet, when known
  odds?: number | null
  // Expected return per euro (chance × odds − 1); null without odds
  expectedValue?: number | null
  // Threshold quota, margin included (1.1 / chance): "Alleen inzetten bij quota ≥ …"
  minOdds?: number | null
}

export interface PhotoCheck {
  matches: boolean
  differences: string[]
}

export interface KoersdagUpdate {
  id: string
  omloop: number
  kind: UpdateKind
  createdAt: string
  findings: string[]
  verdict: 'first' | 'kept' | 'changed'
  changes: string[]
  photoCheck: PhotoCheck | null
  adviceNote: string
  advice: Suggestion[]
  isFinal: boolean
  sources: Source[]
}

export interface Bet {
  id: string
  omloop: number
  suggestionId: string | null
  bet: string
  amount: number
  // Paid out after the race (0 = lost); null = not filled in yet
  winnings: number | null
  createdAt: string
}

export interface Koersdag {
  id: string
  draverij: Draverij
  budget: number
  staked: number
  paidOut: number
  remaining: number
  omloop: number
  status: KoersdagStatus
  error: string | null
  step: UpdateKind | null
  updates: KoersdagUpdate[]
  bets: Bet[]
  lockedAdvice: LockedAdvice | null
  finishedAt: string | null
  updatedAt: string
}

export interface KoersdagOption {
  draverij: Draverij
  advice: LockedAdvice | null
}

export interface KoersdagToday {
  current: Koersdag | null
  options: KoersdagOption[]
  next: LockedAdvice | null
}
