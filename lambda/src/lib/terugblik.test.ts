import { describe, expect, it } from 'vitest'
import type { KoersdagRecord } from './koersdag'
import { buildEvaluationPrompt, parseEvaluation, parseResults, readResults, RESULTS_NOT_FOUND, effectiveReviewStatus, emptyReview } from './terugblik'

const block = (tag: string, body: unknown) => `Toelichting.\n<${tag}>${JSON.stringify(body)}</${tag}>`

describe('parseResults', () => {
  it('reads uitslagen sorted by omloop and skips incomplete ones', () => {
    const raw = block('uitslagen', {
      gevonden: true,
      omlopen: [
        { omloop: 2, winnaar: 'Hessel B', plaatsen: '2e: Jan' },
        { omloop: 1, winnaar: ' Fleur ' },
        { omloop: 3, winnaar: '' },
      ],
    })
    expect(parseResults(raw)).toEqual([
      { omloop: 1, winner: 'Fleur', places: '' },
      { omloop: 2, winner: 'Hessel B', places: '2e: Jan' },
    ])
  })

  it('returns an empty list when the AI found nothing, null when unreadable', () => {
    expect(parseResults(block('uitslagen', { gevonden: false, omlopen: [] }))).toEqual([])
    expect(parseResults('Geen idee')).toBeNull()
    expect(parseResults('<uitslagen>{kapot</uitslagen>')).toBeNull()
    expect(RESULTS_NOT_FOUND).toContain('Vul ze zelf in')
  })
})

describe('parseEvaluation', () => {
  it('reads the oordeel, omlopen and at most five lessons', () => {
    const raw = block('evaluatie', {
      oordeel: 'Goede dag.',
      omlopen: [{ omloop: 1, klopte: 'ja', advies: 'Winnaar: Fleur', winnaar: 'Fleur', waarom: 'Sterk.' }],
      lessen: [
        'a',
        '',
        { tekst: 'b', paarden: ['Fleur', 3], pikeurs: ['J. Bakker'], baan: 'Wolvega' },
        { paarden: ['zonder tekst'] },
        'c',
        'd',
        'e',
        'f',
      ],
      lescontrole: [
        { id: '4f0c', oordeel: 'bevestigd' },
        { id: '9a1b', oordeel: 'misschien' },
        { oordeel: 'weerlegd' },
      ],
    })
    const parsed = parseEvaluation(raw, '2026-08-15T19:00:00.000Z')
    expect(parsed?.evaluation).toEqual({
      summary: 'Goede dag.',
      omlopen: [{ omloop: 1, correct: null, advice: 'Winnaar: Fleur', winner: 'Fleur', reason: 'Sterk.' }],
      createdAt: '2026-08-15T19:00:00.000Z',
    })
    expect(parsed?.lessons).toEqual([
      { tekst: 'a', paarden: [], pikeurs: [] },
      { tekst: 'b', paarden: ['Fleur'], pikeurs: ['J. Bakker'], baan: 'Wolvega' },
      { tekst: 'c', paarden: [], pikeurs: [] },
      { tekst: 'd', paarden: [], pikeurs: [] },
      { tekst: 'e', paarden: [], pikeurs: [] },
    ])
    expect(parsed?.checks).toEqual([{ id: '4f0c', oordeel: 'bevestigd' }])
  })

  it('rejects an empty evaluation', () => {
    expect(parseEvaluation(block('evaluatie', { oordeel: '', omlopen: [] }), '')).toBeNull()
    expect(parseEvaluation('niets', '')).toBeNull()
  })
})

describe('readResults', () => {
  it('validates what the user confirms', () => {
    expect(readResults([])).toBe('Vul de uitslag van minstens één omloop in.')
    expect(readResults([{ omloop: 2, winner: '' }])).toBe('Vul de winnaar van de 2e omloop in.')
    expect(readResults([{ omloop: 1, winner: 'A' }, { omloop: 1, winner: 'B' }])).toBe(
      'Elke omloop mag maar één keer voorkomen.',
    )
    expect(readResults([{ omloop: 2, winner: ' B ' }, { omloop: 1, winner: 'A', places: 'x' }])).toEqual([
      { omloop: 1, winner: 'A', places: 'x' },
      { omloop: 2, winner: 'B', places: '' },
    ])
  })
})

describe('effectiveReviewStatus', () => {
  it('reports a run that hangs too long as an error', () => {
    const review = { ...emptyReview(), status: 'thinking' as const, thinkingSince: '2026-08-15T19:00:00.000Z' }
    expect(effectiveReviewStatus(review, Date.parse('2026-08-15T19:01:00.000Z')).status).toBe('thinking')
    expect(effectiveReviewStatus(review, Date.parse('2026-08-15T19:30:00.000Z')).status).toBe('error')
  })
})

describe('buildEvaluationPrompt', () => {
  const record = {
    draverij: { id: '2026-08-15-wolvega', place: 'Wolvega', date: '2026-08-15' },
    userId: 'me',
    budget: 50,
    bets: [],
    updates: [],
    omloop: 1,
  } as unknown as KoersdagRecord
  const base = { instruction: 'x', record, advice: undefined, results: [{ omloop: 1, winner: 'Fleur', places: '' }] }

  it('adds the scorecard and lessons to check, and asks for a verdict per lesson', () => {
    const { system } = buildEvaluationPrompt({
      ...base,
      scorecard: '8 koppels met een vastgelegde winkans.',
      lessonsToCheck: ['[les abc] Links wint vaker'],
    })
    expect(system).toContain('## Voorspellingen tegen de uitslag (kennisbank)\n8 koppels')
    expect(system).toContain('## Te toetsen lessen')
    expect(system).toContain('- [les abc] Links wint vaker')
    expect(system).toContain('"lescontrole"')
  })

  it('leaves the kennisbank parts out without data', () => {
    const { system } = buildEvaluationPrompt(base)
    expect(system).not.toContain('kennisbank)')
    expect(system).not.toContain('lescontrole')
    expect(system).toContain('"paarden"')
  })
})
