// Turns the parsed sources of one draverij into a single record that the store writes.
// Entities are still names here; the store resolves them to ids (see resolve.ts).
import { slugify } from '../analysis'
import type { EventPage, StatRow } from './kbbond'
import type { Ritverloop } from './ritverloop'
import { garbledMatcher, looksGarbled, nameKey } from './text'
import type { Totalisator, UitslagPdf } from './uitslagPdf'

// How complete the history of a draverij is; a higher level never gets overwritten by a lower one
export type Detail = 'winnaar' | 'uitslag' | 'volledig'
export const DETAIL_RANK: Record<Detail, number> = { winnaar: 1, uitslag: 2, volledig: 3 }

export interface Ref {
  name: string
  kbbId?: number | null
}

export interface HorseRef extends Ref {
  geslacht?: string | null
  birthYear?: number | null
}

export interface DeelnameRecord {
  horse: HorseRef
  pikeur: Ref | null
  stal: string | null
  startnr: number | null
  afstand: number | null
  leeftijd: number | null
  bijgeloot: boolean
  omloopBereikt: number | null
  klassering: number | null
  prijs: number | null
  punten: number | null
}

export interface KoppelRecord {
  omloop: number
  nr: number
  beslissend: boolean
  a: string // horse name
  b: string | null
  pikeurA: string | null
  pikeurB: string | null
  bijgelootA: boolean
  bijgelootB: boolean
  winner: string | null
  ritten: string[] // winner per rit
}

export type SourceKind = 'kbb_event' | 'kbb_ritverloop_pdf' | 'kbb_uitslag_pdf' | 'kbb_statistieken' | 'open_meteo'

export const RELIABILITY: Record<SourceKind, number> = {
  kbb_ritverloop_pdf: 5,
  kbb_uitslag_pdf: 5,
  kbb_event: 5,
  kbb_statistieken: 4,
  open_meteo: 4,
}

export interface SourceRef {
  url: string
  kind: SourceKind
  title?: string
}

export interface DraverijRecord {
  id: string
  date: string
  baan: { id: string; name: string; lat: number | null; lon: number | null }
  detail: Detail
  starters: number | null
  uitloters: number | null
  omzet: number | null
  totalisator: Totalisator | null
  cancelled: boolean
  cancelReason: string | null
  kbbEventId: number | null
  source: SourceRef
  sources: SourceRef[]
  deelnames: DeelnameRecord[]
  koppels: KoppelRecord[]
}

const baanOf = (place: string, coords: EventPage['coords']) => ({
  id: slugify(place),
  name: place,
  lat: coords?.lat ?? null,
  lon: coords?.lon ?? null,
})

// Finds the horse in `names` that a name from another source means (exact key, else a garbled match)
export function matchName(name: string, names: string[]): string | null {
  const key = nameKey(name)
  const exact = names.find((n) => nameKey(n) === key)
  if (exact) return exact
  if (!looksGarbled(name)) return null
  const re = garbledMatcher(name)
  const hits = names.filter((n) => re.test(n))
  return hits.length === 1 ? hits[0]! : null
}

const birthYear = (date: string, leeftijd: number | null) => (leeftijd ? Number(date.slice(0, 4)) - leeftijd : null)

export function eventRecord(
  eventId: number,
  eventUrl: string,
  page: EventPage,
  pdfs: { ritverloop: Ritverloop | null; uitslag: UitslagPdf | null },
  place = page.place,
): DraverijRecord | null {
  const date = page.date ?? pdfs.ritverloop?.date ?? pdfs.uitslag?.date
  if (!date) return null
  const stat = page.stats.find((s) => s.date === date)
  const source: SourceRef = { url: eventUrl, kind: 'kbb_event', title: `${place} ${date}` }
  const sources: SourceRef[] = [source]
  if (pdfs.ritverloop && page.pdfs.ritverloop) sources.push({ url: page.pdfs.ritverloop, kind: 'kbb_ritverloop_pdf' })
  if (pdfs.uitslag && page.pdfs.uitslag) sources.push({ url: page.pdfs.uitslag, kind: 'kbb_uitslag_pdf' })

  const record: DraverijRecord = {
    id: `${date}-${slugify(place)}`,
    date,
    baan: baanOf(place, page.coords),
    detail: 'winnaar',
    starters: stat?.starters ?? null,
    uitloters: stat?.uitloters ?? null,
    omzet: pdfs.ritverloop?.omzet ?? pdfs.uitslag?.totalisator.totaal ?? stat?.totalisator ?? null,
    totalisator: pdfs.uitslag?.totalisator.omlopen.length ? pdfs.uitslag.totalisator : null,
    cancelled: false,
    cancelReason: null,
    kbbEventId: eventId,
    source,
    sources,
    deelnames: [],
    koppels: [],
  }

  const ritverloop = pdfs.ritverloop?.omlopen.length ? pdfs.ritverloop : null
  if (ritverloop) fillFromRitverloop(record, ritverloop)
  else if (pdfs.uitslag?.entries.length) fillFromUitslagPdf(record, pdfs.uitslag)
  else if (page.uitslag.length) {
    record.detail = 'uitslag'
    record.deelnames = page.uitslag.map((row) => emptyDeelname(row.horse, row.pikeur, { klassering: row.place }))
  } else if (stat?.winner) {
    record.deelnames = [emptyDeelname(stat.winner, stat.rider, { klassering: 1 })]
  } else return null

  // The uitslag pdf adds age, sex, eigenaar and bijloting of the placed horses
  if (pdfs.uitslag && record.detail === 'volledig') {
    const names = record.deelnames.map((d) => d.horse.name)
    for (const entry of pdfs.uitslag.entries) {
      const match = matchName(entry.name, names)
      const d = match ? record.deelnames.find((x) => x.horse.name === match) : undefined
      if (!d) continue
      d.leeftijd = entry.leeftijd
      d.horse.geslacht = entry.geslacht
      d.horse.birthYear = birthYear(date, entry.leeftijd)
      d.stal = entry.eigenaar
      d.bijgeloot ||= entry.bijgeloot
    }
  }

  // The event page's uitslag table adds the Kortebaanbond ids, punten and winsom
  const names = record.deelnames.map((d) => d.horse.name)
  for (const row of page.uitslag) {
    const match = matchName(row.horse, names)
    const d = match ? record.deelnames.find((x) => x.horse.name === match) : undefined
    if (!d) continue
    d.horse.kbbId = row.kbbHorseId
    if (d.pikeur && row.kbbRiderId && nameKey(d.pikeur.name) === nameKey(row.pikeur)) d.pikeur.kbbId = row.kbbRiderId
    d.punten = row.punten
    d.prijs ??= row.prijs
    d.klassering ??= row.place
  }
  record.starters ??= record.detail === 'volledig' ? record.deelnames.length : null
  return record
}

