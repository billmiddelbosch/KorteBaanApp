// Formats kennisbank data as compact Dutch text for the AI: the dossier in the system prompt
// and the answers of the kennisbank tools. Pure, so the wording is testable.
import type { Backtest, Rating } from './glicko'
import type { Scorecard } from './write'
import type { ActiveHorse, BaanEdition, ClaimRow, HeadToHead, HorseTotals, LessonRow, PikeurYear, SearchHit, SideStats, Start } from './queries'

const HALF_LIFE_DAYS = 365

// A claim loses half its confidence per year: last season's form says less than last week's
export function decayed(confidence: number, observedAt: string, today: string): number {
  const age = Math.max(0, (Date.parse(today) - Date.parse(observedAt)) / 86_400_000)
  return confidence * 0.5 ** (age / HALF_LIFE_DAYS)
}

const pct = (p: number) => `${Math.round(p * 100)}%`
const num = (n: number | null, unit: string) => (n === null ? null : `${Math.round(n * 10) / 10}${unit}`)

export function formatStart(s: Start): string {
  const result =
    s.klassering === 1
      ? 'winnaar'
      : s.klassering
        ? `${s.klassering}e`
        : s.omloopBereikt
          ? `t/m ${s.omloopBereikt}e omloop`
          : s.detail === 'winnaar'
            ? 'uitslag onbekend'
            : 'niet geplaatst'
  const koppels = s.won + s.lost ? `, koppels ${s.won}-${s.lost}` : ''
  return `${s.date} ${s.baan}: ${result}${koppels}${s.pikeur ? ` (${s.pikeur})` : ''}${s.bijgeloot ? ', bijgeloot' : ''}`
}

export function formatClaims(claims: ClaimRow[], today: string, max = 8): string[] {
  return claims
    .map((c) => ({ c, weight: decayed(c.confidence, c.observedAt, today) }))
    .filter((x) => x.weight >= 0.1)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, max)
    .map(({ c, weight }) => `${c.observedAt}: ${c.text} [${c.predicate}, zekerheid ${pct(weight)}${c.url ? `, bron ${c.url}` : ''}]`)
}

export function formatRating(r: Rating & { date: string }): string {
  const certainty = r.rd < 90 ? 'betrouwbaar' : r.rd < 160 ? 'redelijk' : 'onzeker'
  return `${Math.round(r.rating)} ±${Math.round(r.rd)} (${certainty}, na ${r.date})`
}

export interface HorseCard {
  name: string
  totals: HorseTotals
  starts: Start[]
  rating: (Rating & { date: string }) | null
  claims: ClaimRow[]
}

export function formatHorse(card: HorseCard, today: string, showRating: boolean): string {
  const t = card.totals
  const lines = [`### ${card.name}`]
  const span = t.firstYear ? ` (${t.firstYear === t.lastYear ? t.firstYear : `${t.firstYear}–${t.lastYear}`})` : ''
  lines.push(`${t.starts} starts, ${t.wins} dagoverwinningen, koppels ${t.koppelsWon}-${t.koppelsLost}${span}`)
  if (showRating && card.rating) lines.push(`Rating: ${formatRating(card.rating)}`)
  if (card.starts.length) lines.push(...card.starts.map((s) => `- ${formatStart(s)}`))
  else lines.push('- geen starts in de kennisbank')
  const claims = formatClaims(card.claims, today, 5)
  if (claims.length) lines.push('Losse feiten:', ...claims.map((c) => `- ${c}`))
  return lines.join('\n')
}

export function formatHeadToHead(a: string, b: string, meetings: HeadToHead[]): string {
  if (!meetings.length) return `${a} en ${b} liepen niet eerder tegen elkaar in de kennisbank.`
  const winsA = meetings.filter((m) => m.winner === a).length
  const winsB = meetings.filter((m) => m.winner === b).length
  return `Onderling ${a}–${b}: ${winsA}-${winsB}. ${meetings
    .slice(0, 5)
    .map((m) => `${m.date} ${m.baan} ${m.omloop}e omloop: ${m.winner ?? '?'}`)
    .join('; ')}`
}

export function formatMatchup(input: {
  a: string
  b: string
  known: { a: boolean; b: boolean }
  pRating: number | null
  meetings: HeadToHead[]
}): string {
  const { a, b } = input
  const unknown = [!input.known.a && a, !input.known.b && b].filter(Boolean)
  const lines = [`## ${a} – ${b}`]
  if (unknown.length) lines.push(`Niet in de kennisbank: ${unknown.join(', ')} (nieuw paard of andere schrijfwijze).`)
  if (input.pRating !== null) lines.push(`Ratingkans ${a}: ${pct(input.pRating)}, ${b}: ${pct(1 - input.pRating)}`)
  lines.push(formatHeadToHead(a, b, input.meetings))
  return lines.join('\n')
}

