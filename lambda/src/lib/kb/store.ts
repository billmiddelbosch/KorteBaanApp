// Writes DraverijRecords into the kennisbank. Names are resolved to horse/pikeur/stal ids via the
// Kortebaanbond id, the normalised name or a known alias; unknown names become new entities.
// A record never overwrites a draverij that is already known in more detail.
import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { insertMany, tx } from './db'
import { DETAIL_RANK, RELIABILITY, type DraverijRecord, type HorseRef, type Ref, type SourceRef } from './record'
import { nameKey } from './text'

export type EntityKind = 'horse' | 'pikeur' | 'stal'

interface Entity {
  id: string
  kbbId: number | null
  geslacht?: string | null
  birthYear?: number | null
}

export const sourceId = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 24)

// In-memory index of all entities; loaded once per run (a few thousand rows)
export class Resolver {
  private byKey: Record<EntityKind, Map<string, Entity>> = { horse: new Map(), pikeur: new Map(), stal: new Map() }
  private byKbb: Record<'horse' | 'pikeur', Map<number, Entity>> = { horse: new Map(), pikeur: new Map() }

  static async load(client: pg.Client): Promise<Resolver> {
    const r = new Resolver()
    const horses = await client.query<{ id: string; name_key: string; kbb_id: number | null; geslacht: string | null; birth_year: number | null }>(
      `select id, name_key, kbb_id, geslacht, birth_year from kb.horse`,
    )
    for (const h of horses.rows) r.index('horse', h.name_key, { id: h.id, kbbId: h.kbb_id, geslacht: h.geslacht, birthYear: h.birth_year })
    const pikeurs = await client.query<{ id: string; name_key: string; kbb_id: number | null }>(`select id, name_key, kbb_id from kb.pikeur`)
    for (const p of pikeurs.rows) r.index('pikeur', p.name_key, { id: p.id, kbbId: p.kbb_id })
    const stallen = await client.query<{ id: string; name_key: string }>(`select id, name_key from kb.stal`)
    for (const s of stallen.rows) r.index('stal', s.name_key, { id: s.id, kbbId: null })
    const aliases = await client.query<{ kind: EntityKind; name_key: string; entity_id: string }>(`select kind, name_key, entity_id from kb.alias`)
    const byId = new Map<string, Entity>()
    for (const kind of ['horse', 'pikeur', 'stal'] as const) for (const e of r.byKey[kind].values()) byId.set(e.id, e)
    for (const a of aliases.rows) {
      const entity = byId.get(a.entity_id)
      if (entity) r.byKey[a.kind].set(a.name_key, entity)
    }
    return r
  }

  private index(kind: EntityKind, key: string, entity: Entity) {
    this.byKey[kind].set(key, entity)
    if (entity.kbbId !== null && kind !== 'stal') this.byKbb[kind].set(entity.kbbId, entity)
  }

  // Resolves a name; `pending` collects the inserts/updates for the caller to write
  resolve(kind: EntityKind, ref: Ref | HorseRef, pending: Pending, sourceId: string): string | null {
    const key = nameKey(ref.name)
    if (!key) return null
    const kbbId = kind === 'stal' ? null : (ref.kbbId ?? null)
    let entity = (kbbId !== null && kind !== 'stal' ? this.byKbb[kind].get(kbbId) : undefined) ?? this.byKey[kind].get(key)
    const horse = kind === 'horse' ? (ref as HorseRef) : null

    if (!entity) {
      entity = { id: randomUUID(), kbbId, geslacht: horse?.geslacht ?? null, birthYear: horse?.birthYear ?? null }
      this.index(kind, key, entity)
      pending.inserts[kind].push({ id: entity.id, name: ref.name, key, kbbId, geslacht: entity.geslacht, birthYear: entity.birthYear })
      return entity.id
    }

    if (!this.byKey[kind].has(key)) {
      // Known via its Kortebaanbond id under another spelling
      this.byKey[kind].set(key, entity)
      pending.aliases.push({ kind, key, entityId: entity.id, name: ref.name, sourceId })
    }
    const update: EntityUpdate = { kind, id: entity.id }
    if (kbbId !== null && entity.kbbId === null && kind !== 'stal' && !this.byKbb[kind].has(kbbId)) {
      entity.kbbId = update.kbbId = kbbId
      this.byKbb[kind].set(kbbId, entity)
    }
    if (horse?.geslacht && !entity.geslacht) entity.geslacht = update.geslacht = horse.geslacht
    if (horse?.birthYear && !entity.birthYear) entity.birthYear = update.birthYear = horse.birthYear
    if (Object.keys(update).length > 2) pending.updates.push(update)
    return entity.id
  }
}

