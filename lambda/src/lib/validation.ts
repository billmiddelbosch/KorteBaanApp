import { HttpError } from './api'

export const PASSWORD_MIN_LENGTH = 10

export function assertPassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    throw new HttpError(400, `Kies een wachtwoord van minimaal ${PASSWORD_MIN_LENGTH} tekens.`)
  }
  if (password.length > 200) throw new HttpError(400, 'Dit wachtwoord is te lang.')
  return password
}

// Usernames are stored lowercase: 3–30 letters, digits, dot, dash or underscore
export function normalizeUsername(username: unknown): string {
  const value = typeof username === 'string' ? username.trim().toLowerCase() : ''
  if (!/^[a-z0-9._-]{3,30}$/.test(value)) {
    throw new HttpError(
      400,
      'Gebruik 3 tot 30 tekens: letters, cijfers, punt, streepje of underscore.',
    )
  }
  return value
}

export function assertName(name: unknown): string {
  const value = typeof name === 'string' ? name.trim() : ''
  if (!value) throw new HttpError(400, 'Vul een naam in.')
  if (value.length > 40) throw new HttpError(400, 'Houd de naam korter dan 40 tekens.')
  return value
}

// null = no limit; otherwise a whole number of analyses per day
export function assertDailyLimit(limit: unknown): number | null {
  if (limit === null) return null
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > 1000) {
    throw new HttpError(400, 'Kies een daglimiet tussen 0 en 1000, of geen limiet.')
  }
  return limit
}
