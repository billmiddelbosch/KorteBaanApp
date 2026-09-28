import type { APIGatewayProxyEvent, Context } from 'aws-lambda'
import { describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ result: null as null | { scopes: string[] } }))

vi.mock('./lib/oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/oauth')>()),
  authenticateBearer: async () => auth.result,
}))

const { handler } = await import('./kbMcp')

const context = { invokedFunctionArn: 'arn:aws:lambda:eu-west-2:123456789012:function:kortebaan-kbMcp:prod' } as Context

const call = (method: string, body?: unknown) =>
  handler(
    {
      httpMethod: method,
      resource: '/mcp',
      headers: { Host: 'api.example.com' },
      body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body),
      isBase64Encoded: false,
      requestContext: { stage: 'prod' },
    } as unknown as APIGatewayProxyEvent,
    context,
  )

describe('kbMcp handler', () => {
  it('points an unauthenticated client to the OAuth metadata', async () => {
    auth.result = null
    const res = await call('POST', { jsonrpc: '2.0', id: 1, method: 'ping' })
    expect(res.statusCode).toBe(401)
    expect(res.headers?.['WWW-Authenticate']).toBe(
      'Bearer resource_metadata="https://api.example.com/prod/.well-known/oauth-protected-resource"',
    )
  })

  it('answers requests, accepts notifications and refuses GET and batches', async () => {
    auth.result = { scopes: ['kb:read'] }
    const ping = await call('POST', { jsonrpc: '2.0', id: 7, method: 'ping' })
    expect(ping.statusCode).toBe(200)
    expect(JSON.parse(ping.body)).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
    expect((await call('POST', { jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode).toBe(202)
    expect((await call('GET')).statusCode).toBe(405)
    expect((await call('POST', [{ jsonrpc: '2.0', id: 1, method: 'ping' }])).statusCode).toBe(400)
    expect(JSON.parse((await call('POST', '{kapot')).body)).toMatchObject({ error: { code: -32700 } })
  })
})
