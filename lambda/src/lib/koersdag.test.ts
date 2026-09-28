import { describe, expect, it } from 'vitest'
import { toApiMessages } from './claude'
import { findOmlopen } from './zeturf'
import {
  buildKoersdagPrompt,
  parseBoard,
  parseKansen,
  parseUpdate,
  sniffImage,
  totals,
  type Bet,
  type BoardReading,
  type KoersdagRecord,
} from './koersdag'

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

describe('ZEturf', () => {
  const draverij = { id: '2026-09-23-sint-annaparochie', place: 'Sint-Annaparochie', date: '2026-09-23' }
  const link = (path: string) => `<a href="/nl/course-du-jour/2026-09-23/${path}">x</a>`
  const html = [
    link('R50C2-kortebaan-st-annaparochie-winnend-plaats-omloop-2'),
    link('R50C1-kortebaan-st-annaparochie-winnend-plaats-omloop-1'),
    link('R50C1-kortebaan-st-annaparochie-winnend-plaats-omloop-1'),
    link('R51C1-kortebaan-st-annaparochie-duo-trio-omloop-1'),
    link('R60C1-kortebaan-roden-winnend-plaats-omloop-1'),
    link('R53C1-jagersro-galopp-klass-3-handicap'),
    '<a href="/nl/course-du-jour/2026-09-24/R50C3-kortebaan-st-annaparochie-winnend-plaats-omloop-3">x</a>',
  ].join('')

  it('finds the Winnend & Plaats omlopen of this kortebaan on this date only', () => {
    expect(findOmlopen(html, draverij)).toEqual([
      { omloop: 1, url: 'https://www.zeturf.nl/nl/course-du-jour/2026-09-23/R50C1-kortebaan-st-annaparochie-winnend-plaats-omloop-1' },
      { omloop: 2, url: 'https://www.zeturf.nl/nl/course-du-jour/2026-09-23/R50C2-kortebaan-st-annaparochie-winnend-plaats-omloop-2' },
    ])
    expect(findOmlopen(html, { id: '2026-09-23-wolvega', place: 'Wolvega', date: '2026-09-23' })).toEqual([])
  })
})

describe('koersdag prompt', () => {
  const draverij = { id: '2026-09-23-sint-annaparochie', place: 'Sint-Annaparochie', date: '2026-09-23' }
  const record = { draverij, userId: 'me', budget: 50, bets: [], updates: [], omloop: 2 } as unknown as KoersdagRecord
  const omloop2 = { omloop: 2, url: 'https://www.zeturf.nl/nl/course-du-jour/2026-09-23/R50C2-x' }
  const reading = (userId: string, quota: string[]): BoardReading => ({
    id: 'r',
    omloop: 2,
    userId,
    readAt: '2026-09-23T12:05:00.000Z',
    quota,
    loting: [],
  })
  const prompt = (kind: 'fetch' | 'photo', extra: { board?: BoardReading[]; zeturf?: typeof omloop2[] | null; kennisbank?: string | null } = {}) =>
    buildKoersdagPrompt({ instruction: 'x', record, advice: undefined, today: '2026-09-23', kind, board: [], ...extra })

  it('points an online check at the ZEturf page of this omloop, without its quota', () => {
    const { text } = prompt('fetch', { zeturf: [{ ...omloop2, omloop: 1 }, omloop2] })
    expect(text).toContain(omloop2.url)
    expect(text).not.toContain('R50C1')
    expect(text).toContain('lees ze daar niet af')
  })

  it('says when ZEturf has no page for this omloop or could not be read', () => {
    expect(prompt('fetch', { zeturf: [{ ...omloop2, omloop: 1 }] }).text).toContain('biedt de 2e omloop (nog) niet aan')
    expect(prompt('fetch', { zeturf: null }).text).toContain('niet bereikbaar')
  })

  it('shares board readings from other visitors and forbids made-up quota without them', () => {
    const shared = prompt('fetch', {
      board: [reading('other', ['3 Fleur de Lis: winnend 3,2']), reading('me', ['3 Fleur de Lis: winnend 2,8'])],
    }).system
    expect(shared).toContain('Om 14:05 (foto van een andere bezoeker):')
    expect(shared).toContain('- 3 Fleur de Lis: winnend 3,2')
    expect(shared).toContain('(foto van deze gebruiker)')
    expect(prompt('fetch').system).toContain('verzin ze niet')
  })

  it('puts the kennisbank before the quotabord and asks for win chances per koppel', () => {
    const { system } = prompt('fetch', { kennisbank: '## Kennisbank (stand 2026-09-22)' })
    expect(system).toContain('## Kennisbank (stand 2026-09-22)')
    expect(system.indexOf('## Kennisbank')).toBeLessThan(system.indexOf('## Quotabord'))
    expect(system).toContain('"winkans_links"')
    expect(prompt('fetch').system).not.toContain('## Kennisbank')
  })

  it('asks a photo check to transcribe the board and leaves ZEturf out', () => {
    const { text } = prompt('photo')
    expect(text).toContain('"bord"')
    expect(text).not.toContain('zeturf.nl')
  })
})

describe('parseBoard', () => {
  it('reads the transcribed board and ignores an empty one', () => {
    const block = (bord: unknown) => `<koersdag>${JSON.stringify({ advies: { keuzes: [] }, bord })}</koersdag>`
    expect(parseBoard(block({ quota: ['3 Fleur: winnend 3,2', ''], loting: ['Koppel 1: A – B'] }))).toEqual({
      quota: ['3 Fleur: winnend 3,2'],
      loting: ['Koppel 1: A – B'],
    })
    expect(parseBoard(block({ quota: [], loting: [] }))).toBeNull()
    expect(parseBoard(block(null))).toBeNull()
    expect(parseBoard('geen blok')).toBeNull()
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

describe('parseKansen', () => {
  const reply = (kansen: unknown) => '<koersdag>' + JSON.stringify({ advies: { keuzes: [] }, kansen }) + '</koersdag>'

  it('reads valid win chances and numbers koppels without a number by position', () => {
    const kansen = parseKansen(
      reply([
        { koppel: 1, links: 'Fleur', rechts: 'Hessel', winkans_links: 0.6, quota_links: 2.4, quota_rechts: 0.5 },
        { links: 'Anna', rechts: 'Bert', winkans_links: 0.45 },
        { koppel: 3, links: 'Cor', rechts: 'Dirk', winkans_links: 1.4 },
        { koppel: 4, links: '', rechts: 'Eva', winkans_links: 0.5 },
      ]),
      2,
    )
    expect(kansen).toEqual([
      { omloop: 2, koppel: 1, links: 'Fleur', rechts: 'Hessel', winkansLinks: 0.6, quotaLinks: 2.4, quotaRechts: null },
      { omloop: 2, koppel: 2, links: 'Anna', rechts: 'Bert', winkansLinks: 0.45, quotaLinks: null, quotaRechts: null },
    ])
  })

  it('returns nothing without kansen', () => {
    expect(parseKansen(reply(undefined), 1)).toEqual([])
    expect(parseKansen('geen blok', 1)).toEqual([])
  })
})
