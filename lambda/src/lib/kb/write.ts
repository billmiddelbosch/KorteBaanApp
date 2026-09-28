// What the AI writes into the kennisbank: claims (facts found online), lessons (Terugblik) and
// predictions (Koersdag). Everything gets origin = the environment, so a test run never
// changes what the production AI reads.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { slugify } from '../analysis'
import { insertMany, tx } from './db'
import { currentRatings, day, resolveNames, type Env, type Named, type Origin, type Subject } from './queries'
import { winChance } from './glicko'
import { sourceId } from './store'
import { nameKey } from './text'

// ── Claims ───────────────────────────────────────────────────────────────

export const PREDICATES = ['vorm', 'blessure', 'afmelding', 'pikeur', 'eigenaar', 'training', 'baan', 'overig'] as const

export interface ClaimInput {
  tekst: string
  predicaat?: string
  paarden?: string[]
  pikeurs?: string[]
  baan?: string
  bron?: string
  geldig_tot?: string
  zekerheid?: number
}

export interface ClaimResult {
  stored: number
  duplicates: number
  replaced: number
  unknown: string[]
}

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

// Names → subjects; names the kennisbank doesn't know become kind 'onbekend' (twijfelgevallen)
async function subjectsOf(
  client: pg.Client,
  input: { paarden?: string[]; pikeurs?: string[]; baan?: string },
): Promise<{ subjects: Subject[]; unknown: string[] }> {
  const subjects: Subject[] = []
  const unknown: string[] = []
  for (const [kind, names] of [
    ['horse', input.paarden ?? []],
    ['pikeur', input.pikeurs ?? []],
  ] as const) {
    const clean = names.map((n) => String(n).trim()).filter(Boolean).slice(0, 10)
    if (!clean.length) continue
    const resolved = await resolveNames(client, kind, clean)
    for (const name of clean) {
      const hit = resolved.get(name)
      if (hit) subjects.push({ kind, id: hit.id })
      else {
        subjects.push({ kind: 'onbekend', id: name })
        unknown.push(name)
      }
    }
  }
  if (input.baan?.trim()) {
    const id = slugify(input.baan)
    const known = await client.query(`select 1 from kb.baan where id = $1`, [id])
    if (known.rowCount) subjects.push({ kind: 'baan', id })
    else {
      subjects.push({ kind: 'onbekend', id: input.baan.trim() })
      unknown.push(input.baan.trim())
    }
  }
  const seen = new Set<string>()
  return {
    subjects: subjects.filter((s) => {
      const k = `${s.kind}:${s.id}`
      return !seen.has(k) && !!seen.add(k)
    }),
    unknown,
  }
}

const subjectKey = (subjects: Subject[]) => subjects.map((s) => `${s.kind}:${s.id}`).sort()

