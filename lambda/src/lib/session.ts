import { HttpError, type RouteRequest } from './api'
import { signToken, verifyToken } from './crypto'
import type { Alias } from './http'
import { jwtSecret } from './secrets'
import { getAiConfig, getUser, putUser, dayOf, usageOn, type UserRecord } from './store'

// Long-lived sessions: the app is used outside at the track, re-logging in is a hassle there
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

// Only refresh lastActiveAt every few minutes to avoid a write on every request
const ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1000

export async function issueToken(alias: Alias, user: UserRecord): Promise<string> {
  return signToken({ sub: user.id, ver: user.tokenVersion }, await jwtSecret(alias), SESSION_TTL_SECONDS)
}

export async function authenticate(req: RouteRequest): Promise<UserRecord> {
  const header = req.event.headers?.['Authorization'] ?? req.event.headers?.['authorization'] ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const claims = token ? verifyToken(token, await jwtSecret(req.alias)) : null
  if (!claims) throw new HttpError(401, 'Niet ingelogd')

  const user = await getUser(req.alias, claims.sub)
  if (!user || user.tokenVersion !== claims.ver) throw new HttpError(401, 'Niet ingelogd')
  if (user.status === 'paused') {
    throw new HttpError(403, 'Je toegang is gepauzeerd. Vraag de eigenaar om je weer toegang te geven.')
  }
  if (user.status !== 'active') throw new HttpError(401, 'Niet ingelogd')

  const now = Date.now()
  if (!user.lastActiveAt || now - Date.parse(user.lastActiveAt) > ACTIVITY_WRITE_INTERVAL_MS) {
    user.lastActiveAt = new Date(now).toISOString()
    await putUser(req.alias, user)
  }
  return user
}

export async function requireOwner(req: RouteRequest): Promise<UserRecord> {
  const user = await authenticate(req)
  if (user.role !== 'owner') {
    throw new HttpError(403, 'Alleen de eigenaar kan dit beheren.')
  }
  return user
}

export interface Me {
  id: string
  name: string
  username: string
  role: UserRecord['role']
  ai: {
    // `none` = no setup-token stored yet
    status: 'connected' | 'error' | 'none'
    usedToday: number
    dailyLimit: number | null
  }
}

export async function toMe(alias: Alias, user: UserRecord): Promise<Me> {
  const [config, usage] = await Promise.all([getAiConfig(alias), usageOn(alias, dayOf())])
  return {
    id: user.id,
    name: user.name,
    username: user.username ?? '',
    role: user.role,
    ai: {
      status: config?.status ?? 'none',
      usedToday: usage.get(user.id) ?? 0,
      dailyLimit: user.role === 'owner' ? null : user.dailyLimit,
    },
  }
}
