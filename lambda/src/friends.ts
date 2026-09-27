import { randomUUID } from 'node:crypto'
import { createHandler, HttpError, ok, type RouteRequest } from './lib/api'
import { isLinkExpired, issueLink } from './lib/links'
import { requireOwner } from './lib/session'
import {
  dayOf,
  deleteUser,
  getUser,
  listUsers,
  putUser,
  usageOn,
  type UserRecord,
} from './lib/store'
import { assertDailyLimit, assertName } from './lib/validation'

// New friends start with a modest daily cap, since every analysis runs on the owner's subscription
const DEFAULT_DAILY_LIMIT = 10

export type FriendStatus = 'active' | 'paused' | 'invited' | 'expired'

function toFriend(user: UserRecord, usedToday: number) {
  const status: FriendStatus =
    user.status === 'invited' ? (isLinkExpired(user) ? 'expired' : 'invited') : user.status
  return {
    id: user.id,
    name: user.name,
    username: user.username ?? null,
    status,
    lastActiveAt: user.lastActiveAt ?? null,
    usedToday,
    dailyLimit: user.dailyLimit,
    linkExpiresAt:
      user.linkType === 'invite' && user.linkExpiresAt
        ? new Date(user.linkExpiresAt).toISOString()
        : null,
  }
}

async function friendOr404(req: RouteRequest): Promise<UserRecord> {
  const friend = await getUser(req.alias, req.params.id ?? '')
  if (!friend || friend.role !== 'friend') throw new HttpError(404, 'Deze vriend bestaat niet (meer).')
  return friend
}

// GET /friends
async function list(req: RouteRequest) {
  await requireOwner(req)
  const [users, usage] = await Promise.all([listUsers(req.alias), usageOn(req.alias, dayOf())])
  const friends = users
    .filter((u) => u.role === 'friend')
    .sort((a, b) => a.name.localeCompare(b.name, 'nl'))
    .map((u) => toFriend(u, usage.get(u.id) ?? 0))
  return ok({ friends })
}

// POST /friends — creates an invited friend and returns their invite link
async function invite(req: RouteRequest) {
  await requireOwner(req)
  const friend: UserRecord = {
    id: randomUUID(),
    name: assertName(req.body.name),
    role: 'friend',
    status: 'invited',
    dailyLimit:
      req.body.dailyLimit === undefined ? DEFAULT_DAILY_LIMIT : assertDailyLimit(req.body.dailyLimit),
    tokenVersion: 0,
    failedLogins: 0,
    createdAt: new Date().toISOString(),
  }
  const { user, link } = await issueLink(req.alias, friend, 'invite')
  return ok({ friend: toFriend(user, 0), link }, 201)
}

// PATCH /friends/{id} — pause/resume, daily limit, name
async function update(req: RouteRequest) {
  await requireOwner(req)
  const friend = await friendOr404(req)
  const updated: UserRecord = { ...friend }

  if (req.body.status !== undefined) {
    if (req.body.status !== 'active' && req.body.status !== 'paused') {
      throw new HttpError(400, 'Kies actief of gepauzeerd.')
    }
    if (friend.status === 'invited') {
      throw new HttpError(409, 'Deze vriend heeft de uitnodiging nog niet geaccepteerd.')
    }
    updated.status = req.body.status
  }
  if (req.body.dailyLimit !== undefined) updated.dailyLimit = assertDailyLimit(req.body.dailyLimit)
  if (req.body.name !== undefined) updated.name = assertName(req.body.name)

  await putUser(req.alias, updated)
  const usage = await usageOn(req.alias, dayOf())
  return ok({ friend: toFriend(updated, usage.get(updated.id) ?? 0) })
}

// DELETE /friends/{id}
async function remove(req: RouteRequest) {
  await requireOwner(req)
  await deleteUser(req.alias, await friendOr404(req))
  return ok({ ok: true })
}

// POST /friends/{id}/link — new invite (not yet joined) or password reset link (joined)
async function newLink(req: RouteRequest) {
  await requireOwner(req)
  const friend = await friendOr404(req)
  const { user, link } = await issueLink(
    req.alias,
    friend,
    friend.status === 'invited' ? 'invite' : 'reset',
  )
  const usage = await usageOn(req.alias, dayOf())
  return ok({ friend: toFriend(user, usage.get(user.id) ?? 0), link })
}

export const handler = createHandler({
  'GET /friends': list,
  'POST /friends': invite,
  'PATCH /friends/{id}': update,
  'DELETE /friends/{id}': remove,
  'POST /friends/{id}/link': newLink,
})
