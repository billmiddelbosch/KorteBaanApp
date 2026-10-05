import { describe, expect, it } from 'vitest'
import { decayed, formatClaims, formatHorse, formatLessons, formatScorecard, formatSides, formatTrackRecord } from './dossier'
import type { ClaimRow } from './queries'

const claim = (text: string, observedAt: string, confidence = 0.8): ClaimRow => ({
  id: text,
  predicate: 'vorm',
  text,
  observedAt,
  validUntil: null,
  confidence,
  url: null,
  reliability: 2,
})

describe('dossier formatting', () => {
  it('halves the confidence of a claim per year and drops faded ones', () => {
    expect(decayed(0.8, '2025-09-28', '2026-09-28')).toBeCloseTo(0.4)
    const lines = formatClaims([claim('Oud', '2022-01-01'), claim('Vers', '2026-09-20', 0.6)], '2026-09-28')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('Vers [vorm, zekerheid 59%]')
  })

  it('shows a rating only when ratings are predictive', () => {
    const card = {
      name: 'Fleur de Lis',
      totals: { starts: 12, wins: 3, koppelsWon: 20, koppelsLost: 9, firstYear: 2022, lastYear: 2026 },
      starts: [],
      rating: { rating: 1650, rd: 70, volatility: 0.06, date: '2026-09-20' },
      claims: [],
    }
    expect(formatHorse(card, '2026-09-28', true)).toContain('Rating: 1650 ±70 (betrouwbaar')
    const without = formatHorse(card, '2026-09-28', false)
    expect(without).not.toContain('Rating')
    expect(without).toContain('12 starts, 3 dagoverwinningen, koppels 20-9 (2022–2026)')
    expect(without).toContain('geen starts in de kennisbank')
  })

  it('needs ten koppels for a side statistic and shows lesson ids', () => {
    expect(formatSides({ links: 4, rechts: 3 })).toBeNull()
    expect(formatSides({ links: 12, rechts: 8 })).toContain('60% links')
    const [line] = formatLessons([
      { id: 'abc', text: 'Links wint vaker bij nat weer', confidence: 0.6, createdAt: '2026-08-01', lastChecked: null, draverijId: null, scope: null },
    ])
    expect(line).toBe('[les abc] Links wint vaker bij nat weer (zekerheid 60%, 2026-08-01)')
  })

  it('summarises a scorecard, or nothing without scored koppels', () => {
    expect(formatScorecard({ koppels: 0, ai: null, rating: null, tote: null, misses: [] })).toBeNull()
    const text = formatScorecard({
      koppels: 8,
      ai: 0.19,
      rating: 0.22,
      tote: null,
      misses: [{ omloop: 1, horse: 'Fleur', opponent: 'Hessel', pAi: 0.7 }],
    })!
    expect(text).toContain('AI 0,19, rating 0,22, tote onbekend')
    expect(text).toContain('Omloop 1: Fleur kreeg 70% tegen Hessel en verloor.')
  })

  it('tells the AI to stay near the board until it has beaten the tote', () => {
    expect(formatTrackRecord(null)).toContain('nog niet getoetst')
    const few = formatTrackRecord({ koppels: 12, ai: 0.2, tote: 0.22 })
    expect(few).toContain('getoetst op 12 koppels met bekende quota: Brier 0,2, de tote 0,22')
    expect(few).toContain('te weinig')
    expect(formatTrackRecord({ koppels: 80, ai: 0.23, tote: 0.21 })).toContain('De tote voorspelt beter dan jij')
    expect(formatTrackRecord({ koppels: 80, ai: 0.19, tote: 0.21 })).toContain('afwijken van het bord is verdedigbaar')
  })
})
