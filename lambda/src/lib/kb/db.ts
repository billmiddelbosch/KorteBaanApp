// Connection to the kennisbank (Aurora DSQL, Postgres-compatible) with an IAM auth token.
// Connecting costs ~0.5 s, so a Lambda keeps its client between invocations. DSQL uses
// optimistic concurrency: a conflicting commit fails with SQLSTATE 40001 (OC000/OC001) and is
// retried as a whole. A transaction may touch at most 3,000 rows and must not mix DDL and DML.
import { DsqlSigner } from '@aws-sdk/dsql-signer'
import pg from 'pg'

export type KbRole = 'admin' | 'kb_writer' | 'kb_reader'

export interface KbConfig {
  host: string
  region?: string
  role: KbRole
}

// A DSQL connection lives at most 60 minutes; renew well before that
const MAX_AGE_MS = 50 * 60 * 1000

export async function connect({ host, region = process.env.AWS_REGION ?? 'eu-west-2', role }: KbConfig): Promise<pg.Client> {
  const signer = new DsqlSigner({ hostname: host, region })
  const password = role === 'admin' ? await signer.getDbConnectAdminAuthToken() : await signer.getDbConnectAuthToken()
  const client = new pg.Client({
    host,
    port: 5432,
    user: role,
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 10_000,
  })
  await client.connect()
  return client
}

// One client per host and role (the MCP server uses both kb_writer and kb_reader)
const cached = new Map<string, { client: pg.Client; since: number; broken: boolean }>()

// Reused client for Lambda handlers
export async function kbClient(config: KbConfig): Promise<pg.Client> {
  const key = `${config.host}|${config.role}`
  const hit = cached.get(key)
  if (hit && !hit.broken && Date.now() - hit.since < MAX_AGE_MS) return hit.client
  if (hit) {
    cached.delete(key)
    await hit.client.end().catch(() => {})
  }
  const client = await connect(config)
  const entry = { client, since: Date.now(), broken: false }
  const markBroken = () => {
    entry.broken = true
  }
  client.on('error', markBroken)
  client.on('end', markBroken)
  cached.set(key, entry)
  return client
}

export function isConflict(err: unknown): boolean {
  const e = err as { code?: string; message?: string }
  return e?.code === '40001' || /\bOC00[01]\b/.test(e?.message ?? '')
}

// Runs fn in a transaction, retrying on optimistic-concurrency conflicts
export async function tx<T>(client: pg.Client, fn: (c: pg.Client) => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    await client.query('begin')
    try {
      const result = await fn(client)
      await client.query('commit')
      return result
    } catch (err) {
      await client.query('rollback').catch(() => {})
      if (!isConflict(err) || attempt >= attempts) throw err
      await new Promise((r) => setTimeout(r, 50 * 2 ** attempt + Math.random() * 50))
    }
  }
}

// Multi-row insert: "insert into <table> (cols) values ($1,$2),($3,$4) <suffix>", in chunks
export async function insertMany(
  client: pg.Client,
  table: string,
  columns: string[],
  rows: unknown[][],
  suffix = '',
  chunk = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk)
    const params: unknown[] = []
    const values = part.map((row) => `(${row.map((v) => `$${params.push(v)}`).join(',')})`)
    await client.query(`insert into ${table} (${columns.join(',')}) values ${values.join(',')} ${suffix}`, params)
  }
}
