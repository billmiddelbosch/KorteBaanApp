import { describe, expect, it } from 'vitest'
import { toApiMessages } from './claude'
import { parseUpdate, sniffImage, totals, type Bet } from './koersdag'

let n = 0
const meta = (overrides: Partial<Parameters<typeof parseUpdate>[1]> = {}) => ({
  id: 'u-1',
  omloop: 2,
  kind: 'fetch' as const,
  createdAt: '2026-09-27T12:00:00.000Z',
  sources: [],
  hadAdvice: true,
  newId: () => `s-${++n}`,
  ...overrides,
})

const reply = (body: unknown) => `Kort verslag.\n<koersdag>${JSON.stringify(body)}</koersdag>`

describe('parseUpdate', () => {
  it('reads a kept advice', () => {
    const update = parseUpdate(
      reply({
        bevindingen: ['Geen afmeldingen'],
        oordeel: 'blijft staan',
        advies: {
          toelichting: 'Houd vast aan Fleur.',
          keuzes: [{ koers: '2e omloop', inzet: 'Winnaar: Fleur', bedrag: 10, onderbouwing: 'Vorm' }],
        },
      }),
      meta(),
    )
    expect(update).toMatchObject({
      id: 'u-1',
      omloop: 2,
      verdict: 'kept',
      changes: [],
      photoCheck: null,
      isFinal: false,
      findings: ['Geen afmeldingen'],
      adviceNote: 'Houd vast aan Fleur.',
    })
    expect(update?.advice).toEqual([
      { id: expect.stringMatching(/^s-/), race: '2e omloop', bet: 'Winnaar: Fleur', amount: 10, reasoning: 'Vorm', changed: false },
    ])
  })

  it('marks a changed advice and keeps the changes', () => {
    const update = parseUpdate(
      reply({
        oordeel: 'aangepast',
        wijzigingen: ['Hessel B erbij'],
        advies: { toelichting: 'Nieuw', keuzes: [{ inzet: 'Winnaar: Hessel B', nieuw: true }] },
        finale: true,
      }),
      meta(),
    )
    expect(update).toMatchObject({ verdict: 'changed', changes: ['Hessel B erbij'], isFinal: true })
    expect(update?.advice[0]).toMatchObject({ race: '', amount: null, changed: true })
  })

  it('is the first advice when there was none before', () => {
    const update = parseUpdate(reply({ oordeel: 'aangepast', advies: { toelichting: 'Start' } }), meta({ hadAdvice: false }))
    expect(update).toMatchObject({ verdict: 'first', advice: [] })
  })

  it('reads the photo check', () => {
    const differs = parseUpdate(
      reply({ advies: { keuzes: [] }, foto: { klopt: true, verschillen: ['Quota 3,2 → 4,1'] } }),
      meta({ kind: 'photo' }),
    )
    expect(differs?.photoCheck).toEqual({ matches: false, differences: ['Quota 3,2 → 4,1'] })
    const matches = parseUpdate(reply({ advies: { keuzes: [] }, foto: { klopt: true } }), meta({ kind: 'photo' }))
    expect(matches?.photoCheck).toEqual({ matches: true, differences: [] })
  })

  it('accepts a bare JSON object and skips picks without a bet', () => {
    const update = parseUpdate(`{"advies":{"keuzes":[{"inzet":""},{"inzet":"Plaats: Jan"}]}}`, meta())
    expect(update?.advice.map((s) => s.bet)).toEqual(['Plaats: Jan'])
  })

  it('returns null for unusable replies', () => {
    expect(parseUpdate('Ik weet het niet.', meta())).toBeNull()
    expect(parseUpdate(reply({ bevindingen: [] }), meta())).toBeNull()
    expect(parseUpdate('<koersdag>{kapot</koersdag>', meta())).toBeNull()
  })
})

describe('sniffImage', () => {
  it('recognises JPEG, PNG and WebP by their first bytes', () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('image/png')
    expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
  })

  it('rejects anything else', () => {
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="x"/>'))).toBeNull()
    expect(sniffImage(new Uint8Array([]))).toBeNull()
  })
})

describe('totals', () => {
  const bet = (amount: number, winnings: number | null): Bet => ({
    id: 'b',
    omloop: 1,
    suggestionId: null,
    bet: 'x',
    amount,
    winnings,
    createdAt: '',
  })

  it('counts stakes and payouts; an open bet pays nothing yet', () => {
    expect(totals({ budget: 50, bets: [bet(20, 45), bet(10, 0), bet(5.1, null)] })).toEqual({
      staked: 35.1,
      paidOut: 45,
      remaining: 59.9,
    })
    expect(totals({ budget: 25, bets: [] })).toEqual({ staked: 0, paidOut: 0, remaining: 25 })
  })
})

describe('toApiMessages with a photo', () => {
  it('puts the images before the text of the user turn', () => {
    expect(
      toApiMessages([{ role: 'user', text: 'Controleer het bord', images: [{ mediaType: 'image/png', data: 'AAAA' }] }]),
    ).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: 'Controleer het bord' },
        ],
      },
    ])
  })
})
