// Terugblik: uitslagen per omloop, the AI's evaluation of advice versus outcome, and the view
import { formatDutchDate, STALE_ERROR, THINKING_STALE_MS, type Draverij, type LockedAdvice, type Source } from './analysis'
import { euro, omloopLabel, totals, type Bet, type KoersdagRecord, type KoersdagUpdate } from './koersdag'

export type ReviewStatus = 'idle' | 'thinking' | 'error'
// results: the AI looks the uitslagen up online; photo: it reads a photo of the uitslagbord;
// evaluate: it compares the advice with the confirmed uitslagen
export type ReviewStep = 'results' | 'photo' | 'evaluate'

export interface OmloopResult {
  omloop: number
  winner: string
  // Other places, free text ("2e: Hessel B, 3e: …")
  places: string
}

export interface OmloopEvaluation {
  omloop: number
  // Did the advice for this omloop work out? null: there was no advice for it
  correct: boolean | null
  advice: string
  winner: string
  reason: string
}

export interface Evaluation {
  summary: string
  omlopen: OmloopEvaluation[]
  createdAt: string
}

export interface Review {
  status: ReviewStatus
  error?: string
  step?: ReviewStep
  // Identifies the worker run, like KoersdagRecord.thinkingSince
  thinkingSince?: string
  photoKey?: string
  photoMediaType?: string
  // Draft (from the AI or the user) until resultsConfirmedAt is set
  results: OmloopResult[] | null
  resultsSources: Source[]
  resultsConfirmedAt?: string
  evaluation: Evaluation | null
  countedDay?: string
}

export const MAX_OMLOPEN = 12
export const MAX_WINNER_LENGTH = 120
export const MAX_PLACES_LENGTH = 300
export const MAX_LESSONS_PER_EVALUATION = 5

export const RESULTS_NOT_FOUND =
  'De AI vond de uitslagen niet online. Vul ze zelf in of upload een foto van het uitslagbord.'

export const emptyReview = (): Review => ({ status: 'idle', results: null, resultsSources: [], evaluation: null })

// ── Prompts ──────────────────────────────────────────────────────────────

function describeBets(bets: Bet[]): string {
  if (!bets.length) return '- niets ingezet'
  return bets
    .map(
      (b) =>
        `- ${omloopLabel(b.omloop)}: ${b.bet} (${euro(b.amount)})${b.winnings === null ? ', uitbetaling onbekend' : `, uitbetaald ${euro(b.winnings)}`}`,
    )
    .join('\n')
}

function describeAdvice(updates: KoersdagUpdate[], locked: LockedAdvice | undefined): string {
  const lines: string[] = []
  if (locked) {
    lines.push('Vastgelegd advies van vóór de koersdag:')
    if (locked.proposal.summary) lines.push(locked.proposal.summary)
    for (const p of locked.proposal.picks) {
      lines.push(`- ${[p.race, p.bet].filter(Boolean).join(' — ')}${p.amount !== null ? ` (${euro(p.amount)})` : ''}: ${p.reasoning}`)
    }
  }
  for (const u of updates) {
    lines.push(`\n${omloopLabel(u.omloop)} — advies tijdens de koersdag: ${u.adviceNote || '(geen toelichting)'}`)
    for (const s of u.advice) {
      lines.push(`- ${[s.race, s.bet].filter(Boolean).join(' — ')}${s.amount !== null ? ` (${euro(s.amount)})` : ''}: ${s.reasoning}`)
    }
    if (!u.advice.length) lines.push('- niet (extra) inzetten')
  }
  return lines.length ? lines.join('\n') : 'Er was geen advies.'
}

const describeResults = (results: OmloopResult[]) =>
  results
    .map((r) => `- ${omloopLabel(r.omloop)}: winnaar ${r.winner || 'onbekend'}${r.places ? `; ${r.places}` : ''}`)
    .join('\n')

