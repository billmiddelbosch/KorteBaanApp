import { test, expect } from './fixtures'

// The mock AI answers after ~1.2 s: first with questions, then with an advice proposal.
// A message containing "fout" makes it fail, to show the error state.
const AI_TIMEOUT = { timeout: 10_000 }

test.describe('Analyse – start screen', () => {
  test('sends guests to the login page', async ({ page }) => {
    await page.goto('/analyse')
    await expect(page).toHaveURL(/\/inloggen\?redirect=(%2F|\/)analyse$/)
  })

  test('lists the running chats', async ({ page, loginAs }) => {
    await loginAs('user')
    await page.goto('/analyse')
    await expect(page.getByRole('heading', { name: 'Analyse', level: 1 })).toBeVisible()
    const running = page.getByRole('region', { name: 'Lopende analyses' })
    await expect(running.getByRole('link', { name: /Wolvega/ })).toBeVisible()
    await expect(running.getByText('Nog geen advies')).toBeVisible()
  })

  test('explains Analyse when there are no chats yet', async ({ page, loginAs }) => {
    await loginAs('admin')
    await page.goto('/analyse')
    await expect(page.getByRole('heading', { name: 'Nog geen analyses' })).toBeVisible()
    await expect(page.getByText(/inzetadvies per omloop/)).toBeVisible()
  })

  test('validates your own koers', async ({ page, loginAs }) => {
    await loginAs('user')
    await page.goto('/analyse')
    await page.getByRole('button', { name: 'Nieuwe analyse' }).click()
    await page.getByRole('button', { name: 'Andere koers' }).click()
    await page.getByRole('button', { name: 'Analyse starten' }).click()
    await expect(page.getByText('Vul de plaats van de draverij in.')).toBeVisible()
    await expect(page.getByText('Kies de datum van de draverij.')).toBeVisible()
  })

  test('continues the existing chat for a koers', async ({ page, loginAs }) => {
    await loginAs('user')
    await page.goto('/analyse')
    await page.getByRole('button', { name: 'Nieuwe analyse' }).click()
    await page.getByRole('button', { name: /Wolvega/ }).click()
    await expect(page).toHaveURL(/\/analyse\/\d{4}-\d{2}-\d{2}-wolvega$/)
    await expect(page.getByText(/Leuk, Wolvega!/)).toBeVisible()
  })
})

test.describe('Analyse – chat', () => {
  test('starts an analysis and locks the advice', async ({ page, loginAs }) => {
    await loginAs('user')
    await page.goto('/analyse')
    await page.getByRole('button', { name: 'Nieuwe analyse' }).click()
    await page.getByRole('button', { name: /Hollandscheveld/ }).click()

    await expect(page.getByRole('heading', { name: 'Hollandscheveld', level: 1 })).toBeVisible()
    await expect(page.getByTestId('ai-thinking')).toBeVisible()
    await expect(page.getByText('Een paar vragen voordat ik een advies maak')).toBeVisible(
      AI_TIMEOUT,
    )
    await expect(page.getByText('Bronnen (2)')).toBeVisible()

    await page.getByLabel('Bericht aan de AI').fill('Budget 50 euro, liefst wat op zeker.')
    await page.getByRole('button', { name: 'Versturen' }).click()
    await expect(page.getByLabel('Bericht aan de AI')).toHaveValue('')
    await expect(page.getByText('Budget 50 euro, liefst wat op zeker.')).toBeVisible()

    const card = page.getByTestId('advice-card')
    await expect(card).toBeVisible(AI_TIMEOUT)
    await expect(card.getByText('Winnaar: Fleur de Lis')).toBeVisible()
    await card.getByRole('button', { name: 'Advies vastleggen' }).click()
    await expect(card.getByText('Vastgelegd')).toBeVisible()
    await expect(page.getByText('Advies vastgelegd', { exact: false }).first()).toBeVisible()
    await expect(card.getByRole('link', { name: 'Naar Koersdag' })).toHaveAttribute('href', '/')

    await page.getByRole('link', { name: 'Alle analyses' }).click()
    await expect(
      page.getByRole('link', { name: /Hollandscheveld/ }).getByText('Advies vastgelegd'),
    ).toBeVisible()
  })

  test('shows an AI error and retries', async ({ page, loginAs }) => {
    await loginAs('user')
    await page.goto('/analyse')
    await page
      .getByRole('region', { name: 'Lopende analyses' })
      .getByRole('link', { name: /Wolvega/ })
      .click()

    await page.getByLabel('Bericht aan de AI').fill('Dit gaat fout')
    await page.getByRole('button', { name: 'Versturen' }).click()
    await expect(page.getByText(/Claude reageert even niet/)).toBeVisible(AI_TIMEOUT)

    await page.getByRole('button', { name: 'Opnieuw proberen' }).click()
    await expect(page.getByTestId('ai-thinking')).toBeVisible()
  })

  test('starts over after confirming', async ({ page, loginAs }) => {
    await loginAs('user')
    await page.goto('/analyse')
    await page
      .getByRole('region', { name: 'Lopende analyses' })
      .getByRole('link', { name: /Wolvega/ })
      .click()
    await expect(page.getByText(/Leuk, Wolvega!/)).toBeVisible()

    await page.getByRole('button', { name: 'Opnieuw beginnen' }).click()
    const dialog = page.getByRole('dialog', { name: 'Opnieuw beginnen?' })
    await dialog.getByRole('button', { name: 'Opnieuw beginnen' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText(/Leuk, Wolvega!/)).toBeHidden()
    await expect(page.getByText('Een paar vragen voordat ik een advies maak')).toBeVisible(
      AI_TIMEOUT,
    )
  })

  test('explains a chat that does not exist', async ({ page, loginAs }) => {
    await loginAs('user')
    await page.goto('/analyse/2000-01-01-nergens')
    await expect(page.getByText(/Deze analyse bestaat niet \(meer\)/)).toBeVisible()
  })
})

test.describe('AI-instructie', () => {
  test('is only for the owner', async ({ page, loginAs }) => {
    await loginAs('user')
    await page.goto('/account/ai-instructie')
    await expect(page).toHaveURL(/\/$/)
  })

  test('edits the instruction and reverts it', async ({ page, loginAs }) => {
    await loginAs('admin')
    await page.goto('/account/ai-instructie')
    const field = page.getByLabel('Instructie')
    await expect(field).toHaveValue(/expert op het gebied van kortebaandraverijen/)
    await expect(page.getByRole('button', { name: 'Terug naar standaard' })).toBeDisabled()

    await field.fill('Wees extra voorzichtig met inzetten.')
    await page.getByRole('button', { name: 'Opslaan' }).click()
    await expect(page.getByText('Instructie opgeslagen.', { exact: false })).toBeVisible()
    await expect(page.getByText('Aangepast', { exact: false })).toBeVisible()

    await page.getByRole('button', { name: 'Terug naar standaard' }).click()
    await page
      .getByRole('dialog', { name: 'Standaardinstructie terugzetten?' })
      .getByRole('button', { name: 'Standaard terugzetten' })
      .click()
    await expect(page.getByText('De standaardinstructie staat weer aan.')).toBeVisible()
    await expect(field).toHaveValue(/expert op het gebied van kortebaandraverijen/)

    await page.getByRole('button', { name: 'Terug naar vorige versie' }).click()
    await page
      .getByRole('dialog', { name: 'Vorige versie terugzetten?' })
      .getByRole('button', { name: 'Vorige versie terugzetten' })
      .click()
    await expect(field).toHaveValue('Wees extra voorzichtig met inzetten.')
  })
})
