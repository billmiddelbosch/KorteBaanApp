// Shapes returned by the Analyse API (lambda/src/analysis.ts, aiInstruction.ts)

export interface Draverij {
  // `<date>-<plaats-slug>`, e.g. 2026-10-03-wolvega
  id: string
  place: string
  date: string
}

export interface Source {
  url: string
  title: string
}

export interface AdvicePick {
  race: string
  bet: string
  amount: number | null
  reasoning: string
}

export interface AdviceProposal {
  summary: string
  budget: number | null
  picks: AdvicePick[]
}

export type ChatStatus = 'idle' | 'thinking' | 'error'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  sources: Source[]
  proposal: AdviceProposal | null
  createdAt: string
}

export interface LockedAdvice {
  draverij: Draverij
  messageId: string
  proposal: AdviceProposal
  lockedAt: string
}

export interface Chat {
  id: string
  draverij: Draverij
  status: ChatStatus
  error: string | null
  messages: ChatMessage[]
  advice: LockedAdvice | null
  updatedAt: string
}

export interface ChatSummary {
  id: string
  draverij: Draverij
  status: ChatStatus
  hasAdvice: boolean
  messageCount: number
  updatedAt: string
}

export interface AiInstruction {
  text: string
  isDefault: boolean
  updatedAt: string | null
  hasPrevious: boolean
  defaultText: string
}
