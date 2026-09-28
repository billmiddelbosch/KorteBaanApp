import { describe, expect, it } from 'vitest'
import { DISPUTED_BELOW, nextConfidence, toteChance } from './write'

describe('kennisbank writes', () => {
  it('lets a confirmed lesson gain a little and a refuted one lose a lot', () => {
    expect(nextConfidence(0.5, 'bevestigd')).toBe(0.6)
    expect(nextConfidence(0.9, 'bevestigd')).toBe(0.95)
    expect(nextConfidence(0.5, 'weerlegd')).toBe(0.3)
    expect(nextConfidence(0.3, 'weerlegd')).toBeLessThan(DISPUTED_BELOW)
    expect(nextConfidence(0.1, 'weerlegd')).toBe(0)
  })

  it('derives the tote chance from both win quotes', () => {
    expect(toteChance(2, 2)).toBeCloseTo(0.5)
    expect(toteChance(1.5, 3)).toBeCloseTo(2 / 3)
    expect(toteChance(null, 3)).toBeNull()
    expect(toteChance(1, 3)).toBeNull()
  })
})
