import { createHandler, HttpError, ok, readString, type RouteRequest } from './lib/api'
import { hashPassword, verifyPassword } from './lib/crypto'
import { authenticate, issueToken, toMe } from './lib/session'
import { listSessions, putUser } from './lib/store'
import { assertName, assertPassword } from './lib/validation'

// GET /me — the logged-in user plus their AI status for today
async function getMe(req: RouteRequest) {
  const user = await authenticate(req)
  return ok(await toMe(req.alias, user))
}

// PATCH /me — change display name
async function updateMe(req: RouteRequest) {
  const user = await authenticate(req)
  const updated = { ...user, name: assertName(req.body.name) }
  await putUser(req.alias, updated)
  return ok(await toMe(req.alias, updated))
}

// PUT /me/password — change password; other devices are signed out, this one gets a new token
async function changePassword(req: RouteRequest) {
  const user = await authenticate(req)
  const current = readString(req.body, 'currentPassword', 'Vul je huidige wachtwoord in.')
  if (!user.passwordHash || !(await verifyPassword(current, user.passwordHash))) {
    throw new HttpError(400, 'Je huidige wachtwoord klopt niet.')
  }
  const updated = {
    ...user,
    passwordHash: await hashPassword(assertPassword(req.body.newPassword)),
    tokenVersion: user.tokenVersion + 1,
  }
  await putUser(req.alias, updated)
  return ok({ token: await issueToken(req.alias, updated) })
}

// GET /me/sessions — speelsessies (newest first) with totals
async function getSessions(req: RouteRequest) {
  const user = await authenticate(req)
  const sessions = (await listSessions(req.alias, user.id)).map((s) => ({
    ...s,
    balance: s.paidOut - s.staked,
  }))
  const staked = sessions.reduce((sum, s) => sum + s.staked, 0)
  const paidOut = sessions.reduce((sum, s) => sum + s.paidOut, 0)
  return ok({ sessions, totals: { staked, paidOut, balance: paidOut - staked } })
}

export const handler = createHandler({
  'GET /me': getMe,
  'PATCH /me': updateMe,
  'PUT /me/password': changePassword,
  'GET /me/sessions': getSessions,
})
