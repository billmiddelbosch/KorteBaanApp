// Read queries on the kennisbank for the workers (dossier and tools). Hard data has origin
// 'shared'; what the AI or users wrote is only visible within the environments of `origins`.
import type pg from 'pg'
import type { Rating } from './glicko'
import { nameKey } from './text'

export type Origin = 'shared' | 'dev' | 'prod'
export type Env = 'dev' | 'prod'

// prod sees only its own AI data; dev sees everything so it can be tested against real lessons
export const originsFor = (env: Env): Origin[] => (env === 'prod' ? ['shared', 'prod'] : ['shared', 'dev', 'prod'])

export type NamedKind = 'horse' | 'pikeur' | 'stal'
const TABLE: Record<NamedKind, string> = { horse: 'kb.horse', pikeur: 'kb.pikeur', stal: 'kb.stal' }

export interface Named {
  id: string
  name: string
}

// Names → entities: exact key, known alias, else a unique partial match ("Fleur" → "Fleur de Lis")
export async function resolveNames(client: pg.Client, kind: NamedKind, names: string[]): Promise<Map<string, Named | null>> {
  const result = new Map<string, Named | null>()
  const keys = [...new Set(names.map(nameKey).filter((k) => k.length >= 2))]
  if (!keys.length) {
    for (const n of names) result.set(n, null)
    return result
  }
  const exact = await client.query<{ key: string; id: string; name: string }>(
    `select e.name_key as key, e.id, e.name from ${TABLE[kind]} e where e.name_key = any($1)
     union all
     select a.name_key as key, e.id, e.name from kb.alias a join ${TABLE[kind]} e on e.id = a.entity_id
     where a.kind = $2 and a.name_key = any($1)`,
    [keys, kind],
  )
  const byKey = new Map(exact.rows.map((r) => [r.key, { id: r.id, name: r.name }]))
  for (const name of names) {
    const key = nameKey(name)
    let hit = byKey.get(key) ?? null
    if (!hit && key.length >= 4) {
      const partial = await client.query<Named>(`select id, name from ${TABLE[kind]} where name_key like $1 limit 2`, [`%${key}%`])
      if (partial.rowCount === 1) hit = partial.rows[0]!
    }
    result.set(name, hit)
  }
  return result
}

// ── Horses ───────────────────────────────────────────────────────────────

export interface Start {
  date: string
  baan: string
  pikeur: string | null
  klassering: number | null
  omloopBereikt: number | null
  bijgeloot: boolean
  won: number
  lost: number
  detail: string
}

// Latest starts of a horse with its koppel record that day
export async function recentStarts(client: pg.Client, horseId: string, limit = 8): Promise<Start[]> {
  const res = await client.query<{
    date: Date | string
    baan: string
    pikeur: string | null
    klassering: number | null
    omloop_bereikt: number | null
    bijgeloot: boolean
    won: string
    lost: string
    detail: string
  }>(
    `select d.date, b.name as baan, p.name as pikeur, dn.klassering, dn.omloop_bereikt, dn.bijgeloot, d.detail,
       (select count(*) from kb.koppel k where k.draverij_id = d.id and k.status = 'definitief' and k.winner = $1) as won,
       (select count(*) from kb.koppel k where k.draverij_id = d.id and k.status = 'definitief' and k.winner is not null
          and k.winner <> $1 and (k.horse_a = $1 or k.horse_b = $1)) as lost
     from kb.deelname dn
     join kb.draverij d on d.id = dn.draverij_id
     join kb.baan b on b.id = d.baan_id
     left join kb.pikeur p on p.id = dn.pikeur_id
     where dn.horse_id = $1 and dn.origin = 'shared'
     order by d.date desc limit $2`,
    [horseId, limit],
  )
  return res.rows.map((r) => ({
    date: day(r.date),
    baan: r.baan,
    pikeur: r.pikeur,
    klassering: r.klassering,
    omloopBereikt: r.omloop_bereikt,
    bijgeloot: r.bijgeloot,
    won: Number(r.won),
    lost: Number(r.lost),
    detail: r.detail,
  }))
}

export interface HorseTotals {
  starts: number
  wins: number
  koppelsWon: number
  koppelsLost: number
  firstYear: number | null
  lastYear: number | null
}

