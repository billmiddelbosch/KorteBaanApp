import { test, expect } from './fixtures'
import {
  EXPIRED_INVITE_TOKEN,
  INVITE_TOKEN,
  MOCK_PASSWORD,
  OWNER_USERNAME,
  PAUSED_USERNAME,
  RESET_TOKEN,
} from '../src/mocks/data'

test.describe('Route guards', () => {
  test('sends guests to the login page and back after logging in', async ({ page }) => {
    await page.goto('/account')
    await expect(page).toHaveURL(/\/inloggen\?redirect=(%2F|\/)account$/)
    await expect(page.getByRole('heading', { name: 'Inloggen' })).toBeVisible()

    await page.getByLabel('Gebruikersnaam').fill(OWNER_USERNAME)
    await page.getByLabel('Wachtwoord', { exact: true }).fill(MOCK_PASSWORD)
    await page.getByRole('button', { name: 'Inloggen' }).click()
    await expect(page).toHaveURL(/\/account$/)
    await expect(page.getByRole('heading', { name: 'Mijn account' })).toBeVisible()
  })

  test('keeps friends out of owner pages', async ({ page, loginAs }) => {
    await loginAs('user')
    await page.goto('/account/vrienden')
    await expect(page).toHaveURL(/\/$/)
    await page.goto('/account/ai-koppeling')
    await expect(page).toHaveURL(/\/$/)
  })

  test('redirects a logged-in user away from the login page', async ({ page, loginAs }) => {
    await loginAs('user')
    await page.goto('/inloggen')
    await expect(page).toHaveURL(/\/$/)
  })
})

test.describe('Login', () => {
  test('validates empty fields', async ({ page }) => {
    await page.goto('/inloggen')
    await page.getByRole('button', { name: 'Inloggen' }).click()
    await expect(page.getByText('Vul je gebruikersnaam in.')).toBeVisible()
    await expect(page.getByText('Vul je wachtwoord in.')).toBeVisible()
  })

  test('shows a clear message for a wrong password', async ({ page }) => {
    await page.goto('/inloggen')
    await page.getByLabel('Gebruikersnaam').fill(OWNER_USERNAME)
    await page.getByLabel('Wachtwoord', { exact: true }).fill('verkeerd-wachtwoord')
    await page.getByRole('button', { name: 'Inloggen' }).click()
    await expect(page.getByText('Gebruikersnaam of wachtwoord klopt niet.')).toBeVisible()
  })

  test('tells a paused friend why they cannot log in', async ({ page }) => {
    await page.goto('/inloggen')
    await page.getByLabel('Gebruikersnaam').fill(PAUSED_USERNAME)
    await page.getByLabel('Wachtwoord', { exact: true }).fill(MOCK_PASSWORD)
    await page.getByRole('button', { name: 'Inloggen' }).click()
    await expect(page.getByText(/Je toegang is gepauzeerd/)).toBeVisible()
  })

  test('logs out via the user menu', async ({ page, loginAs }) => {
    await loginAs('admin')
    await page.goto('/')
    await page.getByRole('button', { name: /Gebruikersmenu/ }).click()
    await page.getByRole('button', { name: 'Uitloggen' }).click()
    await expect(page).toHaveURL(/\/inloggen$/)
  })

  test('explains how to recover a forgotten password', async ({ page }) => {
    await page.goto('/inloggen')
    await page.getByRole('link', { name: 'Wachtwoord vergeten?' }).click()
    await expect(page.getByRole('heading', { name: 'Wachtwoord vergeten' })).toBeVisible()
    await expect(page.getByText(/Vraag de eigenaar om een nieuwe link/)).toBeVisible()
  })
})

