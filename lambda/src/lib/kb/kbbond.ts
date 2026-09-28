// Event pages of the Kortebaanbond (https://kortebaanbond.nl/events/<id>/<slug>).
// One page per draverij-editie with: date and place, buttons to the pdf's (Startlijst, Uitslag,
// Rittenverloop), an "Uitslag" table of the placed horses with stable /horses/<id> and
// /riders/<id> links, a "Statistieken <plaats> sinds 2009" table (winner per year) and the
// "Edities" of the same kortebaan in other years.
import { decode, parseDutchDate, parseEuro, textOf } from './text'

export const KBB = 'https://kortebaanbond.nl'

export interface EventLink {
  id: number
  path: string // "/events/53/tzand-2025"
}

export interface UitslagRow {
  place: number | null // null: shares the place of the row above (tie)
  horse: string
  kbbHorseId: number | null
  pikeur: string
  kbbRiderId: number | null
  punten: number | null
  prijs: number | null
}

export interface StatRow {
  year: number
  date: string | null // null when cancelled without a date
  starters: number | null
  uitloters: number | null
  totalisator: number | null
  winner: string | null
  rider: string | null
  cancelled: boolean
  note: string | null
}

export interface EventPage {
  place: string
  date: string | null
  pdfs: { startlijst?: string; uitslag?: string; ritverloop?: string }
  uitslag: UitslagRow[]
  stats: StatRow[]
  edities: EventLink[]
  coords: { lat: number; lon: number } | null
}

export function eventLinks(html: string): EventLink[] {
  const found = new Map<number, EventLink>()
  for (const [, path, id] of html.matchAll(/href="(\/events\/(\d+)\/[a-z0-9-]+)"/gi)) {
    if (!found.has(Number(id))) found.set(Number(id), { id: Number(id), path: path! })
  }
  return [...found.values()]
}

const intOf = (text: string) => {
  const m = /-?\d+/.exec(text)
  return m ? Number(m[0]) : null
}

// Place from the <title> "KB 't Zand / 13 oktober 2025"
function placeOf(title: string): string {
  return title
    .split(' / ')[0]!
    .replace(/^(KB|Kortebaan(draverij)?)\s+/i, '')
    .trim()
}

function pdfLinks(html: string): EventPage['pdfs'] {
  const pdfs: EventPage['pdfs'] = {}
  for (const [, href, label] of html.matchAll(/<a[^>]*href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = decode(href!).replace(/^\//, `${KBB}/`)
    const text = `${textOf(label!)} ${url}`.toLowerCase()
    if (/ritverloop|rittenverloop/.test(text)) pdfs.ritverloop ??= url
    else if (/uitslag/.test(text)) pdfs.uitslag ??= url
    else if (/startlijst|programma/.test(text)) pdfs.startlijst ??= url
  }
  return pdfs
}

function rowsOf(table: string): string[][] {
  return [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(([, row]) =>
    [...row!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]!),
  )
}

function parseUitslagTable(html: string): UitslagRow[] {
  const at = html.search(/<h2[^>]*>\s*Uitslag\s*<\/h2>/i)
  if (at < 0) return []
  const table = /<table[\s\S]*?<\/table>/i.exec(html.slice(at))?.[0] ?? ''
  const rows: UitslagRow[] = []
  for (const cells of rowsOf(table)) {
    if (cells.length < 5) continue
    const horse = textOf(cells[1]!)
    if (!horse) continue
    rows.push({
      place: intOf(textOf(cells[0]!)),
      horse,
      kbbHorseId: intOf(/\/horses\/(\d+)/.exec(cells[1]!)?.[1] ?? ''),
      pikeur: textOf(cells[2]!),
      kbbRiderId: intOf(/\/riders\/(\d+)/.exec(cells[2]!)?.[1] ?? ''),
      punten: intOf(textOf(cells[3]!)),
      prijs: parseEuro(textOf(cells[4]!)),
    })
  }
  // A tie keeps the place of the row above it
  let last: number | null = null
  for (const row of rows) {
    if (row.place === null) row.place = last
    last = row.place
  }
  return rows
}

function parseStats(html: string): StatRow[] {
  const at = html.search(/Statistieken[^<]*sinds/i)
  if (at < 0) return []
  const end = html.indexOf('</div>', at)
  const rows: StatRow[] = []
  for (const cells of rowsOf(html.slice(at, end < 0 ? undefined : end))) {
    const texts = cells.map(textOf)
    const year = /^(\d{4})$/.exec(texts[0] ?? '')?.[1]
    if (!year) continue
    const [, starters = '', datum = '', tote = '', winner = '', rider = ''] = texts
    const day = /^(\d{1,2})-(\d{1,2})$/.exec(datum)
    const cancelled = /afgelast/i.test(texts.join(' '))
    rows.push({
      year: Number(year),
      date: day ? `${year}-${day[2]!.padStart(2, '0')}-${day[1]!.padStart(2, '0')}` : null,
      starters: intOf(starters),
      uitloters: intOf(/\((\d+)\s*uitl/i.exec(starters)?.[1] ?? ''),
      totalisator: tote ? parseEuro(tote) : null,
      winner: winner || null,
      rider: rider || null,
      cancelled,
      note: cancelled ? datum || null : null,
    })
  }
  return rows
}

function parseEdities(html: string): EventLink[] {
  const at = html.search(/<th>\s*Edities\s*<\/th>/i)
  if (at < 0) return []
  const table = /[\s\S]*?<\/table>/i.exec(html.slice(at))?.[0] ?? ''
  return eventLinks(table)
}

// The Google Maps embed is centred on the baan: "...!2d<lon>!3d<lat>..."
function coordsOf(html: string): EventPage['coords'] {
  const m = /!2d(-?\d+\.\d+)!3d(-?\d+\.\d+)/.exec(html)
  return m ? { lat: Number(m[2]), lon: Number(m[1]) } : null
}

export function parseEventPage(html: string): EventPage | null {
  const title = textOf(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
  if (!title.includes(' / ')) return null
  return {
    place: placeOf(title),
    date: parseDutchDate(title.split(' / ')[1] ?? ''),
    pdfs: pdfLinks(html),
    uitslag: parseUitslagTable(html),
    stats: parseStats(html),
    edities: parseEdities(html),
    coords: coordsOf(html),
  }
}