export async function horseTotals(client: pg.Client, horseId: string): Promise<HorseTotals> {
  const res = await client.query<{ starts: string; wins: string; first: number | null; last: number | null }>(
    `select count(*) as starts, count(*) filter (where dn.klassering = 1) as wins,
       min(extract(year from d.date))::int as first, max(extract(year from d.date))::int as last
     from kb.deelname dn join kb.draverij d on d.id = dn.draverij_id
     where dn.horse_id = $1 and dn.origin = 'shared'`,
    [horseId],
  )
  const k = await client.query<{ won: string; lost: string }>(
    `select count(*) filter (where winner = $1) as won, count(*) filter (where winner <> $1) as lost
     from kb.koppel where status = 'definitief' and winner is not null and (horse_a = $1 or horse_b = $1)`,
    [horseId],
  )
  const r = res.rows[0]!
  return {
    starts: Number(r.starts),
    wins: Number(r.wins),
    koppelsWon: Number(k.rows[0]?.won ?? 0),
    koppelsLost: Number(k.rows[0]?.lost ?? 0),
    firstYear: r.first,
    lastYear: r.last,
  }
}

export interface HeadToHead {
  date: string
  baan: string
  omloop: number
  winner: string | null
}

export async function headToHead(client: pg.Client, a: string, b: string): Promise<HeadToHead[]> {
  const res = await client.query<{ date: Date | string; baan: string; omloop: number; winner: string | null }>(
    `select d.date, bn.name as baan, k.omloop, w.name as winner
     from kb.koppel k
     join kb.draverij d on d.id = k.draverij_id
     join kb.baan bn on bn.id = d.baan_id
     left join kb.horse w on w.id = k.winner
     where k.status = 'definitief' and ((k.horse_a = $1 and k.horse_b = $2) or (k.horse_a = $2 and k.horse_b = $1))
     order by d.date desc limit 20`,
    [a, b],
  )
  return res.rows.map((r) => ({ date: day(r.date), baan: r.baan, omloop: r.omloop, winner: r.winner }))
}

// Latest overall rating per horse
export async function currentRatings(client: pg.Client, horseIds: string[]): Promise<Map<string, Rating & { date: string }>> {
  if (!horseIds.length) return new Map()
  const res = await client.query<{ horse_id: string; rating: number; rd: number; volatility: number; date: Date | string }>(
    `select distinct on (horse_id) horse_id, rating, rd, volatility, date
     from kb.rating where surface = 'alle' and horse_id = any($1)
     order by horse_id, date desc`,
    [horseIds],
  )
  return new Map(res.rows.map((r) => [r.horse_id, { rating: r.rating, rd: r.rd, volatility: r.volatility, date: day(r.date) }]))
}

// ── Pikeurs ──────────────────────────────────────────────────────────────

export interface PikeurYear {
  year: number
  koppels: number
  won: number
  dayWins: number
}

export async function pikeurStats(client: pg.Client, pikeurId: string): Promise<PikeurYear[]> {
  const res = await client.query<{ year: number; koppels: string; won: string }>(
    `select extract(year from d.date)::int as year, count(*) as koppels,
       count(*) filter (where (k.pikeur_a = $1 and k.winner = k.horse_a) or (k.pikeur_b = $1 and k.winner = k.horse_b)) as won
     from kb.koppel k join kb.draverij d on d.id = k.draverij_id
     where k.status = 'definitief' and k.winner is not null and (k.pikeur_a = $1 or k.pikeur_b = $1)
     group by 1 order by 1 desc limit 10`,
    [pikeurId],
  )
  const wins = await client.query<{ year: number; wins: string }>(
    `select extract(year from d.date)::int as year, count(*) as wins
     from kb.deelname dn join kb.draverij d on d.id = dn.draverij_id
     where dn.pikeur_id = $1 and dn.klassering = 1 and dn.origin = 'shared'
     group by 1`,
    [pikeurId],
  )
  const dayWins = new Map(wins.rows.map((r) => [r.year, Number(r.wins)]))
  const years = new Map<number, PikeurYear>()
  for (const r of res.rows) years.set(r.year, { year: r.year, koppels: Number(r.koppels), won: Number(r.won), dayWins: dayWins.get(r.year) ?? 0 })
  for (const [year, n] of dayWins) if (!years.has(year)) years.set(year, { year, koppels: 0, won: 0, dayWins: n })
  return [...years.values()].sort((a, b) => b.year - a.year)
}

// ── Baan ─────────────────────────────────────────────────────────────────

