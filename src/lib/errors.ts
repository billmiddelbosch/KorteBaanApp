import { isAxiosError } from 'axios'

// An error whose Dutch message is safe to show as is
export class UserFacingError extends Error {}

// The API always answers errors with `{ message }` in Dutch; fall back to a generic hint
export function errorMessage(error: unknown): string {
  if (isAxiosError(error)) {
    const message = (error.response?.data as { message?: unknown } | undefined)?.message
    if (typeof message === 'string' && message) return message
    if (!error.response) return 'Geen verbinding. Controleer je internet en probeer het opnieuw.'
  } else if (error instanceof UserFacingError) {
    return error.message
  }
  return 'Er ging iets mis. Probeer het zo nog eens.'
}

export function errorStatus(error: unknown): number | undefined {
  return isAxiosError(error) ? error.response?.status : undefined
}
