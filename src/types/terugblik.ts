// Shapes returned by the Terugblik API (lambda/src/terugblik.ts, lambda/src/lib/terugblik.ts)
import type { Draverij } from './analyse'
import type { Role } from './account'
import type { Bet } from './koersdag'

export type ReviewStatus = 'idle' | 'thinking' | 'error'
// results: the AI looks up the uitslagen online; photo: it reads a photo; evaluate: the evaluation
export type ReviewStep = 'results' | 'photo' | 'evaluate'

export interface OmloopResult {
  omloop: number
  winner: string
  // Free text: "2. Fleur de Lis, 3. Beau Gamin"
  places: string
}

export interface OmloopEvaluation {
  omloop: number
  // null: no advice for this omloop
  correct: boolean | null
  advice: string
  winner: string
  reason: string
}

export interface Evaluation {
  summary: string
  omlopen: OmloopEvaluation[]
  createdAt: string
}

export interface TerugblikDetail {
  id: string
  draverij: Draverij
  budget: number
  staked: number
  paidOut: number
  balance: number
  bets: Bet[]
  finishedAt: string
  omloop: number
  status: ReviewStatus
  error: string | null
  step: ReviewStep | null
  results: OmloopResult[] | null
  resultsConfirmedAt: string | null
  evaluation: Evaluation | null
}

export interface Totals {
  staked: number
  paidOut: number
  balance: number
}

export interface TerugblikItem extends Totals {
  id: string
  date: string
  draverij: string
  evaluated: boolean
}

export interface TerugblikList {
  koersdagen: TerugblikItem[]
  totals: Totals
}

export interface OverviewUser extends Totals {
  id: string
  name: string
  role: Role
  koersdagen: number
}

export interface OverviewItem extends TerugblikItem {
  userId: string
  userName: string
}

export interface TerugblikOverview {
  users: OverviewUser[]
  koersdagen: OverviewItem[]
}

export interface Lesson {
  id: string
  text: string
  createdAt: string
  draverijId?: string
  place?: string
  date?: string
}
