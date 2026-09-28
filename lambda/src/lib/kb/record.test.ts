import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseEventPage } from './kbbond'
import { toLines, type PdfItem } from './pdf'
import { eventRecord, matchName, statRecord } from './record'
import { parseRitverloop } from './ritverloop'
import { parseUitslagPdf } from './uitslagPdf'
import { parseWeather, weatherUrl } from './weather'

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name))
const lines = (name: string) =>
  toLines((JSON.parse(fixture(name).toString()) as [number, number, string][][]).map((page) => page.map(([x, y, s]): PdfItem => ({ x, y, s }))))

const URL_2025 = 'https://kortebaanbond.nl/events/53/tzand-2025'

describe('eventRecord', () => {
  const page = parseEventPage(fixture('event-tzand-2025.html').toString())!

  it('builds a full record from the rittenverloop, enriched with the event table', () => {
    const r = eventRecord(53, URL_2025, page, { ritverloop: parseRitverloop(lines('ritverloop-tzand-2025.json')), uitslag: null })!
    expect(r.id).toBe('2025-10-13-t-zand')
    expect(r.detail).toBe('volledig')
    expect(r.baan).toMatchObject({ id: 't-zand', name: "'t Zand", lat: 52.83427790468401 })
    expect(r.deelnames).toHaveLength(24)
    expect(r.koppels).toHaveLength(12 + 6 + 3 + 2 + 2)
    expect(r.starters).toBe(24)
    expect(r.uitloters).toBe(3)

    const winner = r.deelnames.find((d) => d.klassering === 1)!
    expect(winner).toMatchObject({ horse: { name: 'Onse Cavallo', kbbId: 158 }, pikeur: { name: 'Krista Timmer', kbbId: 14 }, punten: 5, prijs: 2500 })
    expect(winner.omloopBereikt).toBe(5)
    expect(r.koppels.every((k) => k.winner !== null && k.ritten.length >= 2)).toBe(true)
    expect(r.sources.map((s) => s.kind)).toEqual(['kbb_event', 'kbb_ritverloop_pdf'])
  })

  it('uses the kalender place for the id when given', () => {
    const r = eventRecord(53, URL_2025, page, { ritverloop: null, uitslag: null }, 'Zand')!
    expect(r.id).toBe('2025-10-13-zand')
    expect(r.detail).toBe('uitslag')
    expect(r.deelnames).toHaveLength(6)
  })

  it('falls back to the uitslag pdf and keeps only readable niet-geplaatst names', () => {
    const uitslag = parseUitslagPdf(lines('uitslag-tzand-2023.json'))
    const bare = { ...page, date: null, uitslag: [], stats: [] }
    const r = eventRecord(78, 'https://kortebaanbond.nl/events/78/tzand-2023', bare, { ritverloop: null, uitslag })!
    expect(r.date).toBe('2023-10-09')
    expect(r.detail).toBe('uitslag')
    expect(r.deelnames[0]).toMatchObject({ horse: { name: 'Cassidy Byd', geslacht: 'ruin', birthYear: 2016 }, stal: 'Familie Baron' })
    expect(r.deelnames.some((d) => d.horse.name === 'Heine A0ack')).toBe(false)
    expect(r.omzet).toBe(33906)
  })

  it('returns null for a future editie', () => {
    const future = parseEventPage(fixture('event-tzand-2026.html').toString())!
    expect(eventRecord(108, 'https://kortebaanbond.nl/events/108/tzand-2026', future, { ritverloop: null, uitslag: null })).toBeNull()
  })
})

describe('statRecord', () => {
  const page = parseEventPage(fixture('event-tzand-2025.html').toString())!

  it('keeps the winner of an older year', () => {
    const row = page.stats.find((s) => s.year === 2021)!
    const r = statRecord("'t Zand", page.coords, row, URL_2025)!
    expect(r).toMatchObject({ id: '2021-10-09-t-zand', detail: 'winnaar', cancelled: false })
    expect(r.deelnames).toHaveLength(1)
    expect(r.deelnames[0]!.klassering).toBe(1)
    expect(r.source.kind).toBe('kbb_statistieken')
  })

  it('skips a cancelled year without a date', () => {
    expect(statRecord("'t Zand", page.coords, page.stats.find((s) => s.year === 2020)!, URL_2025)).toBeNull()
  })
})

describe('matchName', () => {
  it('matches exact keys and unambiguous garbled names', () => {
    expect(matchName('ONSE CAVALLO', ['Onse Cavallo', 'Fast Money As'])).toBe('Onse Cavallo')
    expect(matchName('Heine A0ack', ['Heine Attack', 'Heine'])).toBe('Heine Attack')
    expect(matchName('Unknown', ['Onse Cavallo'])).toBeNull()
  })
})

describe('weather', () => {
  it('uses the archive for old dates and the forecast api for recent ones', () => {
    expect(weatherUrl(52.834, 4.756, '2021-10-09', '2026-09-28')).toMatch(/^https:\/\/archive-api\.open-meteo\.com\/v1\/archive\?/)
    const recent = weatherUrl(52.834, 4.756, '2026-09-21', '2026-09-28')
    expect(recent).toMatch(/^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/)
    expect(recent).toContain('start_date=2026-09-21')
    expect(recent).toContain('timezone=Europe%2FAmsterdam')
  })

  it('reads the day from the daily arrays', () => {
    const json = {
      daily: {
        time: ['2025-10-13'],
        temperature_2m_max: [15.2],
        temperature_2m_min: [9.1],
        precipitation_sum: [0.4],
        wind_speed_10m_max: [22.3],
        weather_code: [3],
      },
    }
    expect(parseWeather(json, '2025-10-13', 'u')).toEqual({ tempMax: 15.2, tempMin: 9.1, neerslagMm: 0.4, windKmh: 22.3, weercode: 3, sourceUrl: 'u' })
    expect(parseWeather(json, '2025-10-14', 'u')).toBeNull()
    expect(parseWeather({}, '2025-10-13', 'u')).toBeNull()
  })
})
