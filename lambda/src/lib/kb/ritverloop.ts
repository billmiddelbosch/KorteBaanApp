// Rittenverloop-pdf of the Kortebaanbond: per omloop the horses in koppel order with afstand,
// rijder and an "X" under I / II / III for every rit won, followed by the UITSLAG.
//
// The x-scale differs per pdf, so columns are found per line instead of at fixed positions:
// the afstand is the 3-digit number (250–320); left of it the numbers and the name, right of it
// the rijder, and the X marks are matched to the nearest I/II/III header. X marks are sometimes
// printed a few points above or below the name; those go to the nearest name line.
//   Eerste omloop:  [koppelnr] startnr  naam  afstand  rijder  X X
//   Later omlopen:  [B|S] positie  loting(=startnr)  naam  afstand  rijder  X X   (B = bijgeloot)
// Some pdf's print the marks as a lowercase "x", and some put an unexplained "S" in the B column:
// a single capital letter left of the numbers is a marker, never part of the name. "NIET STARTER"
// in the rijder column means the horse did not start: no pikeur, and the opponent wins the koppel.
// Koppels are consecutive positions (1–2, 3–4, …); in the beslissende omloop 1–2 rijden om de
// 1e plaats, 3–4 om de 3e.
import { lineText, type PdfItem, type PdfLine } from './pdf'
import { cleanName, parseEuro } from './text'

export interface RitverloopRow {
  pos: number
  startnr: number
  name: string
  afstand: number
  riders: string[]
  bijgeloot: boolean
  nietGestart: boolean
  wins: number[] // rit numbers (1–3) won
}

export interface RitverloopKoppel {
  nr: number
  a: number // startnr
  b: number | null // null: no opponent (bye)
  ritten: number[] // startnr of the winner of rit 1, 2, 3 (as far as ridden)
  winner: number | null
}

export interface RitverloopOmloop {
  nr: number
  beslissend: boolean
  rows: RitverloopRow[]
  koppels: RitverloopKoppel[]
}

export interface RitverloopUitslag {
  place: number
  startnr: number | null
  name: string
  afstand: number | null
  riders: string[]
  prijs: number | null
}

export interface Ritverloop {
  omzet: number | null
  plaats: string | null
  date: string | null
  omlopen: RitverloopOmloop[]
  uitslag: RitverloopUitslag[]
}

const SECTION = /^(EERSTE|TWEEDE|DERDE|VIERDE|VIJFDE|ZESDE|BESLISSENDE|FINALE)\b.*OMLOOP/i
const isNum = (s: string) => /^\d+$/.test(s)
const isAfstand = (s: string) => isNum(s) && Number(s) >= 250 && Number(s) <= 320
// "x DH" = dead heat: both horses get the mark, so the rit counts for neither
const isMark = (s: string) => /^x( DH)?$/i.test(s)
const NIET_GESTART = /^niet\s+(starter|gestart)$/i

interface Placed {
  page: number
  y: number
  row: RitverloopRow
}

function afterLabel(line: PdfLine, label: RegExp): string | null {
  const i = line.items.findIndex((it) => label.test(it.s))
  if (i < 0) return null
  const inline = line.items[i]!.s.replace(label, '').trim()
  return inline || line.items[i + 1]?.s || null
}

