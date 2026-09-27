import { createHandler, HttpError, ok, readString, type RouteRequest } from './lib/api'
import { DUMMY_HASH, hashPassword, sha256, verifyPassword } from './lib/crypto'
import { isLinkExpired } from './lib/links'
import { issueToken, toMe } from './lib/session'
import {
  claimUsername,
  clearLink,
  findLinkUser,
  getUserByUsername,
  putUser,
  UsernameTakenError,
  type UserRecord,
} from './lib/store'
import { assertName, assertPassword, normalizeUsername } from './lib/validation'

const MAX_FAILED_LOGINS = 5
const LOCK_MS = 15 * 60 * 1000

const INVALID_LOGIN = 'Gebruikersnaam of wachtwoord klopt niet.'
const LINK_GONE =
  'Deze link werkt niet meer. Vraag de eigenaar om een nieuwe link.'

async function session(req: RouteRequest, user: UserRecord) {
  return ok({ token: await issueToken(req.alias, user), user: await toMe(req.alias, user) })
}

// POST /auth/login — username + password → session token
async function login(req: RouteRequest) {
  const username = readString(req.body, 'username', 'Vul je gebruikersnaam in.').toLowerCase()
  const password = readString(req.body, 'password', 'Vul je wachtwoord in.')

  const user = await getUserByUsername(req.alias, username)
  if (!user?.passwordHash) {
    await verifyPassword(password, DUMMY_HASH) // same timing as a wrong password
    throw new HttpError(401, INVALID_LOGIN)
  }

  const now = Date.now()
  if (user.lockedUntil && user.lockedUntil > now) {
    throw new HttpError(429, 'Te veel mislukte pogingen. Probeer het over 15 minuten opnieuw.')
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    const failedLogins = user.failedLogins + 1
    const locked = failedLogins >= MAX_FAILED_LOGINS
    await putUser(req.alias, {
      ...user,
      failedLogins: locked ? 0 : failedLogins,
      lockedUntil: locked ? now + LOCK_MS : undefined,
    })
    if (locked) {
      throw new HttpError(429, 'Te veel mislukte pogingen. Probeer het over 15 minuten opnieuw.')
    }
    throw new HttpError(401, INVALID_LOGIN)
  }

  if (user.status === 'paused') {
    throw new HttpError(403, 'Je toegang is gepauzeerd. Vraag de eigenaar om je weer toegang te geven.')
  }

  const updated: UserRecord = {
    ...user,
    failedLogins: 0,
    lockedUntil: undefined,
    lastActiveAt: new Date(now).toISOString(),
  }
  await putUser(req.alias, updated)
  return session(req, updated)
}

async function userForLink(req: RouteRequest): Promise<UserRecord> {
  const token = req.params.token ?? ''
  const user = token ? await findLinkUser(req.alias, sha256(token)) : undefined
  if (!user || isLinkExpired(user)) throw new HttpError(410, LINK_GONE)
  return user
}

// GET /auth/links/{token} — what the invite/reset page should show
async function inspectLink(req: RouteRequest) {
  const user = await userForLink(req)
  return ok({ type: user.linkType, name: user.name, username: user.username ?? null })
}

// POST /auth/links/{token}/accept — invite: choose username + password; reset: new password
async function acceptLink(req: RouteRequest) {
  const user = await userForLink(req)
  const passwordHash = await hashPassword(assertPassword(req.body.password))

  if (user.linkType === 'invite') {
    const username = normalizeUsername(req.body.username)
    const name = req.body.name === undefined ? user.name : assertName(req.body.name)
    const { linkHash: _h, linkType: _t, linkExpiresAt: _e, ...withoutLink } = user
    const activated: UserRecord = {
      ...withoutLink,
      name,
      username,
      passwordHash,
      status: 'active',
      failedLogins: 0,
      lastActiveAt: new Date().toISOString(),
    }
    try {
      await claimUsername(req.alias, activated)
    } catch (err) {
      if (err instanceof UsernameTakenError) {
        throw new HttpError(409, 'Deze gebruikersnaam is al bezet. Kies een andere.')
      }
      throw err
    }
    // Only now retire the link, so a taken username can be retried with the same link
    await clearLink(req.alias, user)
    return session(req, activated)
  }

  // Reset: new password, and every existing session is signed out
  const reset: UserRecord = {
    ...(await clearLink(req.alias, user)),
    passwordHash,
    tokenVersion: user.tokenVersion + 1,
    failedLogins: 0,
    lockedUntil: undefined,
  }
  await putUser(req.alias, reset)
  return session(req, reset)
}

export const handler = createHandler({
  'POST /auth/login': login,
  'GET /auth/links/{token}': inspectLink,
  'POST /auth/links/{token}/accept': acceptLink,
})
