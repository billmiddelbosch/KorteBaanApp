// The kennisbank as an MCP server (Streamable HTTP, stateless, JSON responses only): the same
// tools the AI workers use, plus lessons, a read-only SQL tool and the schema as a resource.
// Which tools a caller sees depends on the OAuth scopes of its token.
import type pg from 'pg'
import type { Scope } from '../oauth'
import { kbTools, KB_TOOLS } from './tools'
import type { Env } from './queries'
import { listLessons, saveLessons, type LessonInput } from './write'

export const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
export const DEFAULT_VERSION = '2025-06-18'

export const SQL_ROW_LIMIT = 200
export const SQL_TIMEOUT_MS = 10_000

export interface McpContext {
  env: Env
  today: string
  scopes: Scope[]
  // kb_writer for the tools, kb_reader for kb_sql
  writer: () => Promise<pg.Client>
  reader: () => Promise<pg.Client>
  // Drops a reader whose query was abandoned, so the next call gets a fresh connection
  dropReader: (client: pg.Client) => Promise<void>
}

interface McpTool {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  scope: Scope
  annotations: { readOnlyHint: boolean }
}

const fromKb = (name: string, title: string, scope: Scope, overrides: Partial<McpTool> = {}): McpTool => ({
  name,
  title,
  description: KB_TOOLS[name]!.description,
  inputSchema: KB_TOOLS[name]!.input_schema as Record<string, unknown>,
  scope,
  annotations: { readOnlyHint: scope !== 'kb:write' },
  ...overrides,
})

export const MCP_TOOLS: McpTool[] = [
  fromKb('kb_field', 'Paarden', 'kb:read'),
  fromKb('kb_entity', 'Paard of pikeur', 'kb:read'),
  fromKb('kb_matchups', 'Koppels', 'kb:read'),
  fromKb('kb_conditions', 'Kortebaan', 'kb:read', {
    inputSchema: { type: 'object', properties: { baan: { type: 'string', description: 'Plaats, bv. Wolvega' } }, required: ['baan'] },
  }),
  fromKb('kb_search', 'Zoeken', 'kb:read'),
  {
    name: 'kb_lessons',
    title: 'Lessen',
    description: 'Kennisbank: de actieve lessen uit eerdere terugblikken, nieuwste eerst.',
    inputSchema: { type: 'object', properties: { max: { type: 'number', description: '1–50, standaard 20' } } },
    scope: 'kb:read',
    annotations: { readOnlyHint: true },
  },
  fromKb('kb_record_claim', 'Feit vastleggen', 'kb:write'),
  {
    name: 'kb_record_lesson',
    title: 'Les vastleggen',
    description:
      'Leg een les vast: een interpretatie die bij volgende analyses en terugblikken meeweegt (bv. "Op zand in Wolvega wint links vaker"). Nieuwe lessen starten met zekerheid 50% en worden bij terugblikken getoetst.',
    inputSchema: {
      type: 'object',
      properties: {
        lessen: {
          type: 'array',
          description: 'Max 5',
          items: {
            type: 'object',
            properties: {
              tekst: { type: 'string', description: 'Eén zin, zelfstandig leesbaar' },
              paarden: { type: 'array', items: { type: 'string' } },
              pikeurs: { type: 'array', items: { type: 'string' } },
              baan: { type: 'string' },
            },
            required: ['tekst'],
          },
        },
      },
      required: ['lessen'],
    },
    scope: 'kb:write',
    annotations: { readOnlyHint: false },
  },
  {
    name: 'kb_sql',
    title: 'SQL (alleen lezen)',
    description: `Voer één SELECT uit op de kennisbank (Postgres-dialect, Aurora DSQL, schema kb; zie resource kb://schema). Alleen lezen, max ${SQL_ROW_LIMIT} rijen, max ${SQL_TIMEOUT_MS / 1000} s. Gebruik dit voor vragen die de andere tools niet beantwoorden.`,
    inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    scope: 'kb:sql',
    annotations: { readOnlyHint: true },
  },
]

const SCHEMA_NOTES = `Alle tabellen staan in schema \`kb\`. Kolom \`origin\`: 'shared' = officiële data (uitslagen, weer),
'dev'/'prod' = door de AI of eigenaar vastgelegd in die omgeving. Claims en lessen hebben een \`status\`
(actief, vervangen, betwist, verwijderd); gebruik meestal \`status = 'actief'\`. Koppels zijn tweekampen (a tegen b)
binnen een draverij; \`winner\` is 'a' of 'b'. Namen staan genormaliseerd in \`kb.alias\`.`

export type RpcId = string | number | null
export interface RpcResponse {
  jsonrpc: '2.0'
  id: RpcId
  result?: unknown
  error?: { code: number; message: string }
}

export const rpcError = (id: RpcId, code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } })
const rpcResult = (id: RpcId, result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result })

class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message)
  }
}

const visibleTools = (scopes: Scope[]) => MCP_TOOLS.filter((t) => scopes.includes(t.scope))

async function schemaText(client: pg.Client): Promise<string> {
  const res = await client.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
    `select table_name, column_name, data_type, is_nullable
     from information_schema.columns where table_schema = 'kb'
     order by table_name, ordinal_position`,
  )
  const tables = new Map<string, string[]>()
  for (const r of res.rows) {
    if (r.table_name === 'schema_migrations') continue
    const cols = tables.get(r.table_name) ?? []
    cols.push(`${r.column_name} ${r.data_type}${r.is_nullable === 'NO' ? ' not null' : ''}`)
    tables.set(r.table_name, cols)
  }
  const lines = ['# Kennisbank-schema', '', SCHEMA_NOTES, '']
  for (const [table, cols] of tables) lines.push(`## kb.${table}`, ...cols.map((c) => `- ${c}`), '')
  return lines.join('\n')
}

