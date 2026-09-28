import { describe, expect, it } from 'vitest'
import { backtest, computeRatings, INITIAL, ratingIsPredictive, winChance, type Match } from './glicko'

describe('glicko', () => {
  it('gives equal horses 50% and flattens the chance with uncertainty', () => {
    expect(winChance(INITIAL, INITIAL)).toBeCloseTo(0.5)
    const strong = { rating: 1700, rd: 60, volatility: 0.06 }
    const weak = { rating: 1400, rd: 60, volatility: 0.06 }
    expect(winChance(strong, weak)).toBeGreaterThan(0.8)
    expect(winChance(strong, weak) + winChance(weak, strong)).toBeCloseTo(1)
    expect(winChance({ ...strong, rd: 300 }, { ...weak, rd: 300 })).toBeLessThan(winChance(strong, weak))
  })

  it('rates the horse that keeps winning higher and forecasts before each match', () => {
    const matches: Match[] = []
    for (let i = 0; i < 20; i++) matches.push({ date: `2024-0${1 + (i % 9)}-0${1 + (i % 9)}`, a: 'fleur', b: 'hessel', aWon: true })
    const run = computeRatings(matches)
    expect(run.current.get('fleur')!.rating).toBeGreaterThan(run.current.get('hessel')!.rating)
    expect(run.forecasts).toHaveLength(20)
    expect(run.forecasts[0]!.p).toBeCloseTo(0.5)
    expect(run.rows.every((r) => r.rd > 0 && r.rd <= 350)).toBe(true)
  })

  it('backtests from a date and only trusts ratings that clearly beat a coin flip', () => {
    const forecasts = [
      { date: '2023-06-01', p: 0.9, aWon: false },
      { date: '2024-06-01', p: 0.8, aWon: true },
      { date: '2024-07-01', p: 0.3, aWon: false },
    ]
    const b = backtest(forecasts, '2024-01-01')
    expect(b.matches).toBe(2)
    expect(b.brier).toBeCloseTo((0.04 + 0.09) / 2)
    expect(b.hitRate).toBe(1)
    expect(ratingIsPredictive(b)).toBe(false)
    expect(ratingIsPredictive({ ...b, matches: 150 })).toBe(true)
    expect(ratingIsPredictive({ ...b, matches: 150, brier: 0.245 })).toBe(false)
    expect(ratingIsPredictive(null)).toBe(false)
  })
})
