// Kortebaankalender of the Kortebaanbond (https://kortebaanbond.nl/alle-kortebanen).
// The page holds one year: a heading "Alle kortebanen in <jaar>" followed by a table with
// one row per kortebaan: "za 9 mei" | "<a><strong>Assendelft</strong></a> (afgelast)" | "Meer info".

export const KALENDER_URL = 'https://kortebaanbond.nl/alle-kortebanen'

export interface KalenderEntry {
  place: string
  date: string
  cancelled: boolean
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mrt: 3,
  maa: 3,
  apr: 4,
  mei: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  okt: 10,
  nov: 11,
  dec: 12,
}

const decode = (text: string) =>
  text
    .replace(/&#0*39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&quot;/g, '"')

const textOf = (html: string) => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

export function parseKalender(html: string): KalenderEntry[] {
  const year = /Alle kortebanen in (\d{4})/i.exec(html)?.[1]
  if (!year) return []

  const entries: KalenderEntry[] = []
  for (const [, row] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]!)
    if (cells.length < 2) continue

    const day = /(\d{1,2})\s+([a-z]{3})/i.exec(textOf(cells[0]!))
    const month = day && MONTHS[day[2]!.toLowerCase()]
    if (!day || !month) continue

    const strong = /<strong[^>]*>([\s\S]*?)<\/strong>/i.exec(cells[1]!)
    const place = textOf(strong?.[1] ?? cells[1]!)
    if (!place) continue

    entries.push({
      place,
      date: `${year}-${String(month).padStart(2, '0')}-${day[1]!.padStart(2, '0')}`,
      cancelled: /afgelast/i.test(textOf(cells[1]!)),
    })
  }
  return entries
}

// The window of draverijen to keep: from today up to one year ahead
export function inWindow(date: string, today: string): boolean {
  const end = new Date(`${today}T12:00:00Z`)
  end.setUTCFullYear(end.getUTCFullYear() + 1)
  return date >= today && date <= end.toISOString().slice(0, 10)
}
