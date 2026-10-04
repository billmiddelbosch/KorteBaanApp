import { describe, expect, it } from 'vitest'
import { adviceTotals } from '../adviceTotals'
import type { Suggestion } from '@/types/koersdag'

const pick = (amount: number | null, expectedValue: number | null = null): Suggestion => ({
  id: 's',
  race: '',
  bet: '',
  amount,
  reasoning: '',
  changed: false,
  expectedValue,
})

describe('adviceTotals', () => {
  it('adds up the stake and the expected profit in euros', () => {
    expect(adviceTotals([pick(20, 0.28), pick(10, -0.1)])).toEqual({
      stake: 30,
      expectedProfit: 4.6,
      withoutOdds: 0,
    })
  })

  it('counts picks without a quota apart and skips picks without an amount', () => {
    expect(adviceTotals([pick(5), pick(5, 0.26), pick(null, 0.5)])).toEqual({
      stake: 10,
      expectedProfit: 1.3,
      withoutOdds: 1,
    })
  })

  it('has no expected profit when no pick has a quota', () => {
    expect(adviceTotals([pick(5)]).expectedProfit).toBeNull()
  })
})