export function parseRitverloop(lines: PdfLine[]): Ritverloop {
  const result: Ritverloop = { omzet: null, plaats: null, date: null, omlopen: [], uitslag: [] }
  let section: RitverloopOmloop | 'uitslag' | null = null
  let columns: number[] = [] // x of I, II, III
  const placed: Placed[] = []
  const looseX: { page: number; y: number; x: number }[] = []
  const ritOf = (x: number) => {
    if (columns.length < 3) return null
    let best = 0
    columns.forEach((c, i) => {
      if (Math.abs(c - x) < Math.abs(columns[best]! - x)) best = i
    })
    return best + 1
  }

  for (const line of lines) {
    const text = lineText(line)
    if (/OMZET:/i.test(text)) {
      const euro = text.split(/OMZET:/i)[1]!.split(/PLAATS:/i)[0]!
      result.omzet = parseEuro(euro)
    }
    if (/PLAATS:/i.test(text)) result.plaats = cleanName(text.split(/PLAATS:/i)[1]!.replace(/^'/, "'"))
    if (/DATUM:/i.test(text)) {
      const d = /(\d{1,2})-(\d{1,2})-(\d{4})/.exec(afterLabel(line, /DATUM:/i) ?? '')
      if (d) result.date = `${d[3]}-${d[2]!.padStart(2, '0')}-${d[1]!.padStart(2, '0')}`
    }
    if (SECTION.test(text)) {
      section = { nr: result.omlopen.length + 1, beslissend: /BESLISSENDE|FINALE/i.test(text), rows: [], koppels: [] }
      result.omlopen.push(section)
      continue
    }
    if (/^UITSLAG:/i.test(text)) {
      section = 'uitslag'
      continue
    }
    if (/Naam paard/i.test(text)) {
      // "I II III" or (2023) "1e 2e Kamprit"
      const cols = [/^(I|1e)$/i, /^(II|2e)$/i, /^(III|3e|Kamprit)$/i].map((c) => line.items.find((it) => c.test(it.s))?.x)
      if (cols.every((c) => c !== undefined)) columns = cols as number[]
      continue
    }
    if (!section) continue

    const afstand = line.items.find((it) => isAfstand(it.s))
    if (!afstand) {
      for (const it of line.items) if (isMark(it.s)) looseX.push({ page: line.page, y: line.y, x: it.x })
      continue
    }
    // A marker glued to the position ("S11") is split into the marker and the number
    const left = line.items
      .filter((it) => it.x < afstand.x)
      .flatMap((it) => {
        const glued = /^([A-Z])(\d+)$/.exec(it.s)
        return glued ? [{ ...it, s: glued[1]! }, { ...it, x: it.x + 1, s: glued[2]! }] : [it]
      })
    const right = line.items.filter((it) => it.x > afstand.x)
    const placeLabel = left.find((it) => /^\d+e:?$/i.test(it.s))
    // Some pdf's have no "UITSLAG:" heading; a place label ("1e:") only appears in the uitslag
    if (placeLabel) section = 'uitslag'
    const nums = left.filter((it) => isNum(it.s)).map((it) => Number(it.s))
    const firstNumX = Math.min(...left.filter((it) => isNum(it.s)).map((it) => it.x))
    const isMarker = (it: PdfItem) => /^[A-Z]$/.test(it.s) && it.x < firstNumX
    const name = cleanName(
      left
        .filter((it) => !isNum(it.s) && !isMarker(it) && it !== placeLabel)
        .map((it) => it.s)
        .join(' '),
    )
    if (!name) continue
    const euroAt = right.findIndex((it) => it.s.startsWith('€'))
    const riderItems = right.filter(
      (it, i) => !isMark(it.s) && (euroAt < 0 || i < euroAt) && (columns.length < 3 || it.x < columns[0]! - 4),
    )
    const riderText = cleanName(riderItems.map((it) => it.s).join(' '))
    const nietGestart = NIET_GESTART.test(riderText)
    const riders = nietGestart ? [] : riderText.split('/').map(cleanName).filter(Boolean)

    if (section === 'uitslag') {
      const euro = euroAt >= 0 ? right.slice(euroAt).map((it) => it.s).join('') : ''
      result.uitslag.push({
        place: Number(/\d+/.exec(placeLabel?.s ?? '')?.[0] ?? result.uitslag.length + 1),
        startnr: nums.at(-1) ?? null,
        name,
        afstand: Number(afstand.s),
        riders,
        prijs: euro ? parseEuro(euro) : null,
      })
      continue
    }

    const first = section.nr === 1
    const row: RitverloopRow = {
      pos: first ? (nums.at(-1) ?? section.rows.length + 1) : nums.length >= 2 ? nums[0]! : section.rows.length + 1,
      startnr: nums.at(-1) ?? section.rows.length + 1,
      name,
      afstand: Number(afstand.s),
      riders,
      bijgeloot: left.some((it) => it.s === 'B' && isMarker(it)),
      nietGestart,
      wins: [],
    }
    for (const it of right) {
      const rit = isMark(it.s) ? ritOf(it.x) : null
      if (rit && !row.wins.includes(rit)) row.wins.push(rit)
    }
    section.rows.push(row)
    placed.push({ page: line.page, y: line.y, row })
  }

  // X marks printed between two name lines belong to the nearest one
  for (const x of looseX) {
    let best: Placed | null = null
    for (const p of placed) {
      if (p.page !== x.page) continue
      if (!best || Math.abs(p.y - x.y) < Math.abs(best.y - x.y)) best = p
    }
    const rit = ritOf(x.x)
    if (best && rit && !best.row.wins.includes(rit)) best.row.wins.push(rit)
  }

  for (const omloop of result.omlopen) {
    for (const row of omloop.rows) row.wins.sort()
    omloop.koppels = koppelsOf(omloop.rows)
  }
  // No winner from the marks (1–1, a missing mark): the one who rode the next omloop won. Not
  // for the beslissende omloop, where the losers of the last koppels ride too.
  result.omlopen.forEach((omloop, i) => {
    const next = result.omlopen[i + 1]
    if (!next || next.beslissend) return
    const rode = new Set(next.rows.map((row) => row.startnr))
    for (const k of omloop.koppels) {
      if (k.winner !== null || k.b === null) continue
      const through = [k.a, k.b].filter((s) => rode.has(s))
      if (through.length === 1) k.winner = through[0]!
    }
  })
  return result
}

function koppelsOf(rows: RitverloopRow[]): RitverloopKoppel[] {
  const groups = new Map<number, RitverloopRow[]>()
  for (const row of rows) {
    const nr = Math.ceil(row.pos / 2)
    groups.set(nr, [...(groups.get(nr) ?? []), row])
  }
  return [...groups]
    .sort(([a], [b]) => a - b)
    .map(([nr, pair]) => {
      const [a, b] = pair.sort((x, y) => x.pos - y.pos)
      if (!b) return { nr, a: a!.startnr, b: null, ritten: [], winner: a!.startnr }
      const ritten: number[] = []
      for (let rit = 1; rit <= 3; rit++) {
        const aWon = a!.wins.includes(rit)
        const bWon = b.wins.includes(rit)
        if (aWon !== bWon) ritten.push(aWon ? a!.startnr : b.startnr)
      }
      const aWins = ritten.filter((s) => s === a!.startnr).length
      const bWins = ritten.length - aWins
      // Walkover: nothing was ridden and exactly one of the two did not start
      const walkover = !ritten.length && a!.nietGestart !== b.nietGestart ? (a!.nietGestart ? b.startnr : a!.startnr) : null
      const winner = aWins === bWins ? walkover : aWins > bWins ? a!.startnr : b.startnr
      return { nr, a: a!.startnr, b: b.startnr, ritten, winner }
    })
}
