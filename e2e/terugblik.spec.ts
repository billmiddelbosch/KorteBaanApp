import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

// The mock AI answers after ~1.2 s. It finds uitslagen for every omloop (at least 3, the 1e is won
// by Fleur de Lis), except for a place containing "fout". Every evaluation adds one lesson.
const AI_TIMEOUT = { timeout: 10_000 }

// Starts today's koersdag and finishes it before the finale. MSW keeps its data in memory, so
// the rest of the test must navigate inside the app instead of reloading the page.
async function finishKoersdag(page: Page, place?: string) {
  await page.goto('/')
  if (place) {
    await page.getByRole('radio', { name: 'Andere draverij' }).check()
    await page.getByLabel('Plaats van de draverij').fill(place)
    await page.getByLabel('Budget voor vandaag').fill('25')
  }
  await page.getByRole('button', { name: 'Koersdag starten' }).click()
  await expect(page.getByTestId('ai-thinking')).toBeHidden(AI_TIMEOUT)
}

async function finishNow(page: Page) {
  await page.getByRole('button', { name: 'Koersdag nu afronden' }).click()
  await page
    .getByRole('dialog', { name: 'Koersdag nu afronden?' })
    .getByRole('button', { name: 'Koersdag afronden' })
    .click()
  await expect(page.getByRole('heading', { name: 'Koersdag afgerond' })).toBeVisible()
  await page.getByRole('link', { name: 'Naar Terugblik' }).click()
  await expect(page.getByRole('heading', { name: 'Terugblik', exact: true })).toBeVisible()
}

test.describe('Terugblik', () => {
  test('sends guests to the login page', async ({ page }) => {
    await page.goto('/terugblik')
    await expect(page).toHaveURL(/\/inloggen\?redirect=/)
  })

  test('shows an empty state and no owner tabs to a friend', async ({ page, loginAs }) => {
    await loginAs('user')
    await page.goto('/terugblik?tab=lessen')
    await expect(page.getByText('Nog geen afgeronde koersdagen')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Naar Koersdag' })).toBeVisible()
    await expect(page.getByRole('tab')).toHaveCount(0)
  })

  test('explains when a koersdag has no Terugblik', async ({ page, loginAs }) => {
    await loginAs('admin')
    await page.goto('/terugblik/sessie-3')
    await expect(page.getByText('Deze koersdag bestaat niet (meer).')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Terug naar Terugblik' })).toBeVisible()
  })

  test('fetches the uitslagen, evaluates and completes an open payout', async ({
    page,
    loginAs,
  }) => {
    await loginAs('user')
    await finishKoersdag(page)

    // Place the advised bet but leave its payout open
    const advice = page.getByRole('region', { name: 'Advies' })
    await advice.getByRole('button', { name: 'Ingezet' }).click()
    await advice.getByRole('button', { name: 'Opslaan' }).click()
    await expect(advice.getByText('Ingezet: € 20,00')).toBeVisible()
    await finishNow(page)

    // The finished koersdag is listed with its (negative) saldo
    await expect(page.getByText('Uitslagen nodig')).toBeVisible()
    await page.getByRole('link', { name: /Alkmaar/ }).click()

    // Opening it lets the AI look up the uitslagen, which the user can check and edit
    await expect(page.getByTestId('ai-thinking')).toBeVisible()
    const winner = page.getByLabel('Winnaar').first()
    await expect(winner).toHaveValue('Fleur de Lis', AI_TIMEOUT)
    await winner.fill('')
    await page.getByRole('button', { name: 'Uitslagen bevestigen' }).click()
    await expect(page.getByText('Vul de winnaar van de 1e omloop in.')).toBeVisible()
    await winner.fill('Fleur de Lis')
    await page.getByRole('button', { name: 'Uitslagen bevestigen' }).click()

    // The evaluation follows by itself; lessons stay out of sight for the player
    await expect(page.getByRole('heading', { name: 'Evaluatie' })).toBeVisible()
    await expect(page.getByText(/gespeelde omlopen klopten/)).toBeVisible(AI_TIMEOUT)
    await expect(page.getByRole('heading', { name: '1e omloop' })).toBeVisible()
    await expect(page.getByText(/Advies klopte/).first()).toBeVisible()
    await expect(page.getByText('winnen favorieten vaak')).toHaveCount(0)

    // Completing the open payout updates the saldo right away
    await expect(page.getByTestId('balance')).toHaveText('−€ 20,00')
    const bets = page.getByRole('region', { name: 'Mijn inzetten' })
    await expect(bets.getByRole('button', { name: /Inzet verwijderen/ })).toHaveCount(0)
    await bets.getByLabel('Uitbetaald').fill('30')
    await bets.getByRole('button', { name: 'Opslaan' }).click()
    await expect(page.getByTestId('balance')).toHaveText('+€ 10,00')

    await page.getByRole('link', { name: 'Terugblik', exact: true }).first().click()
    await expect(page.getByText('Geëvalueerd')).toBeVisible()
  })

  test('falls back to manual uitslagen and lets the owner manage lessons', async ({
    page,
    loginAs,
  }) => {
    await loginAs('admin')
    await finishKoersdag(page, 'Foutdorp')
    await finishNow(page)

    // The AI can't find these uitslagen online: fill them in by hand
    await page.getByRole('link', { name: /Foutdorp/ }).click()
    await expect(
      page.getByText('De AI vond de uitslagen niet online.', { exact: false }),
    ).toBeVisible(AI_TIMEOUT)
    await expect(page.getByRole('button', { name: 'Opnieuw proberen' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Foto uploaden' })).toBeVisible()
    await page.getByRole('button', { name: 'Zelf invullen' }).click()
    await page.getByLabel('Winnaar').first().fill('Zilvervos')
    await page.getByRole('button', { name: 'Uitslagen bevestigen' }).click()
    await expect(
      page.getByText('Er waren geen inzetten om te vergelijken', { exact: false }),
    ).toBeVisible(AI_TIMEOUT)

    // Overzicht: totals per friend, filterable
    await page.getByRole('link', { name: 'Terugblik', exact: true }).first().click()
    await page.getByRole('tab', { name: 'Overzicht' }).click()
    await expect(page.getByRole('heading', { name: 'Per vriend' })).toBeVisible()
    await page.getByLabel('Toon koersdagen van').selectOption({ label: 'Bill' })
    await expect(page.getByText(/Foutdorp/)).toBeVisible()

    // Lessen: the evaluation added one; deleting asks first
    await page.getByRole('tab', { name: 'Lessen' }).click()
    const lesson = 'In Foutdorp winnen favorieten vaak vanaf de binnenkant.'
    await expect(page.getByText(lesson)).toBeVisible()
    await page.getByRole('button', { name: `Les verwijderen: ${lesson}` }).click()
    const dialog = page.getByRole('dialog', { name: 'Les verwijderen?' })
    await dialog.getByRole('button', { name: 'Les verwijderen' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText(lesson)).toHaveCount(0)
    await expect(page.getByText('Nog geen lessen.', { exact: false })).toBeVisible()
  })
})
