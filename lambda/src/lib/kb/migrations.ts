// Schema of the kennisbank (schema "kb" in the single DSQL cluster shared by dev and prod).
// Migrations are additive only (add tables/columns; never rename or drop in the same release)
// because a change reaches production immediately. The owner runs them as admin before a deploy:
// `cd lambda && npm run kb-migrate -- --host <KbEndpoint> --writer-arn <KbIngestRoleArn>`.
//
// DSQL rules: every DDL statement runs in its own transaction, no sequences (ids are uuids or
// natural keys), no arrays (join tables instead), indexes are created with ASYNC.
//
// Hard data (baan, draverij, deelname, koppel, rit, omstandigheden, rating) has origin 'shared'
// and is written only by kbIngest. What the AI or a user writes (claims, lessons, predictions,
// voorlopige koppels) carries origin 'dev' or 'prod'.
import type pg from 'pg'
import { ZIJDE_ALTIJD, ZIJDE_REGEL_VANAF } from './zijde'

export interface Migration {
  id: string
  statements: string[]
}

export const MIGRATIONS: Migration[] = [
  {
    id: '001-base',
    statements: [
      `create schema if not exists kb`,
      `create table if not exists kb.schema_migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      )`,
      // Where a fact comes from; reliability 1 (forum) … 5 (official pdf)
      `create table if not exists kb.source (
        id text primary key,
        url text not null,
        kind text not null,
        reliability int not null,
        title text,
        fetched_at timestamptz not null default now()
      )`,
      `create table if not exists kb.baan (
        id text primary key,
        name text not null,
        ondergrond text,
        lengte_m int,
        lat double precision,
        lon double precision,
        updated_at timestamptz not null default now()
      )`,
      // id = "<yyyy-mm-dd>-<place slug>", the same id as the app's Draverij
      `create table if not exists kb.draverij (
        id text primary key,
        baan_id text not null references kb.baan (id),
        date date not null,
        detail text not null,
        starters int,
        uitloters int,
        totalisator_omzet numeric(12, 2),
        totalisator jsonb,
        cancelled boolean not null default false,
        cancel_reason text,
        kbb_event_id int,
        source_id text references kb.source (id),
        updated_at timestamptz not null default now()
      )`,
      `create table if not exists kb.horse (
        id uuid primary key,
        name text not null,
        name_key text not null unique,
        kbb_id int unique,
        geslacht text,
        birth_year int,
        created_at timestamptz not null default now()
      )`,
      `create table if not exists kb.pikeur (
        id uuid primary key,
        name text not null,
        name_key text not null unique,
        kbb_id int unique,
        created_at timestamptz not null default now()
      )`,
      `create table if not exists kb.stal (
        id uuid primary key,
        name text not null,
        name_key text not null unique,
        created_at timestamptz not null default now()
      )`,
      // Other spellings of a horse/pikeur/stal (kind = horse | pikeur | stal)
      `create table if not exists kb.alias (
        kind text not null,
        name_key text not null,
        entity_id uuid not null,
        name text not null,
        source_id text references kb.source (id),
        created_at timestamptz not null default now(),
        primary key (kind, name_key)
      )`,
      `create table if not exists kb.deelname (
        draverij_id text not null references kb.draverij (id),
        horse_id uuid not null references kb.horse (id),
        pikeur_id uuid references kb.pikeur (id),
        stal_id uuid references kb.stal (id),
        startnr int,
        afstand int,
        leeftijd int,
        bijgeloot boolean not null default false,
        omloop_bereikt int,
        klassering int,
        prijs numeric(10, 2),
        punten int,
        origin text not null default 'shared',
        source_id text references kb.source (id),
        primary key (draverij_id, horse_id)
      )`,
      // id = "<draverij id>:<omloop>:<koppel nr>"; zijde = links | rechts in rit 1 (see zijde.ts)
      `create table if not exists kb.koppel (
        id text primary key,
        draverij_id text not null references kb.draverij (id),
        omloop int not null,
        nr int not null,
        beslissend boolean not null default false,
        horse_a uuid not null references kb.horse (id),
        horse_b uuid references kb.horse (id),
        pikeur_a uuid references kb.pikeur (id),
        pikeur_b uuid references kb.pikeur (id),
        bijgeloot_a boolean not null default false,
        bijgeloot_b boolean not null default false,
        zijde_a text,
        zijde_b text,
        winner uuid references kb.horse (id),
        status text not null default 'definitief',
        origin text not null default 'shared',
        source_id text references kb.source (id)
      )`,
      `create table if not exists kb.rit (
        koppel_id text not null references kb.koppel (id),
        nr int not null,
        winner uuid references kb.horse (id),
        primary key (koppel_id, nr)
      )`,
      `create table if not exists kb.omstandigheden (
        draverij_id text primary key references kb.draverij (id),
        temp_max real,
        temp_min real,
        neerslag_mm real,
        wind_kmh real,
        weercode int,
        baanstaat text,
        source_id text references kb.source (id),
        updated_at timestamptz not null default now()
      )`,
      // Loose facts found online or entered by the owner; status actief | vervangen | betwist
      `create table if not exists kb.claim (
        id uuid primary key default gen_random_uuid(),
        predicate text not null,
        text text not null,
        observed_at date not null,
        valid_until date,
        confidence real not null,
        status text not null default 'actief',
        replaces uuid,
        source_id text references kb.source (id),
        created_by text not null,
        origin text not null,
        created_at timestamptz not null default now()
      )`,
      // kind = horse | pikeur | stal | baan; entity_id is the uuid or the baan id
      `create table if not exists kb.claim_subject (
        claim_id uuid not null references kb.claim (id),
        kind text not null,
        entity_id text not null,
        primary key (claim_id, kind, entity_id)
      )`,
      // Interpretations; scope (baan, ondergrond, weer, ronde, afstand) and evidence (koppel/rit ids) as jsonb
      `create table if not exists kb.lesson (
        id uuid primary key default gen_random_uuid(),
        text text not null,
        scope jsonb,
        evidence jsonb,
        confidence real not null,
        status text not null default 'actief',
        last_checked date,
        draverij_id text,
        created_by text not null,
        origin text not null,
        created_at timestamptz not null default now()
      )`,
      `create table if not exists kb.lesson_subject (
        lesson_id uuid not null references kb.lesson (id),
        kind text not null,
        entity_id text not null,
        primary key (lesson_id, kind, entity_id)
      )`,
      // Glicko-2 per horse and date; surface = alle | gras | zand | …
      `create table if not exists kb.rating (
        horse_id uuid not null references kb.horse (id),
        surface text not null,
        date date not null,
        rating real not null,
        rd real not null,
        volatility real not null,
        primary key (horse_id, surface, date)
      )`,
      // Win chance per koppel at advice time: AI vs rating vs totalisator, scored afterwards
      `create table if not exists kb.prediction (
        id uuid primary key default gen_random_uuid(),
        koppel_id text not null,
        draverij_id text not null,
        horse_id uuid not null,
        p_ai real,
        p_rating real,
        p_tote real,
        outcome boolean,
        score real,
        advies_ref text,
        origin text not null,
        created_at timestamptz not null default now()
      )`,
      `create index async if not exists draverij_baan_date on kb.draverij (baan_id, date)`,
      `create index async if not exists draverij_date on kb.draverij (date)`,
      `create index async if not exists deelname_horse on kb.deelname (horse_id)`,
      `create index async if not exists deelname_pikeur on kb.deelname (pikeur_id)`,
      `create index async if not exists koppel_draverij on kb.koppel (draverij_id)`,
      `create index async if not exists koppel_horse_a on kb.koppel (horse_a)`,
      `create index async if not exists koppel_horse_b on kb.koppel (horse_b)`,
      `create index async if not exists alias_entity on kb.alias (entity_id)`,
      `create index async if not exists claim_subject_entity on kb.claim_subject (kind, entity_id)`,
      `create index async if not exists lesson_subject_entity on kb.lesson_subject (kind, entity_id)`,
      `create index async if not exists prediction_draverij on kb.prediction (draverij_id)`,
    ],
  },
  {
    id: '002-fase2',
    statements: [
      // Predictions are matched to the (official) koppel by omloop and horse, not by koppel id
      `alter table kb.prediction add column if not exists omloop int`,
      `alter table kb.prediction add column if not exists opponent_id uuid`,
      // Voorlopige koppels from Koersdag: when they were read, so the dossier can show the age
      `alter table kb.koppel add column if not exists created_at timestamptz`,
      // Small derived values, e.g. the latest rating backtest
      `create table if not exists kb.meta (
        key text primary key,
        value jsonb not null,
        updated_at timestamptz not null default now()
      )`,
      `create index async if not exists lesson_status on kb.lesson (status)`,
      `create index async if not exists claim_status on kb.claim (status)`,
    ],
  },
  {
    // Baanzijde uit het wedstrijdreglement (zie zijde.ts); kbIngest vult hem voortaan zelf
    id: '003-zijde',
    statements: [
      `update kb.koppel k
       set zijde_a = s.zijde_a, zijde_b = s.zijde_b
       from (
         select k2.id,
           case when da.startnr > db.startnr then 'links' else 'rechts' end as zijde_a,
           case when da.startnr > db.startnr then 'rechts' else 'links' end as zijde_b
         from kb.koppel k2
         join kb.draverij d on d.id = k2.draverij_id
         join kb.deelname da on da.draverij_id = k2.draverij_id and da.horse_id = k2.horse_a
         join kb.deelname db on db.draverij_id = k2.draverij_id and db.horse_id = k2.horse_b
         where (d.date >= date '${ZIJDE_REGEL_VANAF}' or d.baan_id in (${ZIJDE_ALTIJD.map((b) => `'${b}'`).join(', ')}))
           and da.afstand is not null and da.afstand = db.afstand
       ) s
       where s.id = k.id and k.zijde_a is null`,
      // Zijde per rit: rit 1 en de kamprit (3) zoals in het koppel, rit 2 omgekeerd
      `create or replace view kb.rit_zijde as
       select t.koppel_id, t.nr as rit, k.horse_a, k.horse_b,
         case when t.nr in (1, 3) then k.zijde_a else k.zijde_b end as zijde_horse_a,
         case when t.nr in (1, 3) then k.zijde_b else k.zijde_a end as zijde_horse_b,
         t.winner,
         case when t.winner = k.horse_a then (case when t.nr in (1, 3) then k.zijde_a else k.zijde_b end)
              when t.winner = k.horse_b then (case when t.nr in (1, 3) then k.zijde_b else k.zijde_a end)
         end as zijde_winnaar
       from kb.rit t
       join kb.koppel k on k.id = t.koppel_id`,
    ],
  },
]

