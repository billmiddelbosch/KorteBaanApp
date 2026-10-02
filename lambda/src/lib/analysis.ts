// Analyse: domain types, the prompt around the owner's AI-instructie, and parsing of AI replies

export interface Draverij {
  // `<yyyy-mm-dd>-<plaats-slug>`, e.g. 2026-10-01-lisse
  id: string
  place: string
  date: string
}

export interface Source {
  url: string
  title: string
}

export interface AdvicePick {
  // Which race: "1e omloop, koppel 3"
  race: string
  // What to play: "Winnaar: Fleur de Lis"
  bet: string
  amount: number | null
  reasoning: string
}

export interface AdviceProposal {
  summary: string
  budget: number | null
  picks: AdvicePick[]
}

// As stored: assistant text is the full reply (incl. advice/facts blocks), sent back to Claude
// as history and parsed for display on read
export interface StoredMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  sources: Source[]
  createdAt: string
}

export type ChatStatus = 'idle' | 'thinking' | 'error'

export interface ChatRecord {
  draverij: Draverij
  userId: string
  status: ChatStatus
  error?: string
  // Set when a worker run starts; the worker only saves its reply if this still matches
  thinkingSince?: string
  messages: StoredMessage[]
  // Day this chat last counted towards the daily AI limit (one per chat per day)
  countedDay?: string
  createdAt: string
  updatedAt: string
  // DynamoDB TTL (seconds): the chat disappears once the draverij is over
  expiresAt: number
}

export interface LockedAdvice {
  draverij: Draverij
  messageId: string
  proposal: AdviceProposal
  lockedAt: string
}

export interface InstructionRecord {
  text: string
  updatedAt: string
  updatedBy: string
  previous?: { text: string; updatedAt: string }
}

export interface KnowledgeFact {
  id: string
  text: string
  draverijId: string
  createdAt: string
}

export interface Lesson {
  id: string
  text: string
  createdAt: string
  // Bron-koersdag (Terugblik)
  draverijId?: string
  place?: string
  date?: string
}

export const MAX_MESSAGE_LENGTH = 2000
export const MAX_MESSAGES = 40
// Keep the chat item well under DynamoDB's 400 KB item limit
export const MAX_CHAT_CHARS = 250_000
export const MAX_REPLY_CHARS = 20_000
export const MAX_INSTRUCTION_LENGTH = 8000
// A worker that hasn't answered after this long has crashed or timed out
export const THINKING_STALE_MS = 6 * 60 * 1000

export const DEFAULT_INSTRUCTION = `Je bent expert op het gebied van kortebaandraverijen in Nederland. Je volgt meerjarig alle uitslagen en zoekt verbanden in hoe koersen gelopen en gewonnen worden: paarden, pikeurs, stallen, de baan en de omstandigheden. In je kansbepaling neem je ook de meest recente uitslagen en berichtgeving mee.

Werkwijze:
- Stel eerst een paar korte vragen: wat is het budget, hoeveel risico wil de gebruiker nemen, en zijn er paarden of pikeurs die extra meegewogen moeten worden?
- Zoek online naar het deelnemersveld, recente uitslagen en berichtgeving over deze draverij.
- Weeg alle inzetopties af binnen het budget en onderbouw elke keuze kort en concreet.
- Wees eerlijk over onzekerheid en zeg het als informatie ontbreekt of verouderd is.
- Schrijf in het Nederlands, kort en helder: de gebruiker leest op de telefoon.`

// ── Draverijen ───────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const DRAVERIJ_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,60}$/

export function slugify(place: string): string {
  return place
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

export function isValidDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false
  const parsed = new Date(`${date}T12:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
}

export function draverijOf(place: string, date: string): Draverij {
  return { id: `${date}-${slugify(place)}`, place, date }
}

// End of the draverij day (Dutch time, roughly), in seconds for DynamoDB TTL
export function endOfDay(date: string): number {
  return Math.floor(Date.parse(`${date}T23:59:59+01:00`) / 1000)
}

export function formatDutchDate(date: string): string {
  return new Intl.DateTimeFormat('nl-NL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`))
}

