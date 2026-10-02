// Koersdag: domain types, the prompt per omloop and parsing of the AI's structured update
import type { Review } from './terugblik'
import type { ZeturfOmloop } from './zeturf'
import {
  formatDutchDate,
  kennisbankSection,
  THINKING_STALE_MS,
  STALE_ERROR,
  type AdviceProposal,
  type Draverij,
  type LockedAdvice,
  type Source,
} from './analysis'

export type KoersdagStatus = 'idle' | 'thinking' | 'error'
// fetch: the AI looks up the latest news online; photo: it checks a photo of the board
export type UpdateKind = 'fetch' | 'photo'

export interface Suggestion {
  id: string
  // Which race: "2e omloop, koppel 3" (may be empty)
  race: string
  bet: string
  amount: number | null
  reasoning: string
  // New or different compared to the previous advice
  changed: boolean
}

export interface PhotoCheck {
  matches: boolean
  // "Quota Fleur de Lis 3,2 → 4,1"
  differences: string[]
}

export interface KoersdagUpdate {
  id: string
  omloop: number
  kind: UpdateKind
  createdAt: string
  findings: string[]
  // first: there was no advice before; kept/changed compared to the previous advice
  verdict: 'first' | 'kept' | 'changed'
  changes: string[]
  photoCheck: PhotoCheck | null
  // Short explanation; with no suggestions it says why not to (extra) bet
  adviceNote: string
  advice: Suggestion[]
  // The AI saw that this omloop is the finale
  isFinal: boolean
  sources: Source[]
}

export interface Bet {
  id: string
  omloop: number
  suggestionId: string | null
  bet: string
  amount: number
  // Paid out after the race (0 = lost); null = not filled in yet
  winnings: number | null
  createdAt: string
}

export interface StoredPhoto {
  key: string
  mediaType: string
}

export interface KoersdagRecord {
  draverij: Draverij
  userId: string
  budget: number
  status: KoersdagStatus
  error?: string
  // Set when a worker run starts; the worker only saves while this still matches
  thinkingSince?: string
  step?: UpdateKind
  // S3 keys of the photos the worker should check, in order (deleted after the run)
  photos?: StoredPhoto[]
  // Before multiple photos: one photo. Still read for a run started by the older API
  photoKey?: string
  photoMediaType?: string
  omloop: number
  updates: KoersdagUpdate[]
  bets: Bet[]
  countedDay?: string
  finishedAt?: string
  // Terugblik after the koersdag (uitslagen + evaluatie)
  review?: Review
  createdAt: string
  updatedAt: string
  // DynamoDB TTL (seconds)
  expiresAt: number
}

export const MAX_BUDGET = 10_000
export const MAX_BETS = 200
export const MAX_UPDATES = 60
export const MAX_BET_LENGTH = 200
export const MAX_PLACE_LENGTH = 40
// ≈ 3.7 MB of image; the app compresses photos to a few hundred KB. Also the limit for all
// photos of one check together: a Lambda request may be at most 6 MB
export const MAX_PHOTO_BASE64 = 5_000_000
// A wide board, or loting and quota apart, can take more than one photo
export const MAX_PHOTOS = 3
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type PhotoType = (typeof PHOTO_TYPES)[number]
// Keep the koersdag for Terugblik after the day itself
export const KEEP_DAYS = 60

// The photos of a photo check, including the single photo of an older record
export function photosOf(record: Pick<KoersdagRecord, 'photos' | 'photoKey' | 'photoMediaType'>): StoredPhoto[] {
  if (record.photos?.length) return record.photos
  return record.photoKey ? [{ key: record.photoKey, mediaType: record.photoMediaType ?? 'image/jpeg' }] : []
}

export const omloopLabel = (n: number) => `${n}e omloop`

export const euro = (n: number) =>
  new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(n)

export function totals(record: Pick<KoersdagRecord, 'budget' | 'bets'>) {
  const staked = round(record.bets.reduce((sum, b) => sum + b.amount, 0))
  const paidOut = round(record.bets.reduce((sum, b) => sum + (b.winnings ?? 0), 0))
  return { staked, paidOut, remaining: round(record.budget - staked + paidOut) }
}

const round = (n: number) => Math.round(n * 100) / 100

// Checks the first bytes, so only real images reach S3 and Claude
export function sniffImage(bytes: Uint8Array): PhotoType | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to))
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return null
}