interface EntityInsert {
  id: string
  name: string
  key: string
  kbbId: number | null
  geslacht?: string | null
  birthYear?: number | null
}

interface EntityUpdate {
  kind: EntityKind
  id: string
  kbbId?: number
  geslacht?: string
  birthYear?: number
}

export interface Pending {
  inserts: Record<EntityKind, EntityInsert[]>
  aliases: { kind: EntityKind; key: string; entityId: string; name: string; sourceId: string }[]
  updates: EntityUpdate[]
}

const emptyPending = (): Pending => ({ inserts: { horse: [], pikeur: [], stal: [] }, aliases: [], updates: [] })

async function writeSources(client: pg.Client, sources: SourceRef[]) {
  const unique = [...new Map(sources.map((s) => [s.url, s])).values()]
  await insertMany(
    client,
    'kb.source',
    ['id', 'url', 'kind', 'reliability', 'title'],
    unique.map((s) => [sourceId(s.url), s.url, s.kind, RELIABILITY[s.kind], s.title ?? null]),
    `on conflict (id) do update set fetched_at = now(), title = coalesce(excluded.title, kb.source.title)`,
  )
}

async function writeEntities(client: pg.Client, pending: Pending) {
  const h = pending.inserts.horse
  if (h.length)
    await insertMany(
      client,
      'kb.horse',
      ['id', 'name', 'name_key', 'kbb_id', 'geslacht', 'birth_year'],
      h.map((e) => [e.id, e.name, e.key, e.kbbId, e.geslacht ?? null, e.birthYear ?? null]),
    )
  const p = pending.inserts.pikeur
  if (p.length) await insertMany(client, 'kb.pikeur', ['id', 'name', 'name_key', 'kbb_id'], p.map((e) => [e.id, e.name, e.key, e.kbbId]))
  const s = pending.inserts.stal
  if (s.length) await insertMany(client, 'kb.stal', ['id', 'name', 'name_key'], s.map((e) => [e.id, e.name, e.key]))
  if (pending.aliases.length)
    await insertMany(
      client,
      'kb.alias',
      ['kind', 'name_key', 'entity_id', 'name', 'source_id'],
      pending.aliases.map((a) => [a.kind, a.key, a.entityId, a.name, a.sourceId]),
      'on conflict (kind, name_key) do nothing',
    )
  for (const u of pending.updates) {
    if (u.kind === 'horse')
      await client.query(
        `update kb.horse set kbb_id = coalesce(kbb_id, $2), geslacht = coalesce(geslacht, $3), birth_year = coalesce(birth_year, $4) where id = $1`,
        [u.id, u.kbbId ?? null, u.geslacht ?? null, u.birthYear ?? null],
      )
    else if (u.kind === 'pikeur' && u.kbbId !== undefined)
      await client.query(`update kb.pikeur set kbb_id = coalesce(kbb_id, $2) where id = $1`, [u.id, u.kbbId])
  }
}

export type WriteResult = 'written' | 'skipped'