export const kickoffText = (d: Draverij) =>
  `Ik wil een inzetadvies voor de kortebaan in ${d.place} op ${formatDutchDate(d.date)}.`

// ── Prompt ───────────────────────────────────────────────────────────────

// The kennisbank as a source in the system prompt. undefined: no kennisbank configured (tests,
// local runs); null: configured but unreachable, which the reasoning has to mention.
// The koersdag gets few tool rounds, so it is asked to batch its kennisbank calls.
export function kennisbankSection(kennisbank: string | null | undefined, tools: 'analysis' | 'koersdag' | false): string {
  if (kennisbank === undefined) return ''
  if (kennisbank === null) {
    return `
## Kennisbank
De kennisbank is nu niet bereikbaar. Baseer je op actuele online bronnen en vermeld in je onderbouwing dat historische kennisbankdata ontbrak.
`
  }
  if (tools === 'koersdag') {
    return `
${kennisbank}

## Werken met de kennisbank
- De kennisbank is één bron naast wat je vandaag ziet (ZEturf, bordfoto's, nieuws). Maak in je onderbouwing zichtbaar wat uit de kennisbank komt en wat van vandaag, en benoem waar ze verschillen.
- Een les met "[les …]" is een eerdere interpretatie, geen wet; weeg de zekerheid mee.
- Het dossier hierboven is meestal genoeg. Gebruik de kb_-tools alleen voor paarden of koppels die er niet in staan, en pas als je de loting kent.
- Roep alles wat je nodig hebt in één beurt tegelijk aan: kb_matchups met alle koppels van deze omloop in één aanroep, kb_field met alle onbekende paarden in één aanroep. Je krijgt maar weinig rondes tools; daarna moet je meteen antwoorden.
`
  }
  return `
${kennisbank}

## Werken met de kennisbank
- De kennisbank is één bron naast je eigen actuele zoektocht; zoek altijd online naar het nieuws van vandaag (afmeldingen, loting, baanstaat, vorm), ook als de kennisbank compleet lijkt.
- Maak in je onderbouwing zichtbaar wat uit de kennisbank komt en wat van vandaag, en benoem waar ze verschillen.
- Een les met "[les …]" is een eerdere interpretatie, geen wet; weeg de zekerheid mee.${
    tools
      ? `
- Met de kb_-tools haal je profielen van paarden en pikeurs, onderlinge duels en eerdere edities op. Gebruik ze zodra je de deelnemers of koppels kent.
- Nieuwe, controleerbare feiten die je online vindt (blessure, afmelding, pikeurwissel, vorm) leg je vast met kb_record_claim, met de bron-URL.`
      : ''
  }
`
}

// The fixed app part: output format for advice, the chosen koers and the kennisbank.
// The owner edits only the instruction; this part keeps the app able to read the replies.
export function buildSystemPrompt(input: {
  instruction: string
  draverij: Draverij
  today: string
  kennisbank?: string | null
}): string {
  const { draverij } = input
  return `${input.instruction.trim()}

## Context van de app
Vandaag is het ${formatDutchDate(input.today)}. De gebruiker wil een inzetadvies voor de kortebaandraverij in ${draverij.place} op ${formatDutchDate(draverij.date)}.
${kennisbankSection(input.kennisbank, 'analysis')}
## Vorm van je antwoorden
Als je een inzetadvies voorstelt, sluit je bericht af met precies één blok in deze vorm (geldige JSON, bedragen in euro's of null):
<advies>{"samenvatting": "…", "budget": 50, "keuzes": [{"koers": "1e omloop, koppel 3", "inzet": "Winnaar: …", "bedrag": 10, "onderbouwing": "…"}]}</advies>
De app toont dit blok als kaart met een knop om het advies vast te leggen; herhaal de inhoud niet uitgebreid in je tekst.`
}

