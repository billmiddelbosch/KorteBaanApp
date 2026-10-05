import type { Suggestion } from '@/types/koersdag'

export interface AdviceTotals {
  // All suggested amounts together
  stake: number
  // Expected profit in euros over the picks with a known quota (amount × expected value)
  expectedProfit: number | null
  // Picks with an amount but no quota: not in expectedProfit
  withoutOdds: number
}

const round = (n: number) => Math.round(n * 100) / 100

// The advice as a whole: what it costs and what it yields on average
export function adviceTotals(advice: Suggestion[]): AdviceTotals {
  const priced = advice.filter((s) => s.amount !== null)
  const valued = priced.filter((s) => s.expectedValue != null)
  return {
    stake: round(priced.reduce((sum, s) => sum + s.amount!, 0)),
    expectedProfit: valued.length
      ? round(valued.reduce((sum, s) => sum + s.amount! * s.expectedValue!, 0))
      : null,
    withoutOdds: priced.length - valued.length,
  }
}