export const ROLES = ['kb_writer', 'kb_reader'] as const

async function applied(client: pg.Client): Promise<Set<string>> {
  const exists = await client.query(
    `select 1 from information_schema.tables where table_schema = 'kb' and table_name = 'schema_migrations'`,
  )
  if (!exists.rowCount) return new Set()
  const res = await client.query<{ id: string }>(`select id from kb.schema_migrations`)
  return new Set(res.rows.map((r) => r.id))
}

// Runs the pending migrations (as admin). Statements are idempotent, so a half-applied
// migration can simply be run again.
export async function migrate(client: pg.Client, log: (msg: string) => void = console.log): Promise<string[]> {
  const done = await applied(client)
  const ran: string[] = []
  for (const migration of MIGRATIONS) {
    if (done.has(migration.id)) continue
    log(`migratie ${migration.id} (${migration.statements.length} statements)`)
    for (const statement of migration.statements) await client.query(statement)
    await client.query(`insert into kb.schema_migrations (id) values ($1) on conflict (id) do nothing`, [migration.id])
    ran.push(migration.id)
  }
  return ran
}

// Roles and table grants (as admin); run after every migration so new tables are covered
export async function grantRoles(client: pg.Client): Promise<void> {
  const existing = await client.query<{ rolname: string }>(`select rolname from pg_roles where rolname = any($1)`, [[...ROLES]])
  const have = new Set(existing.rows.map((r) => r.rolname))
  for (const role of ROLES) if (!have.has(role)) await client.query(`create role ${role} with login`)
  await client.query(`grant usage on schema kb to kb_writer, kb_reader`)
  await client.query(`grant select, insert, update, delete on all tables in schema kb to kb_writer`)
  await client.query(`revoke all on kb.schema_migrations from kb_writer`)
  await client.query(`grant select on all tables in schema kb to kb_reader`)
}

// Lets an IAM role (e.g. a Lambda execution role) connect as a database role
export async function mapIamRole(client: pg.Client, role: (typeof ROLES)[number], arn: string): Promise<void> {
  if (!/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(arn)) throw new Error(`Geen geldige IAM-rol-ARN: ${arn}`)
  await client.query(`aws iam grant ${role} to '${arn}'`)
}
