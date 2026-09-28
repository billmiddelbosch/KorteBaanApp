import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { eventLinks, parseEventPage } from './kbbond'
import { pdfLines, toLines, type PdfItem } from './pdf'
import { parseRitverloop } from './ritverloop'
import { garbledMatcher, nameKey, parseEuro } from './text'
import { parseUitslagPdf } from './uitslagPdf'

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name))
const lines = (name: string) =>
  toLines((JSON.parse(fixture(name).toString()) as [number, number, string][][]).map((page) => page.map(([x, y, s]): PdfItem => ({ x, y, s }))))

describe('parseEventPage', () => {
  const page = parseEventPage(fixture('event-tzand-2025.html').toString())!

  it('reads place, date, pdf links and coordinates', () => {
    expect(page.place).toBe("'t Zand")
    expect(page.date).toBe('2025-10-13')
    expect(page.pdfs.uitslag).toBe("https://kortebaanbond.nl/storage/20251013-uitslag-kb-'t-zand.pdf")
    expect(page.pdfs.ritverloop).toBe("https://kortebaanbond.nl/storage/20251013-ritverloop-'t-zand.pdf")
    expect(page.pdfs.startlijst).toContain('programma-kortebaan')
    expect(page.coords).toEqual({ lat: 52.83427790468401, lon: 4.756151259255544 })
  })

  it('reads the placed horses with kortebaanbond ids and shares a tied place', () => {
    expect(page.uitslag).toHaveLength(6)
    expect(page.uitslag[0]).toEqual({
      place: 1,
      horse: 'Onse Cavallo',
      kbbHorseId: 158,
      pikeur: 'Krista Timmer',
      kbbRiderId: 14,
      punten: 5,
      prijs: 2500,
    })
    expect(page.uitslag.map((r) => r.place)).toEqual([1, 2, 3, 4, 4, 4])
  })

  it('reads the statistieken since 2009, including cancelled years', () => {
    expect(page.stats).toHaveLength(17)
    expect(page.stats[0]).toEqual({
      year: 2025,
      date: '2025-10-13',
      starters: 24,
      uitloters: 3,
      totalisator: 46612,
      winner: 'Onse Cavallo',
      rider: 'Krista Timmer',
      cancelled: false,
      note: null,
    })
    expect(page.stats.find((s) => s.year === 2020)).toMatchObject({ cancelled: true, date: null, winner: null })
    expect(page.stats.find((s) => s.year === 2021)?.date).toBe('2021-10-09')
  })

  it('lists the edities and event links', () => {
    expect(page.edities.map((e) => e.path)).toEqual([
      '/events/108/tzand-2026',
      '/events/53/tzand-2025',
      '/events/16/kb-tzand-2024',
      '/events/78/tzand-2023',
    ])
    expect(eventLinks('<a href="/events/109/kb-assendelft">x</a><a href="/events/109/kb-assendelft">y</a>')).toEqual([
      { id: 109, path: '/events/109/kb-assendelft' },
    ])
  })

  it('handles a future editie without results', () => {
    const future = parseEventPage(fixture('event-tzand-2026.html').toString())!
    expect(future.date).toBe('2026-10-12')
    expect(future.uitslag).toEqual([])
    expect(future.pdfs.ritverloop).toBeUndefined()
  })

  it('rejects a page that is not an event', () => {
    expect(parseEventPage('<title>Not Found</title>')).toBeNull()
  })
})