function emptyDeelname(horse: string, pikeur: string | null, extra: Partial<DeelnameRecord> = {}): DeelnameRecord {
  return {
    horse: { name: horse },
    pikeur: pikeur ? { name: pikeur } : null,
    stal: null,
    startnr: null,
    afstand: null,
    leeftijd: null,
    bijgeloot: false,
    omloopBereikt: null,
    klassering: null,
    prijs: null,
    punten: null,
    ...extra,
  }
}

function fillFromRitverloop(record: DraverijRecord, r: Ritverloop) {
  record.detail = 'volledig'
  const byStartnr = new Map<number, DeelnameRecord>()
  for (const omloop of r.omlopen) {
    for (const row of omloop.rows) {
      let d = byStartnr.get(row.startnr)
      if (!d) {
        d = emptyDeelname(row.name, row.riders[0] ?? null, { startnr: row.startnr, afstand: row.afstand })
        byStartnr.set(row.startnr, d)
        record.deelnames.push(d)
      }
      d.omloopBereikt = Math.max(d.omloopBereikt ?? 0, omloop.nr)
      d.bijgeloot ||= row.bijgeloot
    }
    const rowOf = (startnr: number | null) => omloop.rows.find((row) => row.startnr === startnr)
    for (const k of omloop.koppels) {
      const a = rowOf(k.a)!
      const b = rowOf(k.b)
      const nameOf = (startnr: number) => byStartnr.get(startnr)!.horse.name
      record.koppels.push({
        omloop: omloop.nr,
        nr: k.nr,
        beslissend: omloop.beslissend,
        a: a.name,
        b: b?.name ?? null,
        pikeurA: a.riders[0] ?? null,
        pikeurB: b?.riders[0] ?? null,
        bijgelootA: a.bijgeloot,
        bijgelootB: b?.bijgeloot ?? false,
        winner: k.winner === null ? null : nameOf(k.winner),
        ritten: k.ritten.map(nameOf),
      })
    }
  }
  for (const u of r.uitslag) {
    const d = (u.startnr !== null && byStartnr.get(u.startnr)) || record.deelnames.find((x) => nameKey(x.horse.name) === nameKey(u.name))
    if (!d) continue
    d.klassering = u.place
    d.prijs = u.prijs
  }
}

function fillFromUitslagPdf(record: DraverijRecord, u: UitslagPdf) {
  record.detail = 'uitslag'
  for (const e of u.entries) {
    record.deelnames.push(
      emptyDeelname(e.name, e.pikeur, {
        klassering: e.place,
        afstand: e.afstand,
        leeftijd: e.leeftijd,
        stal: e.eigenaar,
        bijgeloot: e.bijgeloot,
      }),
    )
    const d = record.deelnames.at(-1)!
    d.horse.geslacht = e.geslacht
    d.horse.birthYear = birthYear(record.date, e.leeftijd)
  }
  // Names of non-placed horses are only in the garbled font; keep them unless clearly garbled
  for (const n of u.nietGeplaatst) {
    if (looksGarbled(n.name)) continue
    record.deelnames.push(emptyDeelname(n.name, null, { afstand: n.afstand }))
  }
}

// One year of the "Statistieken" table: only the winner and totals
export function statRecord(place: string, coords: EventPage['coords'], stat: StatRow, eventUrl: string): DraverijRecord | null {
  if (!stat.date) return null
  const source: SourceRef = { url: `${eventUrl}#statistieken`, kind: 'kbb_statistieken', title: `Statistieken ${place}` }
  return {
    id: `${stat.date}-${slugify(place)}`,
    date: stat.date,
    baan: baanOf(place, coords),
    detail: 'winnaar',
    starters: stat.starters,
    uitloters: stat.uitloters,
    omzet: stat.totalisator,
    totalisator: null,
    cancelled: stat.cancelled,
    cancelReason: stat.note,
    kbbEventId: null,
    source,
    sources: [source],
    // A placeholder like "-" is no winner
    deelnames: stat.winner && nameKey(stat.winner) ? [emptyDeelname(stat.winner, stat.rider, { klassering: 1 })] : [],
    koppels: [],
  }
}
