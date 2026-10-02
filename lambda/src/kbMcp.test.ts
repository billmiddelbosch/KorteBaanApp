import type { APIGatewayProxyEventV2, Context } from 'aws-lambda'
import { describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ result: null as null | { scopes: string[] } }))

vi.mock('./lib/oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/oauth')>()),
  authenticateBearer: async () => auth.result,
}))

process.env.OAUTH_ISSUER_PROD = 'https://api.example.com/prod'
const { handler } = await import('./kbMcp')

const context = { invokedFunctionArn: 'arn:aws:lambda:eu-west-2:123456789012:function:kortebaan-kbMcp:prod' } as Context
const HOST = 'abc.lambda-url.eu-west-2.on.aws'

const call = async (method: string, path: string, body?: unknown) => {
  const res = await handler(
    {
      rawPath: path,
      headers: {},
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      isBase64Encoded: false,
      requestContext: { domainName: HOST, http: { method } },
    } as unknown as APIGatewayProxyEventV2,
    context,
  )
  return { ...res, statusCode: res.statusCode!, body: res.body ?? '' }
}

describe('kbMcp handler', () => {
  it('points an unauthenticated client to the OAuth metadata', async () => {
    auth.result = null
    const res = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' })
    expect(res.statusCode).toBe(401)
    expect(res.headers?.['WWW-Authenticate']).toBe(
      `Bearer resource_metadata="https://${HOST}/.well-known/oauth-protected-resource"`,
    )
  })

  it('serves the protected resource metadata at the root and with the resource path', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await call('GET', path)
      expect(JSON.parse(res.body)).toMatchObject({
        resource: `https://${HOST}/mcp`,
        authorization_servers: ['https://api.example.com/prod'],
      })
    }
    expect((await call('GET', '/other')).statusCode).toBe(404)
  })

  it('answers requests, accepts notifications and refuses GET and batches', async () => {
    auth.result = { scopes: ['kb:read'] }
    const ping = await call('POST', '/mcp', { jsonrpc: '2.0', id: 7, method: 'ping' })
    expect(ping.statusCode).toBe(200)
    expect(JSON.parse(ping.body)).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
    expect((await call('POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode).toBe(202)
    expect((await call('GET', '/mcp')).statusCode).toBe(405)
    expect((await call('POST', '/mcp', [{ jsonrpc: '2.0', id: 1, method: 'ping' }])).statusCode).toBe(400)
    expect(JSON.parse((await call('POST', '/mcp', '{kapot')).body)).toMatchObject({ error: { code: -32700 } })
  })
})
