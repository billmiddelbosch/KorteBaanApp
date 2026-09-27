import type { Alias } from './http'
import { newLinkToken, sha256 } from './crypto'
import { setLink, type LinkType, type UserRecord } from './store'

const LINK_TTL_MS: Record<LinkType, number> = {
  invite: 7 * 24 * 60 * 60 * 1000,
  reset: 24 * 60 * 60 * 1000,
}

export interface IssuedLink {
  // Raw token — only returned once, to the owner who shares it
  token: string
  type: LinkType
  expiresAt: string
}

// Issues a fresh invite/reset link for the user; any earlier link stops working
export async function issueLink(
  alias: Alias,
  user: UserRecord,
  type: LinkType,
): Promise<{ user: UserRecord; link: IssuedLink }> {
  const token = newLinkToken()
  const expiresAt = Date.now() + LINK_TTL_MS[type]
  const updated = await setLink(alias, user, { hash: sha256(token), type, expiresAt })
  return { user: updated, link: { token, type, expiresAt: new Date(expiresAt).toISOString() } }
}

export const isLinkExpired = (user: UserRecord, now = Date.now()) =>
  !user.linkExpiresAt || user.linkExpiresAt <= now