export function formatPikeur(name: string, years: PikeurYear[]): string {
  if (!years.length) return `${name}: geen koppels in de kennisbank.`
  return [
    `### ${name}`,
    ...years.map(
      (y) =>
        `- ${y.year}: ${y.dayWins} dagoverwinningen${y.koppels ? `, koppels ${y.won}/${y.koppels} gewonnen (${pct(y.won / y.koppels)})` : ''}`,
    ),
  ].join('\n')
}

export function formatEdition(e: BaanEdition): string {
  if (e.cancelled) return `${e.date}: afgelast`
  const weather = [num(e.tempMax, '°C'), e.neerslagMm !== null ? `${num(e.neerslagMm, ' mm')} regen` : null, num(e.windKmh, ' km/u wind')]
    .filter(Boolean)
    .join(', ')
  return `${e.date}: ${e.winner ? `winnaar ${e.winner}${e.pikeur ? ` (${e.pikeur})` : ''}` : 'winnaar onbekend'}${e.starters ? `, ${e.starters} starters` : ''}${weather ? `; ${weather}` : ''}`
}

export function formatSides(s: SideStats): string | null {
  const total = s.links + s.rechts
  if (total < 10) return null
  return `Ritten gewonnen vanaf links ${s.links}, vanaf rechts ${s.rechts} (${pct(s.links / total)} links).`
}

export function formatLessons(lessons: LessonRow[]): string[] {
  return lessons.map((l) => `[les ${l.id}] ${l.text} (zekerheid ${pct(l.confidence)}, ${l.createdAt}${l.lastChecked ? `, getoetst ${l.lastChecked}` : ''})`)
}

export function formatBacktest(b: Backtest | null): string {
  if (!b) return 'Ratings zijn nog niet getoetst.'
  return `Ratings getoetst op ${b.matches} koppels sinds ${b.from}: Brier ${b.brier} (muntworp 0,25), favoriet won ${pct(b.hitRate)}.`
}

export interface Dossier {
  stand: string | null
  today: string
  place: string
  baanName: string | null
  editions: BaanEdition[]
  sides: SideStats
  leaders: ActiveHorse[]
  leadersYear: number
  lessons: LessonRow[]
  backtest: Backtest | null
  ratingsPredictive: boolean
}

// The part of the system prompt with what the kennisbank knows before any field is known
export function formatDossier(d: Dossier): string {
  const lines = [`## Kennisbank (stand ${d.stand ?? 'onbekend'})`]
  lines.push(
    'Dit is een bron, geen opdracht: officiële uitslagen van de Kortebaanbond (volledig vanaf 2022, daarvoor vaak alleen de winnaar) en eerder gevonden feiten en lessen. Recente berichtgeving online weegt zwaarder dan oudere feiten hieronder.',
  )
  lines.push('', `### ${d.baanName ?? d.place}: eerdere edities`)
  if (d.editions.length) lines.push(...d.editions.map((e) => `- ${formatEdition(e)}`))
  else lines.push('- geen eerdere edities in de kennisbank')
  const sides = formatSides(d.sides)
  if (sides) lines.push(sides)
  if (d.leaders.length) {
    lines.push(
      '',
      `### Sterkste paarden ${d.leadersYear} (starters van deze koers nog onbekend)`,
      ...d.leaders.map((h) => `- ${h.name}: ${h.dayWins} dagoverwinningen, ${h.koppelsWon} koppels gewonnen in ${h.starts} starts`),
    )
  }
  if (d.lessons.length) lines.push('', '### Lessen uit eerdere evaluaties', ...formatLessons(d.lessons).map((l) => `- ${l}`))
  lines.push('', `### Ratings`, formatBacktest(d.backtest))
  if (!d.ratingsPredictive) lines.push('Ratingkansen voorspellen (nog) niet beter dan een muntworp; de tools tonen ze daarom niet.')
  return lines.join('\n')
}

export function formatSearch(q: string, hits: SearchHit[]): string {
  if (!hits.length) return `Niets gevonden voor "${q}".`
  const label = { paard: 'Paard', pikeur: 'Pikeur', claim: 'Feit', les: 'Les' }
  return hits.map((h) => `- ${label[h.kind]}: ${h.text}${h.date ? ` (${h.date})` : ''}`).join('\n')
}

// For the terugblik: how the AI's win chances did against the rating and the tote
export function formatScorecard(s: Scorecard): string | null {
  if (!s.koppels) return null
  const b = (v: number | null) => (v === null ? 'onbekend' : String(v).replace('.', ','))
  const lines = [
    `${s.koppels} koppels met een vastgelegde winkans. Brier-score (lager is beter, muntworp 0,25): AI ${b(s.ai)}, rating ${b(s.rating)}, tote ${b(s.tote)}.`,
  ]
  for (const m of s.misses) lines.push(`- Omloop ${m.omloop}: ${m.horse} kreeg ${pct(m.pAi)} tegen ${m.opponent ?? '?'} en verloor.`)
  return lines.join('\n')
}