describe('parseRitverloop', () => {
  it('reads the 2023 omlopen, koppels, ritten and uitslag', () => {
    const r = parseRitverloop(lines('ritverloop-tzand-2023.json'))
    expect(r.omzet).toBe(33906)
    expect(r.date).toBe('2023-10-09')
    expect(r.omlopen.map((o) => o.rows.length)).toEqual([24, 12, 6, 4, 4])
    expect(r.omlopen.at(-1)!.beslissend).toBe(true)

    const first = r.omlopen[0]!
    expect(first.koppels).toHaveLength(12)
    // Candy Blue Chip (2) beat Joep Swagerman (1) in two straight rits
    expect(first.koppels[0]).toEqual({ nr: 1, a: 1, b: 2, ritten: [2, 2], winner: 2 })
    // X marks printed between the name lines: Bankrobber (8) beat Lois Lane (7)
    expect(first.koppels[3]!.winner).toBe(8)
    // Three rits: Medusa J (16) won I and III, Cezar H (15) won II
    expect(first.koppels[7]).toEqual({ nr: 8, a: 15, b: 16, ritten: [16, 15, 16], winner: 16 })
    // Cotton Eye Joe (24) won II and III from the X line below
    expect(first.koppels[11]).toEqual({ nr: 12, a: 23, b: 24, ritten: [23, 24, 24], winner: 24 })

    // Every koppel has a winner, and each winner reaches the next omloop
    for (const [i, omloop] of r.omlopen.entries()) {
      for (const k of omloop.koppels) expect(k.winner).not.toBeNull()
      const next = r.omlopen[i + 1]
      if (next && !next.beslissend) {
        const startnrs = next.rows.map((row) => row.startnr)
        for (const k of omloop.koppels) expect(startnrs).toContain(k.winner)
      }
    }

    const vierde = r.omlopen[3]!
    expect(vierde.rows.find((row) => row.name === 'Candy Blue Chip')).toMatchObject({ startnr: 2, pos: 2, bijgeloot: true })

    expect(r.uitslag.map((u) => [u.place, u.name, u.prijs])).toEqual([
      [1, 'Cassidy Byd', 2500],
      [2, 'Candy Blue Chip', 1450],
      [3, 'Archange de Jiel', 900],
      [4, 'Southwind Raptor', 600],
      [5, 'Coktail Bar', 275],
      [5, 'Hampshire F Boko', 275],
    ])
  })

  it('reads the 2025 layout with another scale and a rider change', () => {
    const r = parseRitverloop(lines('ritverloop-tzand-2025.json'))
    expect(r.date).toBe('2025-10-13')
    expect(r.omlopen.map((o) => o.rows.length)).toEqual([24, 12, 6, 4, 4])
    expect(r.omlopen[0]!.koppels[0]).toEqual({ nr: 1, a: 1, b: 2, ritten: [2, 1, 2], winner: 2 })
    expect(r.omlopen[3]!.rows[0]).toMatchObject({ name: 'Fast Money As', riders: ['Aad Pools'] })
    expect(r.uitslag[1]).toMatchObject({ place: 2, name: 'Fast Money As', riders: ['Lindsey Pegram', 'Aad Pools'], prijs: 1450 })
    expect(r.omlopen.at(-1)!.koppels.map((k) => k.winner)).toEqual([23, 2])
  })
})

describe('parseUitslagPdf', () => {
  const check = (u: ReturnType<typeof parseUitslagPdf>) => {
    expect(u.date).toBe('2023-10-09')
    expect(u.prijzengeld).toBe(6000)
    expect(u.entries).toHaveLength(6)
    expect(u.entries[0]).toEqual({
      place: 1,
      name: 'Cassidy Byd',
      leeftijd: 7,
      geslacht: 'ruin',
      pikeur: 'Caroline Aalbers',
      bijgeloot: false,
      eigenaar: 'Familie Baron',
      afstand: 275,
    })
    expect(u.entries[1]).toMatchObject({ name: 'Candy Blue Chip', geslacht: 'merrie', pikeur: 'Mats Wester', bijgeloot: true })
    expect(u.entries[2]).toMatchObject({ pikeur: 'Rick Wester', eigenaar: 'Stal de Groningers' })
    expect(u.nietGeplaatst).toHaveLength(18)
    expect(u.nietGeplaatst[7]).toEqual({ name: 'Heine A0ack', afstand: 270 })
    expect(u.totalisator.omlopen[0]).toEqual({ omloop: 1, winnend: 6.3, plaats: [2.7, 2.7, 7.6], winscore: 15.15 })
    expect(u.totalisator).toMatchObject({ duo: 48.6, trio: 541.8, totaal: 33906 })
  }

  it('reads placed horses, niet geplaatst and totalisator', () => check(parseUitslagPdf(lines('uitslag-tzand-2023.json'))))

  it('reads the real pdf', async () => {
    check(parseUitslagPdf(await pdfLines(new Uint8Array(fixture('uitslag-tzand-2023.pdf')))))
  })

  it('matches garbled names to the clean spelling', () => {
    expect(garbledMatcher('King Fana_c').test('King Fanatic')).toBe(true)
    expect(garbledMatcher('Heine A0ack').test('Heine Attack')).toBe(true)
    expect(garbledMatcher('Co0on Eye Joe').test('Cotton Eye Joe')).toBe(true)
    expect(garbledMatcher('Kas Tro0atore').test('Kas Trottatore')).toBe(true)
    expect(garbledMatcher('King Fana_c').test('King Fanatics')).toBe(false)
  })
})

describe('text helpers', () => {
  it('normalises names and amounts', () => {
    expect(nameKey("Goah d’Isère")).toBe(nameKey("Goah d'Isere"))
    expect(nameKey('M.T. Tapdancer')).toBe('mttapdancer')
    expect(parseEuro('€46.612,00')).toBe(46612)
    expect(parseEuro('€ 33.906,-')).toBe(33906)
    expect(parseEuro('6,30')).toBe(6.3)
  })
})
