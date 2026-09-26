import { test as base, expect } from '@playwright/test'
import { ADMIN_TOKEN, TEST_TOKEN } from '../src/mocks/data'
import { AUTH_TOKEN_KEY } from '../src/lib/constants'

type Role = 'user' | 'admin'

// Extends Playwright's `test` with a `loginAs` helper that seeds the MSW mock token
// into localStorage before any page script runs, so route guards and the API see a session.
export const test = base.extend<{ loginAs: (role: Role) => Promise<void> }>({
  loginAs: async ({ page }, use) => {
    await use(async (role) => {
      const token = role === 'admin' ? ADMIN_TOKEN : TEST_TOKEN
      await page.addInitScript(
        ([key, value]) => window.localStorage.setItem(key, value),
        [AUTH_TOKEN_KEY, token] as const,
      )
    })
  },
})

export { expect }