// Runs one read-only statement; the extended protocol refuses more than one statement
export async function runSql(ctx: McpContext, sql: string): Promise<string> {
  const text = sql.trim().replace(/;\s*$/, '')
  if (!text) return 'Geef een SQL-query mee.'
  const client = await ctx.reader()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Query duurde langer dan ${SQL_TIMEOUT_MS / 1000} s en is afgebroken.`)), SQL_TIMEOUT_MS)
  })
  try {
    const res = await Promise.race([
      (async () => {
        await client.query('begin read only')
        try {
          return await client.query({ text, queryMode: 'extended' } as pg.QueryConfig)
        } finally {
          await client.query('rollback').catch(() => {})
        }
      })(),
      timeout,
    ])
    const rows = res.rows ?? []
    return JSON.stringify({
      rijen: rows.length,
      ...(rows.length > SQL_ROW_LIMIT ? { afgekapt: SQL_ROW_LIMIT } : {}),
      rows: rows.slice(0, SQL_ROW_LIMIT),
    })
  } catch (err) {
    if ((err as Error).message.startsWith('Query duurde')) await ctx.dropReader(client)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function callTool(ctx: McpContext, name: string, args: Record<string, unknown>): Promise<string> {
  const tool = MCP_TOOLS.find((t) => t.name === name)
  if (!tool) throw new RpcError(-32602, `Onbekende tool: ${name}`)
  if (!ctx.scopes.includes(tool.scope)) throw new RpcError(-32602, `Geen toegang tot ${name} (scope ${tool.scope} nodig)`)
  switch (name) {
    case 'kb_sql':
      return runSql(ctx, String(args.sql ?? ''))
    case 'kb_lessons': {
      const max = Math.min(50, Math.max(1, Math.floor(Number(args.max) || 20)))
      const lessons = await listLessons(await ctx.writer(), ctx.env, max)
      if (!lessons.length) return 'Nog geen lessen.'
      return lessons
        .map((l) => `- [${l.id}] ${l.text}${l.place ? ` (${l.place}${l.date ? ` ${l.date}` : ''})` : ''}`)
        .join('\n')
    }
    case 'kb_record_lesson': {
      const lessons = (Array.isArray(args.lessen) ? args.lessen : []).slice(0, 5) as LessonInput[]
      const ids = await saveLessons(await ctx.writer(), ctx.env, lessons, null, 'mcp')
      return ids.length ? `${ids.length} les(sen) vastgelegd.` : 'Geen les met tekst meegegeven.'
    }
    default: {
      const { runTool } = kbTools({ client: await ctx.writer(), env: ctx.env, today: ctx.today, place: '' }, 'mcp')
      return runTool(name, args)
    }
  }
}

// Handles one JSON-RPC message; null for a notification (answered with 202, no body)
export async function handleMessage(message: unknown, ctx: McpContext): Promise<RpcResponse | null> {
  const msg = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // A response from the client (we never ask anything) or garbage
    return msg && typeof msg === 'object' && 'id' in msg && !('method' in msg) ? null : rpcError(null, -32600, 'Invalid Request')
  }
  if (!('id' in msg)) return null
  const id = (typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null) as RpcId
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>

  try {
    switch (msg.method) {
      case 'initialize': {
        const asked = String(params.protocolVersion ?? '')
        return rpcResult(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : DEFAULT_VERSION,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: { name: 'kortebaan-kennisbank', title: 'KorteBaan kennisbank', version: '1.0.0' },
          instructions:
            'Kennisbank van de Friese/Nederlandse kortebaandraverijen: uitslagen sinds 2016 (vanaf 2023 met rittenverloop), weer, ratings, feiten en lessen. Antwoorden zijn Nederlandstalig. Begin met kb_search of kb_entity; lees kb://schema voordat je kb_sql gebruikt.',
        })
      }
      case 'ping':
        return rpcResult(id, {})
      case 'tools/list':
        return rpcResult(id, {
          tools: visibleTools(ctx.scopes).map(({ scope: _s, ...t }) => t),
        })
      case 'tools/call': {
        const name = String(params.name ?? '')
        const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>
        try {
          const text = await callTool(ctx, name, args)
          return rpcResult(id, { content: [{ type: 'text', text }], isError: false })
        } catch (err) {
          if (err instanceof RpcError) throw err
          console.error(`mcp: ${name} mislukt`, err)
          return rpcResult(id, { content: [{ type: 'text', text: `Mislukt: ${(err as Error).message}` }], isError: true })
        }
      }
      case 'resources/list':
        return rpcResult(id, {
          resources: [
            { uri: 'kb://schema', name: 'schema', title: 'Kennisbank-schema', description: 'Tabellen en kolommen, voor kb_sql', mimeType: 'text/markdown' },
          ],
        })
      case 'resources/templates/list':
        return rpcResult(id, { resourceTemplates: [] })
      case 'resources/read': {
        if (params.uri !== 'kb://schema') throw new RpcError(-32602, `Onbekende resource: ${String(params.uri)}`)
        const text = await schemaText(await ctx.writer())
        return rpcResult(id, { contents: [{ uri: 'kb://schema', mimeType: 'text/markdown', text }] })
      }
      default:
        throw new RpcError(-32601, `Method not found: ${msg.method}`)
    }
  } catch (err) {
    if (err instanceof RpcError) return rpcError(id, err.code, err.message)
    console.error(`mcp: ${msg.method} mislukt`, err)
    return rpcError(id, -32603, 'Interne fout')
  }
}
