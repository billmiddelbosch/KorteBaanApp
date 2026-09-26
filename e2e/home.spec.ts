import { test, expect } from './fixtures'

test.describe('Home', () => {
  test('renders the home page', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('h1')).toBeVisible()
  })

  test('navigates to About via the nav', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'About' }).click()
    await expect(page).toHaveURL(/\/about$/)
  })
})
