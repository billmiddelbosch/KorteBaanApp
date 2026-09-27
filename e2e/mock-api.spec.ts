import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { AUTH_TOKEN_KEY } from '../src/lib/constants'

// Guards the MSW setup itself: if the mock backend stops starting in dev mode,
// every other API-driven E2E test would fail in confusing ways.
test.describe('Mock API (MSW)', () => {
  // The app mounts only after worker.start() resolves, so a mounted app means MSW is active
  const openApp = async (page: Page) => {
    await page.goto('/')
    await expect(page.locator('#app main')).toBeVisible()
  }

  const getMe = (key: string) =>
    fetch('/api/me', {
      headers: { Authorization: `Bearer ${localStorage.getItem(key) ?? ''}` },
    }).then(async (r) => ({ status: r.status, body: await r.json() }))

  test('rejects /api/me without a session', async ({ page }) => {
    await openApp(page)
    const res = await page.evaluate(getMe, AUTH_TOKEN_KEY)
    expect(res.status).toBe(401)
    expect(res.body.message).toBe('Niet ingelogd')
  })

  test('returns the user for a logged-in session', async ({ page, loginAs }) => {
    await loginAs('user')
    await openApp(page)
    const res = await page.evaluate(getMe, AUTH_TOKEN_KEY)
    expect(res.status).toBe(200)
    expect(res.body.role).toBe('friend')
  })

  test('returns the owner for an admin session', async ({ page, loginAs }) => {
    await loginAs('admin')
    await openApp(page)
    const res = await page.evaluate(getMe, AUTH_TOKEN_KEY)
    expect(res.body.role).toBe('owner')
  })
})