export interface BaanEdition {
  id: string
  date: string
  detail: string
  cancelled: boolean
  starters: number | null
  winner: string | null
  pikeur: string | null
  tempMax: number | null
  neerslagMm: number | null
  windKmh: number | null
}

export async function baanHistory(client: pg.Client, baanId: string, limit = 10): Promise<{ name: string | null; editions: BaanEdition[] }> {
  const baan = await client.query<{ name: string }>(`select name from kb.baan where id = $1`, [baanId])
  const res = await client.query<{
    id: string
    date: Date | string
    detail: string
    cancelled: boolean
    starters: number | null
    winner: string | null
    pikeur: string | null
    temp_max: number | null
    neerslag_mm: number | null
    wind_kmh: number | null
  }>(
    `select d.id, d.date, d.detail, d.cancelled, d.starters, h.name as winner, p.name as pikeur,
       o.temp_max, o.neerslag_mm, o.wind_kmh
     from kb.draverij d
     left join kb.deelname dn on dn.draverij_id = d.id and dn.klassering = 1 and dn.origin = 'shared'
     left join kb.horse h on h.id = dn.horse_id
     left join kb.pikeur p on p.id = dn.pikeur_id
     left join kb.omstandigheden o on o.draverij_id = d.id
     where d.baan_id = $1
     order by d.date desc limit $2`,
    [baanId, limit],
  )
  return {
    name: baan.rows[0]?.name ?? null,
    editions: res.rows.map((r) => ({
      id: r.id,
      date: day(r.date),
      detail: r.detail,
      cancelled: r.cancelled,
      starters: r.starters,
      winner: r.winner,
      pikeur: r.pikeur,
      tempMax: r.temp_max,
      neerslagMm: r.neerslag_mm,
      windKmh: r.wind_kmh,
    })),
  }
}

export interface SideStats {
  links: number
  rechts: number
}

// Ritten won from the left and right lane at this baan (zijde known where the reglement fixes it, see zijde.ts)
export async function sideStats(client: pg.Client, baanId: string): Promise<SideStats> {
  const res = await client.query<{ links: string; rechts: string }>(
    `select count(*) filter (where z.zijde_winnaar = 'links') as links,
       count(*) filter (where z.zijde_winnaar = 'rechts') as rechts
     from kb.rit_zijde z
     join kb.koppel k on k.id = z.koppel_id
     join kb.draverij d on d.id = k.draverij_id
     where d.baan_id = $1 and k.status = 'definitief' and z.zijde_winnaar is not null`,
    [baanId],
  )
  return { links: Number(res.rows[0]?.links ?? 0), rechts: Number(res.rows[0]?.rechts ?? 0) }
}

export interface ActiveHorse extends Named {
  starts: number
  koppelsWon: number
  dayWins: number
}

// Most successful horses of a season: the likely field when the starters aren't known yet
export async function seasonLeaders(client: pg.Client, year: number, limit = 20): Promise<ActiveHorse[]> {
  const res = await client.query<{ id: string; name: string; starts: string; day_wins: string; koppels_won: string }>(
    `select h.id, h.name, count(*) as starts, count(*) filter (where dn.klassering = 1) as day_wins,
       (select count(*) from kb.koppel k join kb.draverij d2 on d2.id = k.draverij_id
          where k.winner = h.id and k.status = 'definitief' and extract(year from d2.date) = $1) as koppels_won
     from kb.deelname dn
     join kb.draverij d on d.id = dn.draverij_id
     join kb.horse h on h.id = dn.horse_id
     where extract(year from d.date) = $1 and dn.origin = 'shared'
     group by h.id, h.name
     order by day_wins desc, koppels_won desc, starts desc
     limit $2`,
    [year, limit],
  )
  return res.rows.map((r) => ({ id: r.id, name: r.name, starts: Number(r.starts), koppelsWon: Number(r.koppels_won), dayWins: Number(r.day_wins) }))
}

// ── Claims and lessons ───────────────────────────────────────────────────

export interface Subject {
  kind: string
  id: string
}

export interface ClaimRow {
  id: string
  predicate: string
  text: string
  observedAt: string
  validUntil: string | null
  confidence: number
  url: string | null
  reliability: number | null
}

