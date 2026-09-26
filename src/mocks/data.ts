// In-memory mock database used by MSW in dev mode and by the Playwright E2E suite.
// Keep the IDs and tokens stable — E2E tests rely on them.

export const TEST_TOKEN = 'mock-token-user'
export const ADMIN_TOKEN = 'mock-token-admin'

export interface MockUser {
  id: string
  email: string
  name: string
  role: 'user' | 'admin'
}

export const db: { users: MockUser[] } = {
  users: [
    { id: 'user-1', email: 'speler@example.nl', name: 'Test Speler', role: 'user' },
    { id: 'admin-1', email: 'beheer@example.nl', name: 'Test Beheerder', role: 'admin' },
  ],
}

const tokens: Record<string, string> = {
  [TEST_TOKEN]: 'user-1',
  [ADMIN_TOKEN]: 'admin-1',
}

export function userForToken(token: string): MockUser | undefined {
  const id = tokens[token]
  return db.users.find((u) => u.id === id)
}