export function buildResultsPrompt(input: {
  instruction: string
  record: KoersdagRecord
  kind: 'results' | 'photo'
}): { system: string; text: string } {
  const { record } = input
  const system = `${input.instruction.trim()}

## Context van de app
De kortebaandraverij in ${record.draverij.place} op ${formatDutchDate(record.draverij.date)} is voorbij. De gebruiker wil de uitslagen per omloop vastleggen om het advies te kunnen evalueren. De gebruiker volgde de koersdag in de app tot en met de ${omloopLabel(record.omloop)}.

## Vorm van je antwoord
Antwoord met precies één blok in deze vorm (geldige JSON) en verder niets:
<uitslagen>{"gevonden": true, "omlopen": [{"omloop": 1, "winnaar": "Naam paard (pikeur)", "plaatsen": "2e: …, 3e: …"}]}</uitslagen>

- Eén regel per omloop, in volgorde; "winnaar" is de winnaar van die omloop, "plaatsen" kort de overige plaatsen of afvallers (mag leeg).
- Verzin niets. Vind je de uitslagen niet, zet "gevonden" op false en geef een lege lijst.`

  const text =
    input.kind === 'photo'
      ? 'Bijgevoegd is een foto van het uitslagbord. Lees de uitslagen per omloop nauwkeurig af. Zoek alleen online als iets op de foto onduidelijk is.'
      : `Zoek online naar de uitslagen van de kortebaandraverij in ${record.draverij.place} op ${formatDutchDate(record.draverij.date)}.`
  return { system, text }
}

export function buildEvaluationPrompt(input: {
  instruction: string
  record: KoersdagRecord
  advice: LockedAdvice | undefined
  results: OmloopResult[]
}): { system: string; text: string } {
  const { record } = input
  const { staked, paidOut } = totals(record)
  const system = `${input.instruction.trim()}

## Context van de app
Je evalueert achteraf het advies voor de kortebaandraverij in ${record.draverij.place} op ${formatDutchDate(record.draverij.date)}. Vergelijk per omloop het advies met de uitkomst, eerlijk en zonder drama.

${describeAdvice(record.updates, input.advice)}

Ingezette bedragen (totaal ${euro(staked)}, uitbetaald ${euro(paidOut)}):
${describeBets(record.bets)}

Bevestigde uitslagen:
${describeResults(input.results)}

## Vorm van je antwoord
Antwoord met precies één blok in deze vorm (geldige JSON) en verder niets:
<evaluatie>{"oordeel": "Eén of twee zinnen over de hele dag.", "omlopen": [{"omloop": 1, "klopte": true, "advies": "Winnaar: …", "winnaar": "…", "waarom": "Eén zin waarom het wel of niet uitkwam."}], "lessen": ["…"]}</evaluatie>

- Eén regel per omloop uit de uitslagen. "klopte" is true of false; null als er voor die omloop geen advies was.
- "lessen": hooguit ${MAX_LESSONS_PER_EVALUATION} algemene, herbruikbare lessen voor toekomstige adviezen (over paarden, pikeurs, banen, omstandigheden of de manier van adviseren), met plaats en datum waar dat helpt. Geen lessen die alleen voor deze dag gelden. Een lege lijst mag.
- Schrijf kort en concreet in het Nederlands.`

  return { system, text: 'Evalueer het advies van deze koersdag tegen de uitslagen.' }
}

// ── Parsing ──────────────────────────────────────────────────────────────

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

