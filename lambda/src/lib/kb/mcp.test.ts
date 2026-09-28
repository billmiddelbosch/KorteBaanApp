import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { handleMessage, SQL_ROW_LIMIT, type McpContext } from './mcp'

// A pg client that answers from a list of [pattern, rows]; records every query
function fakeClient(answers: [RegExp, unknown[]][] = []) {
  const queries: { text: string; queryMode?: string }[] = []
  const client = {
    query: vi.fn(async (q: string | { text: string; queryMode?: string }) => {
      const query = typeof q === 'string' ? { text: q } : q
      queries.push(query)
      const hit = answers.find(([re]) => re.test(query.text))
      return { rows: hit ? hit[1] : [], rowCount: hit ? hit[1].length : 0 }
    }),
  }
  return { client: client as unknown as pg.Client, queries }
}

function context(scopes: McpContext['scopes'], writer = fakeClient(), reader = fakeClient()): McpContext {
  return {
    env: 'prod',
    today: '2026-09-28',
    scopes,
    writer: async () => writer.client,
    reader: async () => reader.client,
    dropReader: async () => {},
  }
}

// id null = a notification
const rpc = (method: string, params: unknown = {}, id: number | null = 1) => ({
  jsonrpc: '2.0',
  method,
  params,
  ...(id !== null ? { id } : {}),
})

describe('mcp handleMessage', () => {
  it('initializes with a supported protocol version', async () => {
    const res = await handleMessage(rpc('initialize', { protocolVersion: '2025-03-26' }), context(['kb:read']))
    expect(res?.result).toMatchObject({ protocolVersion: '2025-03-26', serverInfo: { name: 'kortebaan-kennisbank' } })
    const unknown = await handleMessage(rpc('initialize', { protocolVersion: '1999-01-01' }), context(['kb:read']))
    expect(unknown?.result).toMatchObject({ protocolVersion: '2025-06-18' })
  })

  it('does not answer notifications and rejects garbage', async () => {
    expect(await handleMessage(rpc('notifications/initialized', {}, null), context(['kb:read']))).toBeNull()
    expect(await handleMessage({ foo: 1 }, context(['kb:read']))).toMatchObject({ error: { code: -32600 } })
    expect(await handleMessage(rpc('nope'), context(['kb:read']))).toMatchObject({ error: { code: -32601 } })
  })

  it('lists only the tools the scopes allow', async () => {
    const names = async (scopes: McpContext['scopes']) =>
      ((await handleMessage(rpc('tools/list'), context(scopes)))?.result as { tools: { name: string }[] }).tools.map((t) => t.name)
    expect(await names(['kb:read'])).toEqual(['kb_field', 'kb_entity', 'kb_matchups', 'kb_conditions', 'kb_search', 'kb_lessons'])
    expect(await names(['kb:read', 'kb:write', 'kb:sql'])).toContain('kb_sql')
    const tools = ((await handleMessage(rpc('tools/list'), context(['kb:read'])))?.result as { tools: Record<string, unknown>[] }).tools
    expect(tools[0]).toHaveProperty('inputSchema')
    expect(tools[0]).not.toHaveProperty('scope')
    expect(tools.find((t) => t.name === 'kb_conditions')?.inputSchema).toMatchObject({ required: ['baan'] })
  })

  it('refuses a tool outside the scopes', async () => {
    const res = await handleMessage(rpc('tools/call', { name: 'kb_sql', arguments: { sql: 'select 1' } }), context(['kb:read']))
    expect(res?.error).toMatchObject({ code: -32602 })
  })

  it('runs kb_sql read-only, in the extended protocol, with a row limit', async () => {
    const rows = Array.from({ length: SQL_ROW_LIMIT + 5 }, (_, i) => ({ n: i }))
    const reader = fakeClient([[/from kb\.horse/, rows]])
    const res = await handleMessage(
      rpc('tools/call', { name: 'kb_sql', arguments: { sql: 'select n from kb.horse;' } }),
      context(['kb:sql'], fakeClient(), reader),
    )
    const result = res?.result as { content: { text: string }[]; isError: boolean }
    expect(result.isError).toBe(false)
    const body = JSON.parse(result.content[0]!.text) as { rijen: number; afgekapt: number; rows: unknown[] }
    expect(body).toMatchObject({ rijen: SQL_ROW_LIMIT + 5, afgekapt: SQL_ROW_LIMIT })
    expect(body.rows).toHaveLength(SQL_ROW_LIMIT)
    expect(reader.queries.map((q) => q.text)).toEqual(['begin read only', 'select n from kb.horse', 'rollback'])
    expect(reader.queries[1]!.queryMode).toBe('extended')
  })

  it('reports a failing tool as a tool error, not a protocol error', async () => {
    const reader = fakeClient()
    reader.client.query = vi.fn(async (q: string | { text: string }) => {
      if (typeof q !== 'string') throw new Error('cannot execute INSERT in a read-only transaction')
      return { rows: [] }
    }) as unknown as pg.Client['query']
    const res = await handleMessage(
      rpc('tools/call', { name: 'kb_sql', arguments: { sql: 'insert into kb.meta values (1)' } }),
      context(['kb:sql'], fakeClient(), reader),
    )
    expect(res?.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('read-only') }] })
  })

  it('reads the schema resource', async () => {
    const writer = fakeClient([
      [
        /information_schema\.columns/,
        [
          { table_name: 'horse', column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
          { table_name: 'horse', column_name: 'name', data_type: 'text', is_nullable: 'NO' },
          { table_name: 'schema_migrations', column_name: 'id', data_type: 'text', is_nullable: 'NO' },
        ],
      ],
    ])
    const res = await handleMessage(rpc('resources/read', { uri: 'kb://schema' }), context(['kb:read'], writer))
    const text = (res?.result as { contents: { text: string }[] }).contents[0]!.text
    expect(text).toContain('## kb.horse\n- id uuid not null\n- name text not null')
    expect(text).not.toContain('schema_migrations')
  })
})
