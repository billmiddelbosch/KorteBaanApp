import { describe, expect, it } from 'vitest'
import { hashPassword, newLinkToken, sha256, signToken, verifyPassword, verifyToken } from './crypto'

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('paardje-op-de-baan')
    expect(hash.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('paardje-op-de-baan', hash)).toBe(true)
    expect(await verifyPassword('paardje-op-de-baaN', hash)).toBe(false)
  })

  it('salts every hash', async () => {
    expect(await hashPassword('zelfde-wachtwoord')).not.toBe(await hashPassword('zelfde-wachtwoord'))
  })

  it('rejects a malformed stored hash', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false)
  })
})

describe('session tokens', () => {
  const secret = 'test-secret'
  const now = Date.UTC(2026, 8, 26)

  it('round-trips claims', () => {
    const token = signToken({ sub: 'user-1', ver: 2 }, secret, 60, now)
    expect(verifyToken(token, secret, now)).toMatchObject({ sub: 'user-1', ver: 2 })
  })

  it('rejects a token signed with another secret', () => {
    const token = signToken({ sub: 'user-1', ver: 0 }, 'other', 60, now)
    expect(verifyToken(token, secret, now)).toBeNull()
  })

  it('rejects a tampered payload', () => {
    const [h, , s] = signToken({ sub: 'user-1', ver: 0 }, secret, 60, now).split('.')
    const forged = Buffer.from(JSON.stringify({ sub: 'admin', ver: 0, exp: 9e9 })).toString('base64url')
    expect(verifyToken(`${h}.${forged}.${s}`, secret, now)).toBeNull()
  })

  it('rejects an expired token', () => {
    const token = signToken({ sub: 'user-1', ver: 0 }, secret, 60, now)
    expect(verifyToken(token, secret, now + 61_000)).toBeNull()
  })
})

describe('link tokens', () => {
  it('are random and hash deterministically', () => {
    const a = newLinkToken()
    expect(a).not.toBe(newLinkToken())
    expect(a.length).toBeGreaterThanOrEqual(40)
    expect(sha256(a)).toBe(sha256(a))
  })
})