export async function writeRecord(client: pg.Client, resolver: Resolver, record: DraverijRecord): Promise<WriteResult> {
  const existing = await client.query<{ detail: keyof typeof DETAIL_RANK }>(`select detail from kb.draverij where id = $1`, [record.id])
  const current = existing.rows[0]?.detail
  if (current && DETAIL_RANK[current] > DETAIL_RANK[record.detail]) return 'skipped'

  const src = sourceId(record.source.url)
  const pending = emptyPending()
  // A name without letters or digits (e.g. "-" in the statistieken) resolves to null: skip it
  const deelnames = record.deelnames
    .map((d) => ({
      d,
      horse: resolver.resolve('horse', d.horse, pending, src),
      pikeur: d.pikeur ? resolver.resolve('pikeur', d.pikeur, pending, src) : null,
      stal: d.stal ? resolver.resolve('stal', { name: d.stal }, pending, src) : null,
    }))
    .filter((x): x is typeof x & { horse: string } => x.horse !== null)
  const horseOf = (name: string | null) => (name ? resolver.resolve('horse', { name }, pending, src) : null)
  const pikeurOf = (name: string | null) => (name ? resolver.resolve('pikeur', { name }, pending, src) : null)
  const koppels = record.koppels
    .map((k) => ({
      k,
      id: `${record.id}:${k.omloop}:${k.nr}`,
      a: horseOf(k.a),
      b: horseOf(k.b),
      pikeurA: pikeurOf(k.pikeurA),
      pikeurB: pikeurOf(k.pikeurB),
      winner: horseOf(k.winner),
      ritten: k.ritten.map((name) => horseOf(name)),
    }))
    .filter((x): x is typeof x & { a: string } => x.a !== null)

  // Sources, baan and new entities are idempotent, so they go before the draverij transaction
  await tx(client, async (c) => {
    await writeSources(c, record.sources)
    await c.query(
      `insert into kb.baan (id, name, lat, lon) values ($1, $2, $3, $4)
       on conflict (id) do update set lat = coalesce(kb.baan.lat, excluded.lat), lon = coalesce(kb.baan.lon, excluded.lon)`,
      [record.baan.id, record.baan.name, record.baan.lat, record.baan.lon],
    )
    await writeEntities(c, pending)
  })

  await tx(client, async (c) => {
    await c.query(
      `insert into kb.draverij (id, baan_id, date, detail, starters, uitloters, totalisator_omzet, totalisator, cancelled, cancel_reason, kbb_event_id, source_id, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
       on conflict (id) do update set detail = excluded.detail,
         starters = coalesce(excluded.starters, kb.draverij.starters),
         uitloters = coalesce(excluded.uitloters, kb.draverij.uitloters),
         totalisator_omzet = coalesce(excluded.totalisator_omzet, kb.draverij.totalisator_omzet),
         totalisator = coalesce(excluded.totalisator, kb.draverij.totalisator),
         cancelled = excluded.cancelled, cancel_reason = excluded.cancel_reason,
         kbb_event_id = coalesce(excluded.kbb_event_id, kb.draverij.kbb_event_id),
         source_id = excluded.source_id, updated_at = now()`,
      [
        record.id,
        record.baan.id,
        record.date,
        record.detail,
        record.starters,
        record.uitloters,
        record.omzet,
        record.totalisator ? JSON.stringify(record.totalisator) : null,
        record.cancelled,
        record.cancelReason,
        record.kbbEventId,
        src,
      ],
    )
    // Replace the shared hard data of this draverij; AI/user rows (origin dev/prod) stay
    await c.query(`delete from kb.rit where koppel_id in (select id from kb.koppel where draverij_id = $1 and origin = 'shared')`, [record.id])
    await c.query(`delete from kb.koppel where draverij_id = $1 and origin = 'shared'`, [record.id])
    await c.query(`delete from kb.deelname where draverij_id = $1 and origin = 'shared'`, [record.id])

    const unique = [...new Map(deelnames.map((x) => [x.horse, x])).values()]
    await insertMany(
      c,
      'kb.deelname',
      ['draverij_id', 'horse_id', 'pikeur_id', 'stal_id', 'startnr', 'afstand', 'leeftijd', 'bijgeloot', 'omloop_bereikt', 'klassering', 'prijs', 'punten', 'source_id'],
      unique.map(({ d, horse, pikeur, stal }) => [
        record.id,
        horse,
        pikeur,
        stal,
        d.startnr,
        d.afstand,
        d.leeftijd,
        d.bijgeloot,
        d.omloopBereikt,
        d.klassering,
        d.prijs,
        d.punten,
        src,
      ]),
      `on conflict (draverij_id, horse_id) do update set pikeur_id = excluded.pikeur_id, stal_id = excluded.stal_id,
        startnr = excluded.startnr, afstand = excluded.afstand, leeftijd = excluded.leeftijd, bijgeloot = excluded.bijgeloot,
        omloop_bereikt = excluded.omloop_bereikt, klassering = excluded.klassering, prijs = excluded.prijs,
        punten = excluded.punten, origin = 'shared', source_id = excluded.source_id`,
    )
    const ritSrc = record.sources.find((s) => s.kind === 'kbb_ritverloop_pdf')
    const koppelSrc = ritSrc ? sourceId(ritSrc.url) : src
    await insertMany(
      c,
      'kb.koppel',
      ['id', 'draverij_id', 'omloop', 'nr', 'beslissend', 'horse_a', 'horse_b', 'pikeur_a', 'pikeur_b', 'bijgeloot_a', 'bijgeloot_b', 'winner', 'source_id'],
      koppels.map(({ k, id, a, b, pikeurA, pikeurB, winner }) => [
        id,
        record.id,
        k.omloop,
        k.nr,
        k.beslissend,
        a,
        b,
        pikeurA,
        pikeurB,
        k.bijgelootA,
        k.bijgelootB,
        winner,
        koppelSrc,
      ]),
      `on conflict (id) do update set horse_a = excluded.horse_a, horse_b = excluded.horse_b, pikeur_a = excluded.pikeur_a,
        pikeur_b = excluded.pikeur_b, bijgeloot_a = excluded.bijgeloot_a, bijgeloot_b = excluded.bijgeloot_b,
        winner = excluded.winner, beslissend = excluded.beslissend, status = 'definitief', origin = 'shared', source_id = excluded.source_id`,
    )
    await insertMany(
      c,
      'kb.rit',
      ['koppel_id', 'nr', 'winner'],
      koppels.flatMap(({ id, ritten }) => ritten.map((winner, i) => [id, i + 1, winner])),
    )
  })
  return 'written'
}