export async function recordClaims(
  client: pg.Client,
  env: Env,
  claims: ClaimInput[],
  today: string,
  createdBy: string,
): Promise<ClaimResult> {
  const result: ClaimResult = { stored: 0, duplicates: 0, replaced: 0, unknown: [] }
  for (const claim of claims.slice(0, 10)) {
    const text = String(claim.tekst ?? '').trim().slice(0, 500)
    if (!text) continue
    const predicate = PREDICATES.includes(claim.predicaat as (typeof PREDICATES)[number]) ? claim.predicaat! : 'overig'
    const { subjects, unknown } = await subjectsOf(client, claim)
    result.unknown.push(...unknown)
    if (!subjects.length) continue

    await tx(client, async (c) => {
      const dup = await c.query(`select 1 from kb.claim where text = $1 and origin = $2 and status = 'actief' limit 1`, [text, env])
      if (dup.rowCount) {
        result.duplicates++
        return
      }
      let source: string | null = null
      const url = typeof claim.bron === 'string' && /^https?:\/\//.test(claim.bron) ? claim.bron.slice(0, 500) : null
      if (url) {
        source = sourceId(url)
        await c.query(`insert into kb.source (id, url, kind, reliability) values ($1, $2, 'web', 2) on conflict (id) do nothing`, [source, url])
      }
      // A newer claim with the same predicate about exactly the same subjects replaces the older
      const older = await c.query<{ id: string }>(
        `select c.id from kb.claim c
         where c.predicate = $1 and c.origin = $2 and c.status = 'actief'
           and (select array_agg(cs.kind || ':' || cs.entity_id order by cs.kind || ':' || cs.entity_id)
                from kb.claim_subject cs where cs.claim_id = c.id) = $3::text[]
         order by c.observed_at desc limit 1`,
        [predicate, env, subjectKey(subjects)],
      )
      const replaces = predicate === 'overig' ? null : (older.rows[0]?.id ?? null)
      if (replaces) {
        await c.query(`update kb.claim set status = 'vervangen' where id = $1`, [replaces])
        result.replaced++
      }
      const id = randomUUID()
      const confidence = clamp(typeof claim.zekerheid === 'number' ? claim.zekerheid : 0.6, 0.1, 0.95)
      await c.query(
        `insert into kb.claim (id, predicate, text, observed_at, valid_until, confidence, replaces, source_id, created_by, origin)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, predicate, text, today, isDate(claim.geldig_tot) ? claim.geldig_tot : null, confidence, replaces, source, createdBy, env],
      )
      await insertMany(
        c,
        'kb.claim_subject',
        ['claim_id', 'kind', 'entity_id'],
        subjects.map((s) => [id, s.kind, s.id]),
      )
      result.stored++
    })
  }
  return result
}

// ── Lessons ──────────────────────────────────────────────────────────────

export interface LessonInput {
  tekst: string
  paarden?: string[]
  pikeurs?: string[]
  baan?: string
  scope?: Record<string, unknown>
  bewijs?: unknown
}

export const NEW_LESSON_CONFIDENCE = 0.5

export async function saveLessons(
  client: pg.Client,
  env: Env,
  lessons: LessonInput[],
  draverijId: string | null,
  createdBy = 'terugblik',
): Promise<string[]> {
  const ids: string[] = []
  for (const lesson of lessons) {
    const text = String(lesson.tekst ?? '').trim().slice(0, 500)
    if (!text) continue
    const { subjects } = await subjectsOf(client, lesson)
    const id = randomUUID()
    await tx(client, async (c) => {
      await c.query(
        `insert into kb.lesson (id, text, scope, evidence, confidence, draverij_id, created_by, origin)
         values ($1, $2, $3, $4, $5, $6, $8, $7)`,
        [
          id,
          text,
          lesson.scope && typeof lesson.scope === 'object' ? JSON.stringify(lesson.scope) : null,
          lesson.bewijs !== undefined ? JSON.stringify(lesson.bewijs) : null,
          NEW_LESSON_CONFIDENCE,
          draverijId,
          env,
          createdBy,
        ],
      )
      const known = subjects.filter((s) => s.kind !== 'onbekend')
      if (known.length) await insertMany(c, 'kb.lesson_subject', ['lesson_id', 'kind', 'entity_id'], known.map((s) => [id, s.kind, s.id]))
    })
    ids.push(id)
  }
  return ids
}

export interface LessonVerdict {
  id: string
  oordeel: 'bevestigd' | 'weerlegd'
}

// After a Terugblik: confirmed lessons gain a little trust, refuted ones lose a lot
export function nextConfidence(confidence: number, oordeel: LessonVerdict['oordeel']): number {
  return Math.round(clamp(confidence + (oordeel === 'bevestigd' ? 0.1 : -0.2), 0, 0.95) * 100) / 100
}

export const DISPUTED_BELOW = 0.2

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function checkLessons(client: pg.Client, env: Env, verdicts: LessonVerdict[], today: string): Promise<number> {
  let changed = 0
  for (const v of verdicts) {
    if (!UUID.test(v.id)) continue
    await tx(client, async (c) => {
      const res = await c.query<{ confidence: number }>(`select confidence from kb.lesson where id = $1 and origin = $2 and status = 'actief'`, [
        v.id,
        env,
      ])
      const row = res.rows[0]
      if (!row) return
      const confidence = nextConfidence(row.confidence, v.oordeel)
      await c.query(`update kb.lesson set confidence = $2, last_checked = $3, status = $4 where id = $1`, [
        v.id,
        confidence,
        today,
        confidence < DISPUTED_BELOW ? 'betwist' : 'actief',
      ])
      changed++
    })
  }
  return changed
}

export interface ListedLesson {
  id: string
  text: string
  createdAt: string
  draverijId?: string
  place?: string
  date?: string
}

// The Terugblik "Lessen" list: this environment's active lessons, newest first
export async function listLessons(client: pg.Client, env: Env, limit: number): Promise<ListedLesson[]> {
  const res = await client.query<{
    id: string
    text: string
    created_at: Date
    draverij_id: string | null
    place: string | null
    date: Date | string | null
  }>(
    `select l.id, l.text, l.created_at, l.draverij_id, b.name as place, d.date
     from kb.lesson l
     left join kb.draverij d on d.id = l.draverij_id
     left join kb.baan b on b.id = d.baan_id
     where l.origin = $1 and l.status = 'actief'
     order by l.created_at desc limit $2`,
    [env, limit],
  )
  return res.rows.map((r) => ({
    id: r.id,
    text: r.text,
    createdAt: new Date(r.created_at).toISOString(),
    ...(r.draverij_id ? { draverijId: r.draverij_id } : {}),
    ...(r.place ? { place: r.place } : {}),
    ...(r.date ? { date: day(r.date) } : {}),
  }))
}

export async function removeLesson(client: pg.Client, env: Env, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false
  const res = await client.query(`update kb.lesson set status = 'verwijderd' where id = $1 and origin = $2 and status <> 'verwijderd'`, [id, env])
  return (res.rowCount ?? 0) > 0
}

// ── Predictions ──────────────────────────────────────────────────────────

export interface Kans {
  omloop: number
  koppel: number
  links: string
  rechts: string
  // Chance that `links` wins the koppel, 0–1
  winkansLinks: number | null // null: no AI chance (the pipeline's rating-only prediction)
  quotaLinks: number | null
  quotaRechts: number | null
}

// Totalisator chance from the two win quotes (the overround is divided out)
export function toteChance(quotaA: number | null, quotaB: number | null): number | null {
  if (!quotaA || !quotaB || quotaA <= 1 || quotaB <= 1) return null
  return 1 / quotaA / (1 / quotaA + 1 / quotaB)
}

// Horses the kennisbank doesn't know yet (debutants) are added so their prediction can be scored
async function horsesFor(client: pg.Client, names: string[]): Promise<Map<string, Named | null>> {
  const resolved = await resolveNames(client, 'horse', names)
  for (const name of names) {
    if (resolved.get(name) || nameKey(name).length < 3) continue
    const id = randomUUID()
    await client.query(`insert into kb.horse (id, name, name_key) values ($1, $2, $3) on conflict (name_key) do nothing`, [id, name.trim(), nameKey(name)])
    const row = await client.query<Named>(`select id, name from kb.horse where name_key = $1`, [nameKey(name)])
    resolved.set(name, row.rows[0] ?? null)
  }
  return resolved
}

export async function recordPredictions(client: pg.Client, env: Origin, draverijId: string, kansen: Kans[], adviesRef: string | null): Promise<number> {
  if (!kansen.length) return 0
  const names = [...new Set(kansen.flatMap((k) => [k.links, k.rechts]))]
  const horses = await horsesFor(client, names)
  const ratings = await currentRatings(
    client,
    [...horses.values()].filter((h): h is Named => !!h).map((h) => h.id),
  )
  const rows: unknown[][] = []
  for (const k of kansen) {
    const a = horses.get(k.links)
    const b = horses.get(k.rechts)
    if (!a) continue
    const ra = ratings.get(a.id)
    const rb = b ? ratings.get(b.id) : undefined
    rows.push([
      randomUUID(),
      `${draverijId}:${k.omloop}:${k.koppel}`,
      draverijId,
      k.omloop,
      a.id,
      b?.id ?? null,
      k.winkansLinks === null ? null : clamp(k.winkansLinks, 0, 1),
      ra && rb ? winChance(ra, rb) : null,
      toteChance(k.quotaLinks, k.quotaRechts),
      adviesRef,
      env,
    ])
  }
  await tx(client, async (c) => {
    // A newer board replaces the earlier prediction for the same horse in the same omloop
    for (const row of rows) {
      await c.query(`delete from kb.prediction where draverij_id = $1 and omloop = $2 and horse_id = $3 and origin = $4`, [draverijId, row[3], row[4], env])
    }
    await insertMany(
      c,
      'kb.prediction',
      ['id', 'koppel_id', 'draverij_id', 'omloop', 'horse_id', 'opponent_id', 'p_ai', 'p_rating', 'p_tote', 'advies_ref', 'origin'],
      rows,
    )
  })
  return rows.length
}

// Matches predictions to the official koppels (by omloop and the two horses) and scores them
export async function scorePredictions(client: pg.Client, draverijId: string): Promise<number> {
  return tx(client, async (c) => {
    const res = await c.query(
      `update kb.prediction p set outcome = (
         select k.winner = p.horse_id from kb.koppel k
         where k.draverij_id = p.draverij_id and k.omloop = p.omloop and k.status = 'definitief' and k.winner is not null
           and ((k.horse_a = p.horse_id and k.horse_b = p.opponent_id) or (k.horse_b = p.horse_id and k.horse_a = p.opponent_id))
         limit 1)
       where p.draverij_id = $1 and p.outcome is null and p.opponent_id is not null`,
      [draverijId],
    )
    await c.query(
      `update kb.prediction set score = power(p_ai - case when outcome then 1 else 0 end, 2)
       where draverij_id = $1 and outcome is not null and p_ai is not null and score is null`,
      [draverijId],
    )
    return res.rowCount ?? 0
  })
}

export interface Scorecard {
  koppels: number
  ai: number | null
  rating: number | null
  tote: number | null
  // Worst AI misses: favourite by the AI that lost
  misses: { omloop: number; horse: string; opponent: string | null; pAi: number }[]
}

const brier = (pairs: [number | null, boolean][]) => {
  const valid = pairs.filter((p): p is [number, boolean] => p[0] !== null)
  if (!valid.length) return null
  return Math.round((valid.reduce((s, [p, o]) => s + (p - (o ? 1 : 0)) ** 2, 0) / valid.length) * 1000) / 1000
}

export async function scorecard(client: pg.Client, env: Env, draverijId: string): Promise<Scorecard> {
  const res = await client.query<{
    omloop: number
    horse: string
    opponent: string | null
    p_ai: number | null
    p_rating: number | null
    p_tote: number | null
    outcome: boolean
  }>(
    `select p.omloop, h.name as horse, o.name as opponent, p.p_ai, p.p_rating, p.p_tote, p.outcome
     from kb.prediction p
     join kb.horse h on h.id = p.horse_id
     left join kb.horse o on o.id = p.opponent_id
     where p.draverij_id = $1 and p.origin = $2 and p.outcome is not null
     order by p.omloop`,
    [draverijId, env],
  )
  const rows = res.rows
  return {
    koppels: rows.length,
    ai: brier(rows.map((r) => [r.p_ai, r.outcome])),
    rating: brier(rows.map((r) => [r.p_rating, r.outcome])),
    tote: brier(rows.map((r) => [r.p_tote, r.outcome])),
    misses: rows
      .filter((r) => r.p_ai !== null && Math.abs(r.p_ai - 0.5) >= 0.15 && r.p_ai > 0.5 !== r.outcome)
      .map((r) => ({ omloop: r.omloop, horse: r.p_ai! > 0.5 ? r.horse : (r.opponent ?? '?'), opponent: r.p_ai! > 0.5 ? r.opponent : r.horse, pAi: Math.max(r.p_ai!, 1 - r.p_ai!) }))
      .slice(0, 8),
  }
}
