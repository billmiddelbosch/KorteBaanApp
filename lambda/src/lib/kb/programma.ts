// Programma (startlijst) pdf of the Kortebaanbond, published a few days before the draverij:
//   Nr.  Paard  Lft-klr-gesl  Afstand Rijder  Trainer  Eigenaar  Fokker
//   7    * Go for Manny  8j.br.r  295 m  Caroline Aalbers  …        (* = unexplained marker)
// followed by "UITGELOOT:" and the reserves. The first omloop rides startnr 1–2, 3–4, …, so
// the programma gives the koppels of the first omloop before anything is ridden.
import { lineText, type PdfLine } from './pdf'
import { cleanName } from './text'

export interface ProgrammaEntry {
  startnr: number
  name: string
}

export interface Programma {
  date: string | null
  entries: ProgrammaEntry[]
}

export function parseProgramma(lines: PdfLine[]): Programma {
  const result: Programma = { date: null, entries: [] }
  let lft: number | null = null // x of the Lft-klr-gesl column: the name ends before it
  for (const line of lines) {
    const text = lineText(line)
    const d = /Datum:\s*(\d{1,2})-(\d{1,2})-(\d{4})/i.exec(text)
    if (d) result.date = `${d[3]}-${d[2]!.padStart(2, '0')}-${d[1]!.padStart(2, '0')}`
    if (/^UITGELOOT/i.test(text)) break
    const header = line.items.find((it) => /^Lft/i.test(it.s))
    if (header) {
      lft = header.x
      continue
    }
    const [first, ...rest] = line.items
    if (lft === null || !first || !/^\d+$/.test(first.s)) continue
    const name = cleanName(
      rest
        .filter((it) => it.x < lft! - 2 && it.s !== '*')
        .map((it) => it.s.replace(/^\*\s*/, ''))
        .join(' '),
    )
    if (name) result.entries.push({ startnr: Number(first.s), name })
  }
  return result
}

// Koppels of the first omloop: 1–2, 3–4, …; an odd last horse rides alone
export function firstOmloop(p: Programma): { koppel: number; a: string; b: string | null }[] {
  const byNr = new Map(p.entries.map((e) => [e.startnr, e.name]))
  const max = Math.max(0, ...byNr.keys())
  const koppels: { koppel: number; a: string; b: string | null }[] = []
  for (let nr = 1; 2 * nr - 1 <= max; nr++) {
    const a = byNr.get(2 * nr - 1)
    const b = byNr.get(2 * nr) ?? null
    if (a) koppels.push({ koppel: nr, a, b })
  }
  return koppels
}