export interface Weather {
  tempMax: number | null
  tempMin: number | null
  neerslagMm: number | null
  windKmh: number | null
  weercode: number | null
  sourceUrl: string
}

export async function writeWeather(client: pg.Client, draverijId: string, w: Weather): Promise<void> {
  await tx(client, async (c) => {
    await writeSources(c, [{ url: w.sourceUrl, kind: 'open_meteo', title: 'Open-Meteo' }])
    await c.query(
      `insert into kb.omstandigheden (draverij_id, temp_max, temp_min, neerslag_mm, wind_kmh, weercode, source_id, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (draverij_id) do update set temp_max = excluded.temp_max, temp_min = excluded.temp_min,
         neerslag_mm = excluded.neerslag_mm, wind_kmh = excluded.wind_kmh, weercode = excluded.weercode,
         source_id = excluded.source_id, updated_at = now()`,
      [draverijId, w.tempMax, w.tempMin, w.neerslagMm, w.windKmh, w.weercode, sourceId(w.sourceUrl)],
    )
  })
}

// What the daily ingest needs to know to skip finished draverijen
export async function knownState(client: pg.Client, ids: string[]): Promise<Map<string, { detail: string; weather: boolean }>> {
  if (!ids.length) return new Map()
  const res = await client.query<{ id: string; detail: string; weather: boolean }>(
    `select d.id, d.detail, (o.draverij_id is not null) as weather
     from kb.draverij d left join kb.omstandigheden o on o.draverij_id = d.id
     where d.id = any($1)`,
    [ids],
  )
  return new Map(res.rows.map((r) => [r.id, { detail: r.detail, weather: r.weather }]))
}