// ── Bordfoto's ───────────────────────────────────────────────────────────

// What the AI read from a photo of the quotabord or the loting. Shared with everyone on the same
// koersdag, because live quoteringen are only available from the board itself.
export interface BoardReading {
  id: string
  omloop: number
  // Who took the photo; only used to tell "your photo" from someone else's
  userId: string
  readAt: string
  // "3 Fleur de Lis: winnend 3,2, plaats 1,4"
  quota: string[]
  // "Koppel 1: Fleur de Lis – Hessel B"
  loting: string[]
}

export function parseBoard(raw: string): Pick<BoardReading, 'quota' | 'loting'> | null {
  const parsed = parseJson(raw.match(UPDATE_RE)?.[1] ?? raw.match(/\{[\s\S]*\}/)?.[0])
  if (!parsed || typeof parsed !== 'object') return null
  const bord = (parsed as Record<string, unknown>).bord
  if (!bord || typeof bord !== 'object') return null
  const b = bord as Record<string, unknown>
  const board = { quota: strings(b.quota, 30, 200), loting: strings(b.loting, 30, 200) }
  return board.quota.length || board.loting.length ? board : null
}

const clock = (iso: string) =>
  new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' }).format(
    new Date(iso),
  )

function describeBoard(readings: BoardReading[], userId: string): string {
  return readings
    .map((r) => {
      const who = r.userId === userId ? 'foto van deze gebruiker' : 'foto van een andere bezoeker'
      return [
        `Om ${clock(r.readAt)} (${who}):`,
        r.quota.length ? `Quota:\n${r.quota.map((q) => `- ${q}`).join('\n')}` : '',
        r.loting.length ? `Loting:\n${r.loting.map((l) => `- ${l}`).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n')
}

// ── Prompt ───────────────────────────────────────────────────────────────

function describeProposal(p: AdviceProposal): string {
  return [
    p.summary ? `Samenvatting: ${p.summary}` : '',
    p.budget !== null ? `Budget: ${euro(p.budget)}` : '',
    ...p.picks.map(
      (pick) =>
        `- ${[pick.race, pick.bet].filter(Boolean).join(' — ')}${pick.amount !== null ? ` (${euro(pick.amount)})` : ''}: ${pick.reasoning}`,
    ),
  ]
    .filter(Boolean)
    .join('\n')
}

function describeUpdate(u: KoersdagUpdate): string {
  const advice = u.advice.length
    ? u.advice
        .map((s) => `- ${[s.race, s.bet].filter(Boolean).join(' — ')}${s.amount !== null ? ` (${euro(s.amount)})` : ''}`)
        .join('\n')
    : '- niet (extra) inzetten'
  return `${omloopLabel(u.omloop)} (${u.kind === 'photo' ? 'foto' : 'online'}):
Bevindingen: ${u.findings.join('; ') || 'geen'}
Advies: ${u.adviceNote}
${advice}`
}

export function buildKoersdagPrompt(input: {
  instruction: string
  record: KoersdagRecord
  advice: LockedAdvice | undefined
  today: string
  kind: UpdateKind
  // Latest bordfoto readings for this omloop, newest first (from all users)
  board: BoardReading[]
  // Online check only; null when ZEturf could not be read
  zeturf?: ZeturfOmloop[] | null
  // Kennisbank dossier; null = unreachable, undefined = not configured
  kennisbank?: string | null
  // Photo check only: how many photos are attached (default 1)
  photoCount?: number
}): { system: string; text: string } {
  const { record, advice, kind, board } = input
  const { staked, paidOut, remaining } = totals(record)
  const omloop = omloopLabel(record.omloop)
  const bets = record.bets.length
    ? record.bets
        .map(
          (b) =>
            `- ${omloopLabel(b.omloop)}: ${b.bet} (${euro(b.amount)})${b.winnings === null ? '' : `, uitbetaald ${euro(b.winnings)}`}`,
        )
        .join('\n')
    : '- nog niets ingezet'
  const previous = record.updates.slice(-4)

  const system = `${input.instruction.trim()}

## Context van de app
Vandaag is het ${formatDutchDate(input.today)}. De gebruiker is op de kortebaandraverij in ${record.draverij.place} en gebruikt de app tijdens de koersdag, op de telefoon. Dit is geen gesprek: je geeft per omloop één overzicht dat de app als kaart toont.

Budget: ${euro(record.budget)}. Ingezet: ${euro(staked)}. Uitbetaald: ${euro(paidOut)}. Nog over: ${euro(remaining)}.

Vastgelegd advies van vóór de koersdag:
${advice ? describeProposal(advice.proposal) : 'Er is geen vastgelegd advies. Maak bij de eerste omloop een eerste advies op basis van het budget en de actuele informatie.'}

Ingezette bedragen:
${bets}
${previous.length ? `\nEerdere updates vandaag (oudste eerst):\n${previous.map(describeUpdate).join('\n\n')}\n` : ''}${kennisbankSection(input.kennisbank, 'koersdag')}
## Quotabord bij de ${omloop}
${board.length ? `Afgelezen van bordfoto's die bezoekers vandaag maakten (nieuwste eerst). Dit zijn de enige actuele quota; ze schuiven nog tot de inzet sluit, dus weeg mee hoe oud ze zijn.\n${describeBoard(board, record.userId)}` : 'Er is nog geen bordfoto van deze omloop. Actuele quota zijn dus onbekend: verzin ze niet en noem ze niet als feit.'}

## Vorm van je antwoord
Antwoord met precies één blok in deze vorm (geldige JSON, bedragen in euro's of null) en verder niets:
<koersdag>{"bevindingen": ["Afmelding: …", "Loting koppel 3 gewijzigd: …", "Quota …"], "oordeel": "blijft", "wijzigingen": [], "foto": null, "bord": null, "advies": {"toelichting": "…", "keuzes": [{"koers": "${omloop}, koppel 2", "inzet": "Winnaar: …", "bedrag": 5, "onderbouwing": "…", "nieuw": false}]}, "kansen": [{"koppel": 1, "links": "…", "rechts": "…", "winkans_links": 0.55, "quota_links": 2.4, "quota_rechts": 3.1}], "finale": false}</koersdag>

- "oordeel" is "blijft" als het vorige advies (of het vastgelegde advies) nog klopt, anders "aangepast"; zet bij "aangepast" in "wijzigingen" kort wat er veranderde en waarom.
- "advies" gaat over wat er nú (extra) ingezet moet worden, binnen wat er nog over is van het budget. Is het beter om niet (extra) in te zetten, geef dan een lege lijst "keuzes" en leg het uit in "toelichting".
- Zet "nieuw" op true bij een keuze die nieuw is of anders dan in het vorige advies.
- "kansen": per koppel van de ${omloop} jouw inschatting dat het linker paard wint (0–1), met de winnend-quota van het bord als je die kent (anders null). Alleen als de loting bekend is, anders een lege lijst. De app legt ze vast en vergelijkt ze na afloop met de uitslag.
- Zet "finale" op true als ${omloop} de finale is (daarna is de koersdag voorbij).
- Schrijf kort en concreet in het Nederlands; de gebruiker leest dit tussen de koersen door.`

  const text =
    kind === 'photo'
      ? (input.photoCount ?? 1) > 1
        ? `Bijgevoegd zijn ${input.photoCount} foto's van het quotabord of de loting, genomen bij de ${omloop}. Samen vormen ze één bord: ze kunnen elkaar overlappen of elk een deel tonen (bijvoorbeeld de loting en de quota apart). Lees ze nauwkeurig en als geheel af, tel regels die op meer foto's staan één keer en vergelijk met wat bekend is. De foto's zijn leidend: pas het advies erop aan. Vul "foto" in als {"klopt": true/false, "verschillen": ["Quota Fleur de Lis 3,2 → 4,1"]}; noem alleen echte verschillen met wat bekend is, niet wat op de ene foto ontbreekt en op de andere staat.
Zet in "bord" letterlijk wat je op de foto's leest, samengevoegd tot één bord, zodat andere bezoekers het ook kunnen gebruiken: {"quota": ["3 Fleur de Lis: winnend 3,2, plaats 1,4"], "loting": ["Koppel 1: Fleur de Lis – Hessel B"]}. Neem alleen op wat je zeker kunt lezen en laat een lijst leeg als het op geen van de foto's staat. Zoek alleen online als de foto's iets onduidelijks bevatten.`
        : `Bijgevoegd is een foto van het quotabord of de loting, genomen bij de ${omloop}. Lees de foto nauwkeurig af en vergelijk met wat bekend is. De foto is leidend: pas het advies erop aan. Vul "foto" in als {"klopt": true/false, "verschillen": ["Quota Fleur de Lis 3,2 → 4,1"]}.
Zet in "bord" letterlijk wat je op de foto leest, zodat andere bezoekers het ook kunnen gebruiken: {"quota": ["3 Fleur de Lis: winnend 3,2, plaats 1,4"], "loting": ["Koppel 1: Fleur de Lis – Hessel B"]}. Neem alleen op wat je zeker kunt lezen en laat een lijst leeg als het niet op de foto staat. Zoek alleen online als de foto iets onduidelijks bevat.`
      : `Zoek de meest recente ontwikkelingen voor de ${omloop} in ${record.draverij.place}: wie start wel of niet (afmeldingen) en wijzigingen in de loting. Bekrachtig het advies of pas het aan. Laat "foto" en "bord" op null.

${zeturfText(input.zeturf, record)}
Zoek daarnaast online naar nieuws over afmeldingen dat daar nog niet in staat. Quota staan niet online: gebruik alleen die van het quotabord hierboven. Is er geen bordfoto, noem dan in "bevindingen" dat een foto van het quotabord het advies scherper maakt.`

  return { system, text }
}

function zeturfText(zeturf: ZeturfOmloop[] | null | undefined, record: KoersdagRecord): string {
  const place = record.draverij.place
  if (!zeturf) {
    return `ZEturf, de totalisator van de kortebaan, was niet bereikbaar. Zoek online naar "zeturf kortebaan ${place}" en de loting.`
  }
  if (!zeturf.length) {
    return `ZEturf, de totalisator van de kortebaan, heeft (nog) geen Winnend & Plaats voor de kortebaan in ${place} op deze datum. Zoek de loting en starters online, bijvoorbeeld bij de organiserende vereniging.`
  }
  const current = zeturf.find((z) => z.omloop === record.omloop)
  const pages = current ? [current] : zeturf.slice(-1)
  return `Haal bij ZEturf, de totalisator van de kortebaan, met web_fetch deze pagina op:
${pages.map((z) => `- ${omloopLabel(z.omloop)}: ${z.url}`).join('\n')}
${current ? '' : `ZEturf biedt de ${omloopLabel(record.omloop)} (nog) niet aan (wel omloop ${zeturf.map((z) => z.omloop).join(', ')}); vermeld dat in "bevindingen".\n`}Neem daar de starters, niet-starters en loting van over. De quoteringen op die pagina worden pas in de browser ingeladen: lees ze daar niet af.`
}

// ── Parsing ──────────────────────────────────────────────────────────────

const UPDATE_RE = /<koersdag>([\s\S]*?)<\/koersdag>/i

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const amount = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null
const strings = (v: unknown, maxItems: number, maxLen: number) =>
  (Array.isArray(v) ? v : [])
    .map((s) => str(s, maxLen))
    .filter(Boolean)
    .slice(0, maxItems)

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text.replace(/```(?:json)?/g, '').trim())
  } catch {
    return undefined
  }
}

export interface KoppelKans {
  omloop: number
  koppel: number
  links: string
  rechts: string
  winkansLinks: number
  quotaLinks: number | null
  quotaRechts: number | null
}

const quota = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 1 && v < 1000 ? v : null)

// Win chances per koppel from a <koersdag> reply, for scoring afterwards
export function parseKansen(raw: string, omloop: number): KoppelKans[] {
  const parsed = parseJson(raw.match(UPDATE_RE)?.[1] ?? raw.match(/\{[\s\S]*\}/)?.[0])
  const list = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).kansen : undefined
  return (Array.isArray(list) ? list : [])
    .slice(0, 40)
    .map((k): KoppelKans | null => {
      if (!k || typeof k !== 'object') return null
      const v = k as Record<string, unknown>
      const links = str(v.links, 80)
      const rechts = str(v.rechts, 80)
      const p = v.winkans_links
      if (!links || !rechts || typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return null
      const koppel = typeof v.koppel === 'number' && Number.isInteger(v.koppel) && v.koppel > 0 ? v.koppel : 0
      return { omloop, koppel, links, rechts, winkansLinks: p, quotaLinks: quota(v.quota_links), quotaRechts: quota(v.quota_rechts) }
    })
    .filter((k): k is KoppelKans => k !== null)
    .map((k, i) => ({ ...k, koppel: k.koppel || i + 1 }))
}

export const UNREADABLE_ERROR = 'De AI gaf een onleesbaar antwoord. Probeer het opnieuw.'

// Returns null when the reply has no usable block
export function parseUpdate(
  raw: string,
  meta: {
    id: string
    omloop: number
    kind: UpdateKind
    createdAt: string
    sources: Source[]
    hadAdvice: boolean
    newId: () => string
  },
): KoersdagUpdate | null {
  const parsed = parseJson(raw.match(UPDATE_RE)?.[1] ?? raw.match(/\{[\s\S]*\}/)?.[0])
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const v = parsed as Record<string, unknown>
  const adviceValue = (v.advies && typeof v.advies === 'object' ? v.advies : {}) as Record<string, unknown>
  if (!Array.isArray(adviceValue.keuzes) && typeof adviceValue.toelichting !== 'string') return null

  const advice = (Array.isArray(adviceValue.keuzes) ? adviceValue.keuzes : [])
    .slice(0, 12)
    .map((p: unknown): Suggestion | null => {
      if (!p || typeof p !== 'object') return null
      const pick = p as Record<string, unknown>
      const bet = str(pick.inzet, MAX_BET_LENGTH)
      if (!bet) return null
      return {
        id: meta.newId(),
        race: str(pick.koers, 120),
        bet,
        amount: amount(pick.bedrag),
        reasoning: str(pick.onderbouwing, 600),
        changed: pick.nieuw === true,
      }
    })
    .filter((s): s is Suggestion => s !== null)

  const changes = strings(v.wijzigingen, 10, 300)
  const verdict: KoersdagUpdate['verdict'] = !meta.hadAdvice
    ? 'first'
    : str(v.oordeel, 20).toLowerCase().startsWith('aangepast') || changes.length > 0
      ? 'changed'
      : 'kept'

  let photoCheck: PhotoCheck | null = null
  if (meta.kind === 'photo') {
    const foto = (v.foto && typeof v.foto === 'object' ? v.foto : {}) as Record<string, unknown>
    const differences = strings(foto.verschillen, 12, 200)
    photoCheck = { matches: foto.klopt === true && differences.length === 0, differences }
  }

  return {
    id: meta.id,
    omloop: meta.omloop,
    kind: meta.kind,
    createdAt: meta.createdAt,
    findings: strings(v.bevindingen, 12, 300),
    verdict,
    changes: verdict === 'changed' ? changes : [],
    photoCheck,
    adviceNote: str(adviceValue.toelichting, 800),
    advice,
    isFinal: v.finale === true,
    sources: meta.sources,
  }
}

// ── View sent to the app ─────────────────────────────────────────────────

export interface KoersdagView {
  id: string
  draverij: Draverij
  budget: number
  staked: number
  paidOut: number
  remaining: number
  omloop: number
  status: KoersdagStatus
  error: string | null
  step: UpdateKind | null
  updates: KoersdagUpdate[]
  bets: Bet[]
  lockedAdvice: LockedAdvice | null
  finishedAt: string | null
  updatedAt: string
}

export function effectiveKoersdagStatus(
  record: KoersdagRecord,
  now = Date.now(),
): { status: KoersdagStatus; error: string | null } {
  if (
    record.status === 'thinking' &&
    record.thinkingSince &&
    now - Date.parse(record.thinkingSince) > THINKING_STALE_MS
  ) {
    return { status: 'error', error: STALE_ERROR }
  }
  return { status: record.status, error: record.status === 'error' ? (record.error ?? STALE_ERROR) : null }
}

export function toKoersdagView(record: KoersdagRecord, advice: LockedAdvice | undefined, now = Date.now()): KoersdagView {
  return {
    id: record.draverij.id,
    draverij: record.draverij,
    budget: record.budget,
    ...totals(record),
    omloop: record.omloop,
    ...effectiveKoersdagStatus(record, now),
    step: record.step ?? null,
    updates: record.updates,
    bets: record.bets,
    lockedAdvice: advice ?? null,
    finishedAt: record.finishedAt ?? null,
    updatedAt: record.updatedAt,
  }
}
