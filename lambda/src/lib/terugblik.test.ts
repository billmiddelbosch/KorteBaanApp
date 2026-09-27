import { describe, expect, it } from 'vitest'
import { parseEvaluation, parseResults, readResults, RESULTS_NOT_FOUND, effectiveReviewStatus, emptyReview } from './terugblik'

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
      lessen: ['a', '', 'b', 'c', 'd', 'e', 'f'],
    })
    const parsed = parseEvaluation(raw, '2026-08-15T19:00:00.000Z')
    expect(parsed?.evaluation).toEqual({
      summary: 'Goede dag.',
      omlopen: [{ omloop: 1, correct: null, advice: 'Winnaar: Fleur', winner: 'Fleur', reason: 'Sterk.' }],
      createdAt: '2026-08-15T19:00:00.000Z',
    })
    expect(parsed?.lessons).toEqual(['a', 'b', 'c', 'd', 'e'])
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
