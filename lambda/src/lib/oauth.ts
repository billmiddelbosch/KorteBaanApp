// OAuth 2.1 for the kennisbank MCP server: authorization code + PKCE (S256), dynamic client
// registration (public clients only) and rotating refresh tokens. The app itself is the
// authorization server; the consent page is a route of the frontend, behind the app login.
import type { APIGatewayProxyEvent } from 'aws-lambda'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { sha256 } from './crypto'
import type { Alias } from './http'
import { putToken, getToken, type OAuthGrant } from './oauthStore'
import { getUser, type UserRecord } from './store'

export const CODE_TTL_SECONDS = 5 * 60
export const ACCESS_TTL_SECONDS = 60 * 60
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60
// A registered client is forgotten when unused for this long (refreshed on every authorization)
export const CLIENT_TTL_SECONDS = 180 * 24 * 60 * 60

// Scope → what the consent page tells the user
export const SCOPES = {
  'kb:read': 'De kennisbank lezen: paarden, pikeurs, koppels, edities, feiten en lessen.',
  'kb:write': 'Feiten en lessen aan de kennisbank toevoegen.',
  'kb:sql': 'Eigen leesvragen (SQL) op de kennisbank uitvoeren.',
} as const
export type Scope = keyof typeof SCOPES

export function allowedScopes(user: Pick<UserRecord, 'role'>): Scope[] {
  return user.role === 'owner' ? ['kb:read', 'kb:write', 'kb:sql'] : ['kb:read']
}

// Requested ∩ allowed; no scope requested = everything the user may have. Unknown scopes are ignored.
export function grantScopes(requested: string | undefined, user: Pick<UserRecord, 'role'>): Scope[] {
  const allowed = allowedScopes(user)
  const asked = (requested ?? '').split(' ').filter(Boolean)
  return asked.length ? allowed.filter((s) => asked.includes(s)) : allowed
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

// https, or http on a loopback address (native clients such as Claude Code); never a fragment
export function isValidRedirectUri(value: string): boolean {
  const url = parseUrl(value)
  if (!url || url.hash) return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname)
}

// Exact match; loopback redirects may use any port (RFC 8252 §7.3)
export function redirectMatches(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true
  const g = parseUrl(given)
  if (!g || g.protocol !== 'http:' || !LOOPBACK.has(g.hostname)) return false
  return registered.some((r) => {
    const u = parseUrl(r)
    return !!u && u.protocol === 'http:' && u.hostname === g.hostname && u.pathname === g.pathname && u.search === g.search
  })
}

const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/

export const isValidChallenge = (challenge: string) => CHALLENGE.test(challenge)

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!VERIFIER.test(verifier)) return false
  return createHash('sha256').update(verifier).digest('base64url') === challenge
}

export const newSecret = () => randomBytes(32).toString('base64url')
export const newClientId = () => randomUUID()

// The API's own public URL, e.g. https://abc.execute-api.eu-west-2.amazonaws.com/prod
export function baseUrlOf(event: APIGatewayProxyEvent): string {
  const host = event.headers?.['Host'] ?? event.headers?.['host'] ?? ''
  return `https://${host}/${event.requestContext.stage}`
}

// The consent page lives in the app of the same environment
export const frontendOf = (alias: Alias) => (alias === 'prod' ? 'https://kortebaan.nl' : 'https://test.kortebaan.nl')

export const resourceOf = (base: string) => `${base}/mcp`

export function protectedResourceMetadata(base: string) {
  return {
    resource: resourceOf(base),
    authorization_servers: [base],
    scopes_supported: Object.keys(SCOPES),
    bearer_methods_supported: ['header'],
    resource_name: 'KorteBaan kennisbank',
  }
}

export function authorizationServerMetadata(base: string, alias: Alias) {
  return {
    issuer: base,
    authorization_endpoint: `${frontendOf(alias)}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    scopes_supported: Object.keys(SCOPES),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
  }
}

export interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

export async function issueTokens(alias: Alias, grant: OAuthGrant, now = Date.now()): Promise<TokenResponse> {
  const access = newSecret()
  const refresh = newSecret()
  const at = Math.floor(now / 1000)
  await putToken(alias, sha256(access), 'ACCESS', { ...grant, expiresAt: at + ACCESS_TTL_SECONDS })
  await putToken(alias, sha256(refresh), 'REFRESH', { ...grant, expiresAt: at + REFRESH_TTL_SECONDS })
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refresh,
    scope: grant.scopes.join(' '),
  }
}

// The user behind a grant, if the grant is still good: active, same password, and the scopes
// cut back to what the user may have now (a demoted owner loses write access at once)
export async function grantUser(alias: Alias, grant: OAuthGrant): Promise<{ user: UserRecord; scopes: Scope[] } | null> {
  const user = await getUser(alias, grant.userId)
  if (!user || user.status !== 'active' || user.tokenVersion !== grant.tokenVersion) return null
  const allowed = allowedScopes(user)
  const scopes = grant.scopes.filter((s): s is Scope => (allowed as string[]).includes(s))
  return scopes.length ? { user, scopes } : null
}

export async function authenticateBearer(alias: Alias, event: APIGatewayProxyEvent) {
  const header = event.headers?.['Authorization'] ?? event.headers?.['authorization'] ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) return null
  const grant = await getToken(alias, sha256(token), 'ACCESS')
  return grant ? grantUser(alias, grant) : null
}
