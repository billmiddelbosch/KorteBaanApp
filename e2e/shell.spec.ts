import { test, expect } from './fixtures'

test.describe('App shell', () => {
  test.beforeEach(async ({ loginAs }) => {
    await loginAs('admin')
  })

  test.describe('desktop', () => {
    test.use({ viewport: { width: 1280, height: 800 } })

    test('opens on Koersdag with the sidebar navigation', async ({ page }) => {
      await page.goto('/')
      const nav = page.getByRole('navigation', { name: 'Hoofdnavigatie' })
      await expect(nav.getByRole('link', { name: 'Koersdag' })).toHaveAttribute(
        'aria-current',
        'page',
      )
      await expect(page.getByRole('heading', { name: 'Koersdag', exact: true })).toBeVisible()
      await expect(page).toHaveTitle('Koersdag · Sprintorakel')
    })

    test('navigates between sections', async ({ page }) => {
      await page.goto('/')
      const nav = page.getByRole('navigation', { name: 'Hoofdnavigatie' })
      await nav.getByRole('link', { name: 'Analyse' }).click()
      await expect(page).toHaveURL(/\/analyse$/)
      await expect(nav.getByRole('link', { name: 'Analyse' })).toHaveAttribute(
        'aria-current',
        'page',
      )
      await nav.getByRole('link', { name: 'Terugblik' }).click()
      await expect(page.getByRole('heading', { name: 'Terugblik' })).toBeVisible()
    })

    test('user menu links to account pages and switches theme', async ({ page }) => {
      await page.goto('/')
      await page.getByRole('button', { name: /Gebruikersmenu/ }).click()
      await expect(page.getByRole('link', { name: 'Vrienden beheren' })).toBeVisible()
      await expect(page.getByText('Gekoppeld')).toBeVisible()

      // The radios are visually hidden; users tap the segment label
      await page.getByText('Donker', { exact: true }).click()
      await expect(page.getByRole('radio', { name: 'Donker' })).toBeChecked()
      await expect(page.locator('html')).toHaveClass(/dark/)
      await page.getByText('Licht', { exact: true }).click()
      await expect(page.locator('html')).not.toHaveClass(/dark/)

      await page.getByRole('link', { name: /AI-koppeling/ }).click()
      await expect(page).toHaveURL(/\/account\/ai-koppeling$/)
      await expect(page.getByRole('heading', { name: 'AI-koppeling' })).toBeVisible()
    })

    test('closes the user menu with Escape', async ({ page }) => {
      await page.goto('/')
      await page.getByRole('button', { name: /Gebruikersmenu/ }).click()
      await expect(page.getByRole('button', { name: 'Uitloggen' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: 'Uitloggen' })).toBeHidden()
    })
  })

  test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 844 } })

    test('shows the bottom tab bar and the live bar', async ({ page }) => {
      // The live bar only shows during a koersdag: start one first
      await page.goto('/')
      await page.getByLabel('Budget voor vandaag').fill('40')
      await page.getByRole('button', { name: 'Koersdag starten' }).click()
      await expect(page.getByRole('heading', { name: '1e omloop' })).toBeVisible()

      const nav = page.getByRole('navigation', { name: 'Hoofdnavigatie' })
      await expect(nav.getByRole('link')).toHaveCount(3)
      await nav.getByRole('link', { name: 'Analyse' }).click()
      await expect(page).toHaveURL(/\/analyse$/)
      await expect(page.getByRole('link', { name: /^Live:/ })).toBeVisible()

      await page.getByRole('link', { name: /^Live:/ }).click()
      await expect(page).toHaveURL(/\/$/)
      await expect(nav.getByRole('link', { name: 'Koersdag' })).toHaveAttribute(
        'aria-current',
        'page',
      )
    })
  })
})
