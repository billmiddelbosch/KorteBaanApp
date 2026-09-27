import { createHandler, HttpError, ok, readString, type RouteRequest } from './lib/api'
import { looksLikeSetupToken, testClaudeToken, tokenHint } from './lib/claude'
import type { Alias } from './lib/http'
import { readClaudeToken, writeClaudeToken } from './lib/secrets'
import { requireOwner } from './lib/session'
import {
  dayOf,
  deleteAiConfig,
  getAiConfig,
  listUsers,
  putAiConfig,
  usageOn,
  type AiConfig,
} from './lib/store'

const USAGE_DAYS = 7

// Connection status plus AI usage today (per user) and over the last week (per day)
async function overview(alias: Alias) {
  const days = Array.from({ length: USAGE_DAYS }, (_, i) =>
    dayOf(new Date(Date.now() - (USAGE_DAYS - 1 - i) * 24 * 60 * 60 * 1000)),
  )
  const [config, users, ...usage] = await Promise.all([
    getAiConfig(alias),
    listUsers(alias),
    ...days.map((day) => usageOn(alias, day)),
  ])
  const today = usage[usage.length - 1]!

  return {
    status: config?.status ?? 'none',
    tokenHint: config?.tokenHint ?? null,
    connectedAt: config?.connectedAt ?? null,
    lastTestedAt: config?.lastTestedAt ?? null,
    lastError: config?.lastError ?? null,
    usage: {
      today: users
        .filter((u) => u.status !== 'invited')
        .map((u) => ({
          userId: u.id,
          name: u.name,
          count: today.get(u.id) ?? 0,
          dailyLimit: u.role === 'owner' ? null : u.dailyLimit,
        }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'nl')),
      days: days.map((date, i) => ({
        date,
        count: [...usage[i]!.values()].reduce((sum, n) => sum + n, 0),
      })),
    },
  }
}

async function runTest(alias: Alias, token: string, base: AiConfig): Promise<void> {
  const result = await testClaudeToken(token)
  await putAiConfig(alias, {
    ...base,
    status: result.ok ? 'connected' : 'error',
    lastTestedAt: new Date().toISOString(),
    lastError: result.ok ? undefined : result.message,
  })
}

// GET /ai-connection
async function get(req: RouteRequest) {
  await requireOwner(req)
  return ok(await overview(req.alias))
}

// PUT /ai-connection — store or replace the setup-token, then test it right away
async function put(req: RouteRequest) {
  await requireOwner(req)
  const token = readString(req.body, 'token', 'Plak je setup-token.')
  if (!looksLikeSetupToken(token)) {
    throw new HttpError(
      400,
      'Dit lijkt geen setup-token. Het begint met "sk-ant-" — kopieer de volledige uitvoer van `claude setup-token`.',
    )
  }
  await writeClaudeToken(req.alias, token)
  await runTest(req.alias, token, {
    status: 'error',
    tokenHint: tokenHint(token),
    connectedAt: new Date().toISOString(),
  })
  return ok(await overview(req.alias))
}

// POST /ai-connection/test
async function test(req: RouteRequest) {
  await requireOwner(req)
  const [token, config] = await Promise.all([readClaudeToken(req.alias), getAiConfig(req.alias)])
  if (!token || !config) throw new HttpError(409, 'Er is nog geen setup-token gekoppeld.')
  await runTest(req.alias, token, config)
  return ok(await overview(req.alias))
}

// DELETE /ai-connection — AI features stop for everyone until a new token is added
async function remove(req: RouteRequest) {
  await requireOwner(req)
  await writeClaudeToken(req.alias, null)
  await deleteAiConfig(req.alias)
  return ok(await overview(req.alias))
}

export const handler = createHandler({
  'GET /ai-connection': get,
  'PUT /ai-connection': put,
  'POST /ai-connection/test': test,
  'DELETE /ai-connection': remove,
})
