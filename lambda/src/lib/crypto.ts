import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const SCRYPT_KEYLEN = 64

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, SCRYPT_KEYLEN, { N: 16384, r: 8, p: 1 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  )
}

// Stored as `scrypt$<salt>$<hash>` (base64url)
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scryptAsync(password, salt)
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64url')
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'))
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

// Used when a username does not exist, so a failed login takes as long as a wrong password
export const DUMMY_HASH =
  'scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

// Invite and reset links carry a random token; only its SHA-256 is stored
export function newLinkToken(): string {
  return randomBytes(32).toString('base64url')
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export interface TokenPayload {
  sub: string
  // Bumped on password change/reset so older sessions stop working
  ver: number
  exp: number
}

const b64json = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const JWT_HEADER = b64json({ alg: 'HS256', typ: 'JWT' })

export function signToken(
  claims: Omit<TokenPayload, 'exp'>,
  secret: string,
  ttlSeconds: number,
  now = Date.now(),
): string {
  const payload = b64json({ ...claims, exp: Math.floor(now / 1000) + ttlSeconds })
  const signature = createHmac('sha256', secret).update(`${JWT_HEADER}.${payload}`).digest()
  return `${JWT_HEADER}.${payload}.${signature.toString('base64url')}`
}

export function verifyToken(token: string, secret: string, now = Date.now()): TokenPayload | null {
  const [header, payload, signature] = token.split('.')
  if (header !== JWT_HEADER || !payload || !signature) return null
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest()
  const actual = Buffer.from(signature, 'base64url')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as TokenPayload
    if (typeof claims.sub !== 'string' || typeof claims.ver !== 'number') return null
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null
    return claims
  } catch {
    return null
  }
}
