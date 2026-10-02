import { test, expect } from './fixtures'

// The mock AI answers after ~1.2 s. Omloop 1 keeps the advice, 2 changes it, 3 is the finale.
// A photo always reports a difference with the board; a place containing "fout" can't be fetched.
const AI_TIMEOUT = { timeout: 10_000 }

// 1×1 PNG: enough for the browser to decode and re-encode as JPEG
const PHOTO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test.describe('Koersdag', () => {
  test('sends guests to the login page', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/inloggen$/)
  })

  test('validates the start form', async ({ page, loginAs }) => {
    await loginAs('user')
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Koersdag', exact: true })).toBeVisible()
    await page.getByLabel('Budget voor vandaag').fill('')
    await page.getByRole('radio', { name: 'Andere draverij' }).check()
    await page.getByRole('button', { name: 'Koersdag starten' }).click()
    await expect(page.getByText('Vul de plaats van de draverij in.')).toBeVisible()
    await expect(page.getByText('Vul een budget in van meer dan € 0.')).toBeVisible()
  })

  test('runs a whole koersdag from the locked advice to the finale', async ({ page, loginAs }) => {
    await loginAs('user')
    await page.goto('/')

    // Today's draverij with a locked advice is preselected, its budget prefilled
    await expect(page.getByRole('radio', { name: /Alkmaar/ })).toBeChecked()
    await expect(page.getByLabel('Budget voor vandaag')).toHaveValue('50')
    await page.getByRole('button', { name: 'Koersdag starten' }).click()

    await expect(page.getByTestId('ai-thinking')).toBeVisible()
    await expect(page.getByText('Advies blijft staan')).toBeVisible(AI_TIMEOUT)
    await expect(page.getByRole('heading', { name: '1e omloop' })).toBeVisible()
    const budget = page.getByRole('region', { name: 'Budget' })
    await expect(budget.getByText('€ 50,00').first()).toBeVisible()

    // Mark the advice as placed; the amount is prefilled from the suggestion
    const advice = page.getByRole('region', { name: 'Advies' })
    // Chance and board quota give the expected value per euro
    await expect(advice.getByText('Kans 40% · quota 3,2 · verwachting +28%')).toBeVisible()
    await advice.getByRole('button', { name: 'Ingezet' }).click()
    await expect(advice.getByLabel('Hoeveel heb je ingezet?')).toHaveValue('20')
    await advice.getByRole('button', { name: 'Opslaan' }).click()
    await expect(advice.getByText('Ingezet: € 20,00')).toBeVisible()
    await expect(budget.getByText('€ 30,00')).toBeVisible()

    // The photo of the board wins and the differences are listed
    await page.getByTestId('photo-input').setInputFiles({
      name: 'bord.png',
      mimeType: 'image/png',
      buffer: PHOTO,
    })
    await page.getByRole('button', { name: 'Controleer bord' }).click()
    await expect(page.getByText('Advies aangepast')).toBeVisible(AI_TIMEOUT)
    await expect(page.getByText('Verschillen met het bord')).toBeVisible()
    await expect(page.getByText('Quota Fleur de Lis 3,2 → 4,1')).toBeVisible()
    await expect(page.getByText('Eerdere updates (1)')).toBeVisible()

    // Payout of the first bet
    const bets = page.getByRole('region', { name: 'Mijn inzetten' })
    await bets.getByLabel('Uitbetaald').fill('45')
    await bets.getByRole('button', { name: 'Opslaan' }).click()
    await expect(bets.getByText('Uitbetaald € 45,00')).toBeVisible()

    await page.getByRole('button', { name: 'Volgende omloop' }).click()
    await expect(page.getByRole('heading', { name: '2e omloop' })).toBeVisible()
    await expect(page.getByText('Nieuw: Hessel B', { exact: false })).toBeVisible(AI_TIMEOUT)
    // Without a board quota: from which quota the bet is worth it
    await expect(page.getByText('Kans 60% · zinvol vanaf quota 1,67')).toBeVisible()

    await page.getByRole('button', { name: 'Volgende omloop' }).click()
    await expect(page.getByRole('heading', { name: '3e omloop' })).toBeVisible()
    await expect(page.getByText('Dit is de finale', { exact: false })).toBeVisible(AI_TIMEOUT)

    // After the finale, finishing is the main action and needs no confirmation
    await page.getByRole('button', { name: 'Koersdag afronden' }).click()
    await expect(page.getByRole('heading', { name: 'Koersdag afgerond' })).toBeVisible()
    await expect(page.getByText('+€ 25,00')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Naar Terugblik' })).toBeVisible()
    await expect(page.getByRole('link', { name: /^Live:/ })).toHaveCount(0)
  })

  test('asks before finishing before the finale', async ({ page, loginAs }) => {
    await loginAs('user')
    await page.goto('/')
    await page.getByRole('button', { name: 'Koersdag starten' }).click()
    await expect(page.getByText('Advies blijft staan')).toBeVisible(AI_TIMEOUT)

    await page.getByRole('button', { name: 'Koersdag nu afronden' }).click()
    const dialog = page.getByRole('dialog', { name: 'Koersdag nu afronden?' })
    await dialog.getByRole('button', { name: 'Doorgaan met de koersdag' }).click()
    await expect(dialog).toBeHidden()

    await page.getByRole('button', { name: 'Koersdag nu afronden' }).click()
    await dialog.getByRole('button', { name: 'Koersdag afronden' }).click()
    await expect(page.getByRole('heading', { name: 'Koersdag afgerond' })).toBeVisible()
  })

  test('starts without advice and recovers when fetching fails', async ({ page, loginAs }) => {
    await loginAs('admin')
    await page.goto('/')
    await expect(page.getByText('Geen vastgelegd advies', { exact: false })).toBeVisible()
    await page.getByRole('radio', { name: 'Andere draverij' }).check()
    await page.getByLabel('Plaats van de draverij').fill('Foutdorp')
    await page.getByLabel('Budget voor vandaag').fill('25')
    await page.getByRole('button', { name: 'Koersdag starten' }).click()

    await expect(
      page.getByText('De AI kon online niets actueels vinden', { exact: false }),
    ).toBeVisible(AI_TIMEOUT)
    await expect(page.getByRole('button', { name: 'Opnieuw proberen' })).toBeVisible()

    // A photo of the board still works
    await page.getByTestId('photo-input').setInputFiles({
      name: 'bord.png',
      mimeType: 'image/png',
      buffer: PHOTO,
    })
    await page.getByRole('button', { name: 'Controleer bord' }).click()
    await expect(page.getByText('Advies aangepast')).toBeVisible(AI_TIMEOUT)
  })

  test('checks several photos of the board together', async ({ page, loginAs }) => {
    await loginAs('user')
    await page.goto('/')
    await page.getByRole('button', { name: 'Koersdag starten' }).click()
    await expect(page.getByText('Advies blijft staan')).toBeVisible(AI_TIMEOUT)

    // A photo waits until the board is complete
    const photo = { name: 'bord.png', mimeType: 'image/png', buffer: PHOTO }
    await page.getByTestId('photo-input').setInputFiles(photo)
    const tray = page.getByTestId('pending-photos')
    await expect(tray.getByRole('img')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Controleer bord' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Volgende omloop' })).toBeHidden()

    // Up to three photos; then adding more is no longer offered
    await page.getByTestId('photo-input').setInputFiles(photo)
    await page.getByTestId('photo-input').setInputFiles(photo)
    await expect(tray.getByRole('img')).toHaveCount(3)
    await expect(page.getByRole('button', { name: 'Nog een foto' })).toBeHidden()

    // Remove one, add none and check the two together
    await page.getByRole('button', { name: 'Foto 3 verwijderen' }).click()
    await expect(tray.getByRole('img')).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'Nog een foto' })).toBeVisible()
    await page.getByRole('button', { name: "Controleer bord (2 foto's)" }).click()
    await expect(page.getByText('Advies aangepast')).toBeVisible(AI_TIMEOUT)
    await expect(tray).toBeHidden()
    await expect(page.getByRole('button', { name: 'Volgende omloop' })).toBeVisible()
  })

  test('removing the only photo goes back to the normal actions', async ({ page, loginAs }) => {
    await loginAs('user')
    await page.goto('/')
    await page.getByRole('button', { name: 'Koersdag starten' }).click()
    await expect(page.getByText('Advies blijft staan')).toBeVisible(AI_TIMEOUT)

    await page
      .getByTestId('photo-input')
      .setInputFiles({ name: 'bord.png', mimeType: 'image/png', buffer: PHOTO })
    await page.getByRole('button', { name: 'Foto 1 verwijderen' }).click()
    await expect(page.getByTestId('pending-photos')).toBeHidden()
    await expect(page.getByRole('button', { name: 'Volgende omloop' })).toBeVisible()
  })
})