// ── Parsing replies ──────────────────────────────────────────────────────

const ADVICE_RE = /<advies>([\s\S]*?)<\/advies>/i
const FACTS_RE = /<feiten>([\s\S]*?)<\/feiten>/i

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const amount = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined
  try {
    // Tolerate a ```json fence inside the block
    return JSON.parse(text.replace(/```(?:json)?/g, '').trim())
  } catch {
    return undefined
  }
}

export function parseProposal(value: unknown): AdviceProposal | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const picks = (Array.isArray(v.keuzes) ? v.keuzes : [])
    .slice(0, 20)
    .map((p: unknown): AdvicePick | null => {
      if (!p || typeof p !== 'object') return null
      const pick = p as Record<string, unknown>
      const bet = str(pick.inzet, 200)
      if (!bet) return null
      return {
        race: str(pick.koers, 120),
        bet,
        amount: amount(pick.bedrag),
        reasoning: str(pick.onderbouwing, 800),
      }
    })
    .filter((p): p is AdvicePick => p !== null)
  if (picks.length === 0) return null
  return { summary: str(v.samenvatting, 800), budget: amount(v.budget), picks }
}

export interface ParsedReply {
  text: string
  proposal: AdviceProposal | null
  facts: string[]
}

export function parseReply(raw: string): ParsedReply {
  const proposal = parseProposal(parseJson(raw.match(ADVICE_RE)?.[1]))
  const factsValue = parseJson(raw.match(FACTS_RE)?.[1])
  const facts = (Array.isArray(factsValue) ? factsValue : [])
    .map((f) => str(f, 400))
    .filter(Boolean)
    .slice(0, 10)
  const text = raw
    .replace(ADVICE_RE, '')
    .replace(FACTS_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text, proposal, facts }
}

// ── Views sent to the app ────────────────────────────────────────────────

export interface MessageView {
  id: string
  role: 'user' | 'assistant'
  text: string
  sources: Source[]
  proposal: AdviceProposal | null
  createdAt: string
}

export interface ChatView {
  id: string
  draverij: Draverij
  status: ChatStatus
  error: string | null
  messages: MessageView[]
  advice: LockedAdvice | null
  updatedAt: string
}

export interface ChatSummary {
  id: string
  draverij: Draverij
  status: ChatStatus
  hasAdvice: boolean
  messageCount: number
  updatedAt: string
}

export const STALE_ERROR = 'Het antwoord bleef uit. Probeer het opnieuw.'

// A worker that never finished leaves the chat `thinking`; show that as a retryable error
export function effectiveStatus(chat: ChatRecord, now = Date.now()): { status: ChatStatus; error: string | null } {
  if (
    chat.status === 'thinking' &&
    chat.thinkingSince &&
    now - Date.parse(chat.thinkingSince) > THINKING_STALE_MS
  ) {
    return { status: 'error', error: STALE_ERROR }
  }
  return { status: chat.status, error: chat.status === 'error' ? (chat.error ?? STALE_ERROR) : null }
}

export function toMessageView(message: StoredMessage): MessageView {
  if (message.role === 'user') return { ...message, proposal: null }
  const { text, proposal } = parseReply(message.text)
  return { ...message, text, proposal }
}

export function toChatView(chat: ChatRecord, advice: LockedAdvice | undefined, now = Date.now()): ChatView {
  return {
    id: chat.draverij.id,
    draverij: chat.draverij,
    ...effectiveStatus(chat, now),
    messages: chat.messages.map(toMessageView),
    advice: advice ?? null,
    updatedAt: chat.updatedAt,
  }
}

export function toChatSummary(chat: ChatRecord, hasAdvice: boolean, now = Date.now()): ChatSummary {
  return {
    id: chat.draverij.id,
    draverij: chat.draverij,
    status: effectiveStatus(chat, now).status,
    hasAdvice,
    messageCount: chat.messages.length,
    updatedAt: chat.updatedAt,
  }
}