export async function claimsAbout(client: pg.Client, subjects: Subject[], origins: Origin[], today: string, limit = 30): Promise<ClaimRow[]> {
  if (!subjects.length) return []
  const res = await client.query<{
    id: string
    predicate: string
    text: string
    observed_at: Date | string
    valid_until: Date | string | null
    confidence: number
    url: string | null
    reliability: number | null
  }>(
    `select distinct c.id, c.predicate, c.text, c.observed_at, c.valid_until, c.confidence, s.url, s.reliability
     from kb.claim c
     join kb.claim_subject cs on cs.claim_id = c.id
     left join kb.source s on s.id = c.source_id
     where c.status = 'actief' and c.origin = any($1)
       and (c.valid_until is null or c.valid_until >= $2)
       and (cs.kind, cs.entity_id) in (select * from unnest($3::text[], $4::text[]))
     order by c.observed_at desc limit $5`,
    [origins, today, subjects.map((s) => s.kind), subjects.map((s) => s.id), limit],
  )
  return res.rows.map((r) => ({
    id: r.id,
    predicate: r.predicate,
    text: r.text,
    observedAt: day(r.observed_at),
    validUntil: r.valid_until ? day(r.valid_until) : null,
    confidence: r.confidence,
    url: r.url,
    reliability: r.reliability,
  }))
}

export interface LessonRow {
  id: string
  text: string
  confidence: number
  createdAt: string
  lastChecked: string | null
  draverijId: string | null
  scope: Record<string, unknown> | null
}

// Lessons about these subjects or this baan, then the most trusted general ones
export async function lessonsFor(client: pg.Client, subjects: Subject[], origins: Origin[], limit = 20): Promise<LessonRow[]> {
  const res = await client.query<{
    id: string
    text: string
    confidence: number
    created_at: Date | string
    last_checked: Date | string | null
    draverij_id: string | null
    scope: Record<string, unknown> | null
    relevant: boolean
  }>(
    `select l.id, l.text, l.confidence, l.created_at, l.last_checked, l.draverij_id, l.scope,
       exists (select 1 from kb.lesson_subject ls where ls.lesson_id = l.id
         and (ls.kind, ls.entity_id) in (select * from unnest($2::text[], $3::text[]))) as relevant
     from kb.lesson l
     where l.status = 'actief' and l.origin = any($1)
     order by relevant desc, l.confidence desc, l.created_at desc
     limit $4`,
    [origins, subjects.map((s) => s.kind), subjects.map((s) => s.id), limit],
  )
  return res.rows.map((r) => ({
    id: r.id,
    text: r.text,
    confidence: r.confidence,
    createdAt: day(r.created_at),
    lastChecked: r.last_checked ? day(r.last_checked) : null,
    draverijId: r.draverij_id,
    scope: r.scope,
  }))
}

export interface SearchHit {
  kind: 'paard' | 'pikeur' | 'claim' | 'les'
  text: string
  date: string | null
}

export async function search(client: pg.Client, q: string, origins: Origin[], limit = 15): Promise<SearchHit[]> {
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
  const key = `%${nameKey(q)}%`
  const res = await client.query<{ kind: SearchHit['kind']; text: string; date: Date | string | null }>(
    `(select 'paard' as kind, name as text, null::date as date from kb.horse where name_key like $1 limit 5)
     union all
     (select 'pikeur', name, null::date from kb.pikeur where name_key like $1 limit 5)
     union all
     (select 'claim', text, observed_at from kb.claim where status = 'actief' and origin = any($3) and text ilike $2 order by observed_at desc limit $4)
     union all
     (select 'les', text, created_at::date from kb.lesson where status = 'actief' and origin = any($3) and text ilike $2 order by created_at desc limit $4)`,
    [key, like, origins, limit],
  )
  return res.rows.map((r) => ({ kind: r.kind, text: r.text, date: r.date ? day(r.date) : null }))
}

export async function getMeta<T>(client: pg.Client, key: string): Promise<T | null> {
  const res = await client.query<{ value: T }>(`select value from kb.meta where key = $1`, [key])
  return res.rows[0]?.value ?? null
}

// Newest date with hard data: "stand" of the kennisbank
export async function lastIngested(client: pg.Client): Promise<string | null> {
  const res = await client.query<{ date: Date | string | null }>(`select max(date) as date from kb.draverij`)
  const d = res.rows[0]?.date
  return d ? day(d) : null
}

// pg returns `date` columns as a Date at local midnight; keep the calendar day
export function day(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10)
  const y = value.getFullYear()
  const m = String(value.getMonth() + 1).padStart(2, '0')
  const d = String(value.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