function parseBlock(raw: string, tag: string): Record<string, unknown> | null {
  const text = raw.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'))?.[1] ?? raw.match(/\{[\s\S]*\}/)?.[0]
  if (!text) return null
  try {
    const parsed: unknown = JSON.parse(text.replace(/```(?:json)?/g, '').trim())
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const omloopOf = (v: unknown) =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 99 ? v : null

// Keeps one entry per omloop, sorted
function byOmloop<T extends { omloop: number }>(items: T[]): T[] {
  const seen = new Map<number, T>()
  for (const item of items) if (!seen.has(item.omloop)) seen.set(item.omloop, item)
  return [...seen.values()].sort((a, b) => a.omloop - b.omloop).slice(0, MAX_OMLOPEN)
}

// null: unreadable reply; []: the AI didn't find them
export function parseResults(raw: string): OmloopResult[] | null {
  const v = parseBlock(raw, 'uitslagen')
  if (!v) return null
  if (v.gevonden === false) return []
  if (!Array.isArray(v.omlopen)) return null
  return byOmloop(
    v.omlopen
      .map((o: unknown): OmloopResult | null => {
        if (!o || typeof o !== 'object') return null
        const r = o as Record<string, unknown>
        const omloop = omloopOf(r.omloop)
        const winner = str(r.winnaar, MAX_WINNER_LENGTH)
        if (omloop === null || !winner) return null
        return { omloop, winner, places: str(r.plaatsen, MAX_PLACES_LENGTH) }
      })
      .filter((r): r is OmloopResult => r !== null),
  )
}

export function parseEvaluation(
  raw: string,
  createdAt: string,
): { evaluation: Evaluation; lessons: string[] } | null {
  const v = parseBlock(raw, 'evaluatie')
  if (!v || !Array.isArray(v.omlopen)) return null
  const omlopen = byOmloop(
    v.omlopen
      .map((o: unknown): OmloopEvaluation | null => {
        if (!o || typeof o !== 'object') return null
        const e = o as Record<string, unknown>
        const omloop = omloopOf(e.omloop)
        if (omloop === null) return null
        return {
          omloop,
          correct: typeof e.klopte === 'boolean' ? e.klopte : null,
          advice: str(e.advies, 300),
          winner: str(e.winnaar, MAX_WINNER_LENGTH),
          reason: str(e.waarom, 400),
        }
      })
      .filter((e): e is OmloopEvaluation => e !== null),
  )
  const summary = str(v.oordeel, 800)
  if (!summary && !omlopen.length) return null
  const lessons = (Array.isArray(v.lessen) ? v.lessen : [])
    .map((l) => str(l, 400))
    .filter(Boolean)
    .slice(0, MAX_LESSONS_PER_EVALUATION)
  return { evaluation: { summary, omlopen, createdAt }, lessons }
}

// Validates results the user confirms in the app
export function readResults(value: unknown): OmloopResult[] | string {
  if (!Array.isArray(value) || value.length === 0) return 'Vul de uitslag van minstens één omloop in.'
  if (value.length > MAX_OMLOPEN) return `Je kunt maximaal ${MAX_OMLOPEN} omlopen invullen.`
  const results: OmloopResult[] = []
  for (const item of value) {
    const r = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const omloop = omloopOf(r.omloop)
    if (omloop === null) return 'Er klopt iets niet met de omlopen. Probeer het opnieuw.'
    const winner = typeof r.winner === 'string' ? r.winner.trim() : ''
    if (!winner) return `Vul de winnaar van de ${omloopLabel(omloop)} in.`
    if (winner.length > MAX_WINNER_LENGTH) return `De winnaar mag maximaal ${MAX_WINNER_LENGTH} tekens zijn.`
    const places = typeof r.places === 'string' ? r.places.trim() : ''
    if (places.length > MAX_PLACES_LENGTH) return `De plaatsen mogen maximaal ${MAX_PLACES_LENGTH} tekens zijn.`
    results.push({ omloop, winner, places })
  }
  if (new Set(results.map((r) => r.omloop)).size !== results.length) return 'Elke omloop mag maar één keer voorkomen.'
  return results.sort((a, b) => a.omloop - b.omloop)
}

// ── View sent to the app ─────────────────────────────────────────────────

export function effectiveReviewStatus(review: Review, now = Date.now()): { status: ReviewStatus; error: string | null } {
  if (review.status === 'thinking' && review.thinkingSince && now - Date.parse(review.thinkingSince) > THINKING_STALE_MS) {
    return { status: 'error', error: STALE_ERROR }
  }
  return { status: review.status, error: review.status === 'error' ? (review.error ?? STALE_ERROR) : null }
}

export interface TerugblikView {
  id: string
  draverij: Draverij
  budget: number
  staked: number
  paidOut: number
  balance: number
  bets: Bet[]
  finishedAt: string
  omloop: number
  status: ReviewStatus
  error: string | null
  step: ReviewStep | null
  results: OmloopResult[] | null
  resultsConfirmedAt: string | null
  evaluation: Evaluation | null
}

export function toTerugblikView(record: KoersdagRecord, now = Date.now()): TerugblikView {
  const review = record.review ?? emptyReview()
  const { staked, paidOut } = totals(record)
  return {
    id: record.draverij.id,
    draverij: record.draverij,
    budget: record.budget,
    staked,
    paidOut,
    balance: Math.round((paidOut - staked) * 100) / 100,
    bets: record.bets,
    finishedAt: record.finishedAt ?? record.updatedAt,
    omloop: record.omloop,
    ...effectiveReviewStatus(review, now),
    step: review.step ?? null,
    results: review.results,
    resultsConfirmedAt: review.resultsConfirmedAt ?? null,
    evaluation: review.evaluation,
  }
}