test.describe('Invite and reset links', () => {
  test('creates an account from an invite link', async ({ page }) => {
    await page.goto(`/uitnodiging/${INVITE_TOKEN}`)
    await expect(page.getByRole('heading', { name: 'Welkom, Joost' })).toBeVisible()
    await expect(page.getByLabel('Je naam')).toHaveValue('Joost')

    await page.getByRole('button', { name: 'Account aanmaken' }).click()
    await expect(page.getByText(/Gebruik 3 tot 30 tekens/)).toBeVisible()
    await expect(page.getByText('Kies een wachtwoord van minimaal 10 tekens.')).toBeVisible()

    await page.getByLabel('Gebruikersnaam').fill('joost')
    await page.getByLabel('Wachtwoord', { exact: true }).fill('een-lang-wachtwoord')
    await page.getByRole('button', { name: 'Account aanmaken' }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('button', { name: /Gebruikersmenu van Joost/ })).toBeVisible()
  })

  test('rejects a username that is already taken', async ({ page }) => {
    await page.goto(`/uitnodiging/${INVITE_TOKEN}`)
    await page.getByLabel('Gebruikersnaam').fill(OWNER_USERNAME)
    await page.getByLabel('Wachtwoord', { exact: true }).fill('een-lang-wachtwoord')
    await page.getByRole('button', { name: 'Account aanmaken' }).click()
    await expect(page.getByText('Deze gebruikersnaam is al bezet. Kies een andere.')).toBeVisible()
  })

  test('explains an expired invite link', async ({ page }) => {
    await page.goto(`/uitnodiging/${EXPIRED_INVITE_TOKEN}`)
    await expect(page.getByRole('heading', { name: 'Deze link werkt niet meer' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Naar inloggen' })).toBeVisible()
  })

  test('sets a new password from a reset link', async ({ page }) => {
    await page.goto(`/herstel/${RESET_TOKEN}`)
    await expect(page.getByRole('heading', { name: 'Kies een nieuw wachtwoord' })).toBeVisible()
    await page.getByLabel('Nieuw wachtwoord', { exact: true }).fill('nieuw-geheim-123')
    await page.getByRole('button', { name: 'Wachtwoord opslaan en inloggen' }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('button', { name: /Gebruikersmenu van Kees/ })).toBeVisible()
  })
})

test.describe('My account', () => {
  test('shows play sessions with the total balance', async ({ page, loginAs }) => {
    await loginAs('admin')
    await page.goto('/account')
    await expect(page.getByRole('heading', { name: 'Mijn speelsessies' })).toBeVisible()
    await expect(page.locator('a[href^="/terugblik/"]', { hasText: 'Wolvega' })).toBeVisible()
    await expect(page.getByTestId('total-balance')).toContainText('4,50')
  })

  test('shows an empty state for a friend without sessions', async ({ page, loginAs }) => {
    await loginAs('user')
    await page.goto('/account')
    await expect(page.getByText('Nog geen speelsessies')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Naar Koersdag' })).toBeVisible()
  })

  test('changes the display name', async ({ page, loginAs }) => {
    await loginAs('user')
    await page.goto('/account')
    await page.getByLabel('Naam').fill('Kees de Vries')
    await page.getByRole('button', { name: 'Naam opslaan' }).click()
    await expect(page.getByText('Naam opgeslagen.')).toBeVisible()
    await expect(
      page.getByRole('button', { name: /Gebruikersmenu van Kees de Vries/ }),
    ).toBeVisible()
  })

  test('rejects a wrong current password', async ({ page, loginAs }) => {
    await loginAs('user')
    await page.goto('/account')
    await page.getByLabel('Huidig wachtwoord', { exact: true }).fill('fout-wachtwoord')
    await page.getByLabel('Nieuw wachtwoord', { exact: true }).fill('nieuw-geheim-123')
    await page.getByRole('button', { name: 'Wachtwoord wijzigen' }).click()
    await expect(page.getByText('Je huidige wachtwoord klopt niet.')).toBeVisible()
  })
})

test.describe('Friends', () => {
  test.beforeEach(async ({ loginAs }) => {
    await loginAs('admin')
  })

  test('lists friends with their status', async ({ page }) => {
    await page.goto('/account/vrienden')
    const kees = page.getByRole('listitem', { name: 'Kees' })
    await expect(kees.getByText('Actief', { exact: true })).toBeVisible()
    await expect(
      page.getByRole('listitem', { name: 'Anouk' }).getByText('Gepauzeerd'),
    ).toBeVisible()
    await expect(
      page.getByRole('listitem', { name: 'Marieke' }).getByText('Link verlopen'),
    ).toBeVisible()
  })

  test('invites a friend and shows the link to share', async ({ page }) => {
    await page.goto('/account/vrienden')
    await page.getByRole('button', { name: 'Vriend uitnodigen' }).first().click()
    await page.getByRole('button', { name: 'Uitnodigingslink maken' }).click()
    await expect(page.getByText('Vul de naam van je vriend in.')).toBeVisible()

    await page.getByLabel('Naam').fill('Pieter')
    await page.getByRole('button', { name: 'Uitnodigingslink maken' }).click()
    await expect(page.getByRole('heading', { name: 'Uitnodiging voor Pieter' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Kopieer link' })).toBeVisible()
    await expect(
      page.getByRole('listitem', { name: 'Pieter' }).getByText('Uitgenodigd'),
    ).toBeVisible()
  })

  test('pauses and resumes a friend', async ({ page }) => {
    await page.goto('/account/vrienden')
    const kees = page.getByRole('listitem', { name: 'Kees' })
    await kees.getByRole('button', { name: 'Pauzeren' }).click()
    await expect(kees.getByText('Gepauzeerd')).toBeVisible()
    await kees.getByRole('button', { name: 'Hervatten' }).click()
    await expect(kees.getByText('Actief', { exact: true })).toBeVisible()
  })

  test('changes the daily limit', async ({ page }) => {
    await page.goto('/account/vrienden')
    const kees = page.getByRole('listitem', { name: 'Kees' })
    await kees.getByRole('button', { name: 'Daglimiet wijzigen' }).click()
    await kees.getByLabel('AI-analyses per dag').fill('abc')
    await kees.getByRole('button', { name: 'Opslaan' }).click()
    await expect(kees.getByText(/Vul een heel getal/)).toBeVisible()
    await kees.getByLabel('AI-analyses per dag').fill('20')
    await kees.getByRole('button', { name: 'Opslaan' }).click()
    await expect(kees.getByText(/van 20 vandaag/)).toBeVisible()
  })

  test('removes a friend after confirming', async ({ page }) => {
    await page.goto('/account/vrienden')
    await page
      .getByRole('listitem', { name: 'Anouk' })
      .getByRole('button', { name: 'Verwijderen' })
      .click()
    const dialog = page.getByRole('dialog', { name: 'Anouk verwijderen?' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Anouk verwijderen' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('listitem', { name: 'Anouk' })).toHaveCount(0)
  })
})

test.describe('AI connection', () => {
  test.beforeEach(async ({ loginAs }) => {
    await loginAs('admin')
  })

  test('shows the status and tests the connection', async ({ page }) => {
    await page.goto('/account/ai-koppeling')
    await expect(page.getByTestId('ai-status')).toContainText('Gekoppeld')
    await page.getByRole('button', { name: 'Verbinding testen' }).click()
    await expect(page.getByText('De verbinding werkt.')).toBeVisible()
  })

  test('rejects something that is not a setup-token', async ({ page }) => {
    await page.goto('/account/ai-koppeling')
    await page.getByLabel('Setup-token', { exact: true }).fill('dit-is-geen-token')
    await page.getByRole('button', { name: 'Token vervangen' }).click()
    await expect(page.getByText(/Dit lijkt geen setup-token/)).toBeVisible()
  })

  test('shows a problem when Claude refuses the new token', async ({ page }) => {
    await page.goto('/account/ai-koppeling')
    await page.getByLabel('Setup-token', { exact: true }).fill('sk-ant-oat01-ongeldig-voorbeeld')
    await page.getByRole('button', { name: 'Token vervangen' }).click()
    await expect(page.getByTestId('ai-status')).toContainText('Probleem met de koppeling')
    // The app-wide notice tells the owner AI advice is off
    await expect(page.getByText('AI-advies staat uit.')).toBeVisible()
  })

  test('removes the connection after confirming', async ({ page }) => {
    await page.goto('/account/ai-koppeling')
    await page.getByRole('button', { name: 'Koppeling verwijderen' }).click()
    const dialog = page.getByRole('dialog', { name: 'AI-koppeling verwijderen?' })
    await dialog.getByRole('button', { name: 'Koppeling verwijderen' }).click()
    await expect(page.getByTestId('ai-status')).toContainText('Niet gekoppeld')
  })
})
