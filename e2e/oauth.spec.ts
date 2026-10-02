import { test, expect } from './fixtures'
import { MOCK_OAUTH_CLIENT, MOCK_PASSWORD, OWNER_USERNAME } from '../src/mocks/data'

const CALLBACK = 'http://localhost:33418/callback'

function authorizeUrl(extra: Record<string, string> = {}) {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: MOCK_OAUTH_CLIENT.clientId,
    redirect_uri: CALLBACK,
    code_challenge: 'c'.repeat(43),
    code_challenge_method: 'S256',
    state: 'xyz',
    ...extra,
  })
  return `/oauth/authorize?${query}`
}

test.describe('OAuth-koppeling', () => {
  test.beforeEach(async ({ page }) => {
    // The MCP client listens on loopback; stand in for it
    await page.route(`${CALLBACK}**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<p>Terug in de app</p>' }),
    )
  })

  test('stuurt een gast via inloggen terug naar de toestemming', async ({ page }) => {
    await page.goto(authorizeUrl())
    await expect(page).toHaveURL(/\/inloggen\?redirect=/)
    await page.getByLabel('Gebruikersnaam').fill(OWNER_USERNAME)
    await page.getByLabel('Wachtwoord', { exact: true }).fill(MOCK_PASSWORD)
    await page.getByRole('button', { name: 'Inloggen' }).click()
    await expect(page.getByRole('heading', { name: 'Koppelen met de kennisbank' })).toBeVisible()
    await expect(
      page.getByText('Claude Code wil toegang tot de kennisbank namens jou.'),
    ).toBeVisible()
  })

  test('de eigenaar ziet alle rechten en keert na toestaan terug met een code', async ({
    page,
    loginAs,
  }) => {
    await loginAs('admin')
    await page.goto(authorizeUrl())
    await expect(page.getByText('De kennisbank lezen', { exact: false })).toBeVisible()
    await expect(page.getByText('Feiten en lessen aan de kennisbank toevoegen.')).toBeVisible()
    await expect(page.getByText('Eigen leesvragen (SQL)', { exact: false })).toBeVisible()
    await expect(page.getByText('localhost:33418')).toBeVisible()

    await page.getByRole('button', { name: 'Toestaan' }).click()
    await expect(page).toHaveURL(/localhost:33418\/callback\?code=mock-oauth-code&state=xyz/)
  })

  test('een vriend krijgt alleen leesrechten', async ({ page, loginAs }) => {
    await loginAs('user')
    await page.goto(authorizeUrl())
    await expect(page.getByText('De kennisbank lezen', { exact: false })).toBeVisible()
    await expect(page.getByText('Feiten en lessen aan de kennisbank toevoegen.')).toHaveCount(0)
  })

  test('weigeren stuurt access_denied terug', async ({ page, loginAs }) => {
    await loginAs('admin')
    await page.goto(authorizeUrl())
    await page.getByRole('button', { name: 'Weigeren' }).click()
    await expect(page).toHaveURL(/callback\?error=access_denied&state=xyz/)
  })

  test('toont een fout bij een onbekende app of zonder PKCE', async ({ page, loginAs }) => {
    await loginAs('admin')
    await page.goto(authorizeUrl({ client_id: 'onbekend' }))
    await expect(page.getByRole('alert')).toContainText('Deze app is niet (meer) bekend.')
    await page.goto(authorizeUrl({ code_challenge_method: 'plain' }))
    await expect(page.getByRole('alert')).toContainText('geen veilige koppeling (PKCE)')
    await expect(page.getByRole('button', { name: 'Toestaan' })).toHaveCount(0)
  })
})
