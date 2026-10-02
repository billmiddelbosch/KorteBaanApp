import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda'
import { aliasOf } from './lib/http'
import { kbClient } from './lib/kb/db'
import { handleMessage, rpcError, type McpContext } from './lib/kb/mcp'
import { authenticateBearer, issuerOf, protectedResourceMetadata } from './lib/oauth'
import { dayOf } from './lib/store'

// The kennisbank MCP server for Claude Code and claude.ai, behind OAuth, on a Lambda Function
// URL per alias (see mcpUrlOf in lib/oauth). Stateless: no sessions, no server-sent events;
// every POST /mcp is one JSON-RPC message. The login itself is on API Gateway (oauth handler).

type Result = Exclude<APIGatewayProxyResultV2, string>

const json = (statusCode: number, body: unknown, headers: Record<string, string> = {}): Result => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  body: body === undefined ? '' : JSON.stringify(body),
})

function kbHost(): string {
  const host = process.env.KB_HOST
  if (!host) throw new Error('KB_HOST ontbreekt')
  return host
}

// Clients look for the metadata at the root and, per RFC 9728, with the resource path appended
const METADATA_PATHS = ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']

export async function handler(event: APIGatewayProxyEventV2, context: Context): Promise<Result> {
  const alias = aliasOf(context)
  const base = `https://${event.requestContext.domainName}`
  const method = event.requestContext.http.method
  const path = event.rawPath.replace(/\/$/, '') || '/'

  if (method === 'GET' && METADATA_PATHS.includes(path)) {
    return json(200, protectedResourceMetadata(`${base}/mcp`, issuerOf(alias)), { 'Access-Control-Allow-Origin': '*' })
  }
  if (path !== '/mcp') return json(404, { error: 'not_found' })
  if (method !== 'POST') return json(405, { error: 'Use POST' }, { Allow: 'POST' })

  const auth = await authenticateBearer(alias, event).catch((err) => {
    console.error('mcp: token check mislukt', err)
    return undefined
  })
  if (auth === undefined) return json(500, rpcError(null, -32603, 'Interne fout'))
  if (!auth) {
    return json(401, { error: 'invalid_token', error_description: 'Log opnieuw in via OAuth' }, {
      'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    })
  }

  let message: unknown
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '')
    message = JSON.parse(raw)
  } catch {
    return json(400, rpcError(null, -32700, 'Parse error'))
  }
  if (Array.isArray(message)) return json(400, rpcError(null, -32600, 'Batches worden niet ondersteund'))

  const ctx: McpContext = {
    env: alias,
    today: dayOf(),
    scopes: auth.scopes,
    writer: () => kbClient({ host: kbHost(), role: 'kb_writer' }),
    reader: () => kbClient({ host: kbHost(), role: 'kb_reader' }),
    dropReader: (client) => client.end().catch(() => {}),
  }
  const response = await handleMessage(message, ctx)
  return response ? json(200, response) : json(202, undefined)
}
