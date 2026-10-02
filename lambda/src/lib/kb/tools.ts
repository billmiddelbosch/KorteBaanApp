// Kennisbank tools for the workers' Claude calls. Each tool answers in compact Dutch text; a
// failing query becomes an error result, so the AI can carry on with web search alone.
import type pg from 'pg'
import { slugify } from '../analysis'
import type { CustomTool, ToolRunner } from '../claude'
import { formatHorse, formatMatchup, formatPikeur, formatSearch, formatEdition, formatSides } from './dossier'
import { ratingIsPredictive, winChance, type Backtest } from './glicko'
import {
  baanHistory,
  claimsAbout,
  currentRatings,
  getMeta,
  headToHead,
  horseTotals,
  originsFor,
  pikeurStats,
  recentStarts,
  resolveNames,
  search,
  sideStats,
  type Env,
} from './queries'
import { PREDICATES, recordClaims, type ClaimInput } from './write'

export type ToolMode = 'analysis' | 'koersdag' | 'mcp'

const names = { type: 'array', items: { type: 'string' } }

export const KB_TOOLS: Record<string, CustomTool> = {
  kb_field: {
    name: 'kb_field',
    description:
      'Kennisbank: profiel van paarden (starts, dagoverwinningen, koppels gewonnen/verloren, rating, recente vorm per draverij met pikeur, losse feiten). Gebruik dit voor de deelnemers zodra je hun namen kent.',
    input_schema: { type: 'object', properties: { namen: { ...names, description: 'Paardnamen, max 16' } }, required: ['namen'] },
  },
  kb_entity: {
    name: 'kb_entity',
    description: 'Kennisbank: profiel van één paard of pikeur (pikeur: koppels en dagoverwinningen per jaar).',
    input_schema: {
      type: 'object',
      properties: { naam: { type: 'string' }, soort: { type: 'string', enum: ['paard', 'pikeur'] } },
      required: ['naam'],
    },
  },
  kb_matchups: {
    name: 'kb_matchups',
    description: 'Kennisbank: per koppel het onderlinge verleden en (als die voorspellend is) de ratingkans.',
    input_schema: {
      type: 'object',
      properties: {
        koppels: {
          type: 'array',
          description: 'Max 16 koppels',
          items: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] },
        },
      },
      required: ['koppels'],
    },
  },
  kb_conditions: {
    name: 'kb_conditions',
    description: 'Kennisbank: eerdere edities van een kortebaan met winnaar, pikeur en weer, en winst vanaf links/rechts.',
    input_schema: { type: 'object', properties: { baan: { type: 'string', description: 'Plaats; standaard deze draverij' } } },
  },
  kb_search: {
    name: 'kb_search',
    description: 'Kennisbank: zoek paarden, pikeurs, feiten en lessen op tekst.',
    input_schema: { type: 'object', properties: { tekst: { type: 'string' } }, required: ['tekst'] },
  },
  kb_record_claim: {
    name: 'kb_record_claim',
    description:
      'Leg nieuwe, controleerbare feiten vast die je online vond en die de kennisbank nog niet heeft (blessure, afmelding, pikeurwissel, vorm, training). Geen meningen, geen uitslagen (die komen officieel binnen). Een nieuw feit met hetzelfde predicaat over dezelfde paarden vervangt het oude.',
    input_schema: {
      type: 'object',
      properties: {
        claims: {
          type: 'array',
          description: 'Max 10',
          items: {
            type: 'object',
            properties: {
              tekst: { type: 'string', description: 'Eén zin, zelfstandig leesbaar' },
              predicaat: { type: 'string', enum: [...PREDICATES] },
              paarden: names,
              pikeurs: names,
              baan: { type: 'string' },
              bron: { type: 'string', description: 'URL' },
              geldig_tot: { type: 'string', description: 'yyyy-mm-dd, als het feit tijdelijk is' },
              zekerheid: { type: 'number', description: '0–1' },
            },
            required: ['tekst', 'predicaat'],
          },
        },
      },
      required: ['claims'],
    },
  },
}

const MODE_TOOLS: Record<ToolMode, string[]> = {
  analysis: ['kb_field', 'kb_entity', 'kb_matchups', 'kb_conditions', 'kb_search', 'kb_record_claim'],
  koersdag: ['kb_field', 'kb_entity', 'kb_matchups'],
  mcp: ['kb_field', 'kb_entity', 'kb_matchups', 'kb_conditions', 'kb_search', 'kb_record_claim'],
}

export interface ToolContext {
  client: pg.Client
  env: Env
  today: string
  place: string
}

const strings = (v: unknown, max: number) =>
  (Array.isArray(v) ? v : [])
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .slice(0, max)

