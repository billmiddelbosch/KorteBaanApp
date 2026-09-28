// Uitslag-pdf of the Kortebaanbond: the placed horses with age, sex, pikeur and eigenaar, the
// "Niet geplaatst" list with afstanden and the totalisator payouts. Its font drops ligatures
// ("Fana_c", "A0ack"), so names are matched against the rittenverloop with garbledMatcher.
import { lineText, type PdfLine } from './pdf'
import { cleanName, parseDutchDate, parseEuro } from './text'

export interface UitslagEntry {
  place: number
  name: string
  leeftijd: number | null
  geslacht: 'ruin' | 'merrie' | 'hengst' | null
  pikeur: string
  bijgeloot: boolean
  eigenaar: string | null
  afstand: number | null
}

export interface TotalisatorOmloop {
  omloop: number
  winnend: number | null
  plaats: number[]
  winscore: number | null
}

export interface Totalisator {
  omlopen: TotalisatorOmloop[]
  duo: number | null
  trio: number | null
  totaal: number | null
}

export interface UitslagPdf {
  date: string | null
  prijzengeld: number | null
  entries: UitslagEntry[]
  nietGeplaatst: { name: string; afstand: number | null }[]
  totalisator: Totalisator
}

const SEX = { r: 'ruin', m: 'merrie', h: 'hengst' } as const
const euros = (text: string) => [...text.matchAll(/€\s*([\d.]+(?:,(?:\d{1,2}|-))?)/g)].map((m) => parseEuro(m[1]!)!)

export function parseUitslagPdf(lines: PdfLine[]): UitslagPdf {
  const result: UitslagPdf = {
    date: null,
    prijzengeld: null,
    entries: [],
    nietGeplaatst: [],
    totalisator: { omlopen: [], duo: null, trio: null, totaal: null },
  }
  let block: 'top' | 'niet' | 'tote' = 'top'
  const niet: string[] = []

  for (const line of lines) {
    const text = lineText(line).replace(/\s+/g, ' ').trim()
    if (!result.date && /^UITSLAG/i.test(text)) result.date = parseDutchDate(text)
    if (/^Prijzen:/i.test(text)) result.prijzengeld = euros(text)[0] ?? null
    if (/^Niet geplaatst:?/i.test(text)) {
      block = 'niet'
      niet.push(text.replace(/^Niet geplaatst:?/i, ''))
      continue
    }
    if (/^Totalisator:?/i.test(text)) {
      block = 'tote'
      continue
    }

    if (block === 'niet') niet.push(text)
    else if (block === 'tote') {
      const tote = result.totalisator
      const omloop = /^(\d+)e omloop winnend/i.exec(text)
      if (omloop) {
        const [winnend = null, ...plaats] = euros(text)
        tote.omlopen.push({ omloop: Number(omloop[1]), winnend, plaats, winscore: null })
      } else if (/winscore/i.test(text) && tote.omlopen.length) {
        tote.omlopen.at(-1)!.winscore = euros(text)[0] ?? null
      } else if (/TOTAAL INZET/i.test(text)) {
        tote.totaal = euros(text)[0] ?? null
      } else {
        const duo = /Duo\s*€\s*([\d.,-]+)/i.exec(text)
        const trio = /Trio\s*€\s*([\d.,-]+)/i.exec(text)
        if (duo) tote.duo = parseEuro(duo[1]!)
        if (trio) tote.trio = parseEuro(trio[1]!)
      }
    } else {
      const entry = parseEntry(text)
      if (entry) result.entries.push(entry)
    }
  }

  for (const part of niet.join(' ').split(',')) {
    const m = /^(.*?)\s*(\d{3})?$/.exec(part.trim())
    if (m && m[1]) result.nietGeplaatst.push({ name: cleanName(m[1]), afstand: m[2] ? Number(m[2]) : null })
  }
  return result
}

// "2 – Candy Blue Chip (6m) – Mats Wester (BIJGELOOT) – Stal de Groningers 280"
function parseEntry(text: string): UitslagEntry | null {
  const m = /^(\d+)\s*[–—-]\s+(.+)$/.exec(text)
  if (!m) return null
  let rest = m[2]!
  const afstand = /\s(\d{3})$/.exec(rest)
  if (afstand) rest = rest.slice(0, afstand.index)
  const [horse = '', pikeur = '', ...owner] = rest.split(/\s*[–—]\s*/)
  const age = /\((\d+)\s*([rmh])\)/i.exec(horse)
  const bijgeloot = /\(BIJGELOOT\)/i.test(pikeur)
  const name = cleanName(horse.replace(/\(.*?\)/g, ''))
  if (!name) return null
  return {
    place: Number(m[1]),
    name,
    leeftijd: age ? Number(age[1]) : null,
    geslacht: age ? SEX[age[2]!.toLowerCase() as keyof typeof SEX] : null,
    pikeur: cleanName(pikeur.replace(/\(BIJGELOOT\)/i, '')),
    bijgeloot,
    eigenaar: owner.length ? cleanName(owner.join(' – ')) : null,
    afstand: afstand ? Number(afstand[1]) : null,
  }
}