export function kbTools(ctx: ToolContext, mode: ToolMode): { tools: CustomTool[]; runTool: ToolRunner } {
  const { client, env, today } = ctx
  const origins = originsFor(env)
  let predictive: Promise<boolean> | null = null
  const showRating = () => (predictive ??= getMeta<Backtest>(client, 'rating_backtest').then(ratingIsPredictive))
  const allowed = new Set(MODE_TOOLS[mode])

  async function horseCards(list: string[]): Promise<string> {
    const resolved = await resolveNames(client, 'horse', list)
    const ids = [...resolved.values()].filter((h) => !!h).map((h) => h!.id)
    const ratings = await currentRatings(client, ids)
    const show = await showRating()
    const out: string[] = []
    for (const name of list) {
      const h = resolved.get(name)
      if (!h) {
        out.push(`### ${name}\nNiet in de kennisbank (debutant of andere schrijfwijze).`)
        continue
      }
      const [totals, starts, claims] = await Promise.all([
        horseTotals(client, h.id),
        recentStarts(client, h.id, 6),
        claimsAbout(client, [{ kind: 'horse', id: h.id }], origins, today, 10),
      ])
      out.push(formatHorse({ name: h.name, totals, starts, rating: ratings.get(h.id) ?? null, claims }, today, show))
    }
    return out.join('\n\n')
  }

  const run: Record<string, (input: Record<string, unknown>) => Promise<string>> = {
    kb_field: async (input) => {
      const list = strings(input.namen, 16)
      return list.length ? horseCards(list) : 'Geef paardnamen mee.'
    },
    kb_entity: async (input) => {
      const naam = String(input.naam ?? '').trim()
      if (!naam) return 'Geef een naam mee.'
      if (input.soort !== 'pikeur') {
        const horse = (await resolveNames(client, 'horse', [naam])).get(naam)
        if (horse || input.soort === 'paard') return horseCards([naam])
      }
      const pikeur = (await resolveNames(client, 'pikeur', [naam])).get(naam)
      if (!pikeur) return `Geen paard of pikeur "${naam}" in de kennisbank.`
      return formatPikeur(pikeur.name, await pikeurStats(client, pikeur.id))
    },
    kb_matchups: async (input) => {
      const koppels = (Array.isArray(input.koppels) ? input.koppels : [])
        .map((k) => ({ a: String((k as { a?: unknown })?.a ?? '').trim(), b: String((k as { b?: unknown })?.b ?? '').trim() }))
        .filter((k) => k.a && k.b)
        .slice(0, 16)
      if (!koppels.length) return 'Geef koppels mee als {a, b}.'
      const resolved = await resolveNames(client, 'horse', [...new Set(koppels.flatMap((k) => [k.a, k.b]))])
      const ids = [...resolved.values()].filter((h) => !!h).map((h) => h!.id)
      const ratings = await currentRatings(client, ids)
      const show = await showRating()
      const out: string[] = []
      for (const k of koppels) {
        const a = resolved.get(k.a)
        const b = resolved.get(k.b)
        const ra = a ? ratings.get(a.id) : undefined
        const rb = b ? ratings.get(b.id) : undefined
        out.push(
          formatMatchup({
            a: a?.name ?? k.a,
            b: b?.name ?? k.b,
            known: { a: !!a, b: !!b },
            pRating: show && ra && rb ? winChance(ra, rb) : null,
            meetings: a && b ? await headToHead(client, a.id, b.id) : [],
          }),
        )
      }
      return out.join('\n\n')
    },
    kb_conditions: async (input) => {
      const place = String(input.baan ?? '').trim() || ctx.place
      const baanId = slugify(place)
      const [history, sides] = await Promise.all([baanHistory(client, baanId, 12), sideStats(client, baanId)])
      if (!history.name) return `Kortebaan "${place}" staat niet in de kennisbank.`
      const lines = [`### ${history.name}`, ...history.editions.map((e) => `- ${formatEdition(e)}`)]
      lines.push(formatSides(sides) ?? 'Startzijde: te weinig ritten met bekende zijde.')
      return lines.join('\n')
    },
    kb_search: async (input) => {
      const q = String(input.tekst ?? '').trim()
      if (q.length < 2) return 'Zoektekst te kort.'
      return formatSearch(q, await search(client, q.slice(0, 100), origins))
    },
    kb_record_claim: async (input) => {
      const claims = (Array.isArray(input.claims) ? input.claims : []) as ClaimInput[]
      const r = await recordClaims(client, env, claims, today, `ai-${mode}`)
      const parts = [`${r.stored} vastgelegd`]
      if (r.replaced) parts.push(`${r.replaced} ouder feit vervangen`)
      if (r.duplicates) parts.push(`${r.duplicates} stond er al`)
      if (r.unknown.length) parts.push(`onbekend in de kennisbank (als twijfelgeval opgeslagen): ${[...new Set(r.unknown)].join(', ')}`)
      return parts.join('; ') + '.'
    },
  }

  return {
    tools: MODE_TOOLS[mode].map((name) => KB_TOOLS[name]!),
    runTool: async (name, input) => {
      const fn = allowed.has(name) ? run[name] : undefined
      if (!fn) throw new Error(`Onbekende tool: ${name}`)
      return fn((input ?? {}) as Record<string, unknown>)
    },
  }
}
