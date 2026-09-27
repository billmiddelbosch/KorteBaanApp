// One-off: creates the owner account and prints an invite link to activate it.
//   npm run create-owner -- --env dev --name "Bill" --site https://test.kortebaan.nl
// Owner forgot their password? Print a reset link instead (valid 24 hours):
//   npm run create-owner -- --env dev --site https://test.kortebaan.nl --reset
// Needs AWS credentials for eu-west-2 and a deployed table.
import { randomUUID } from 'node:crypto'
import { issueLink } from '../src/lib/links'
import { listUsers, type UserRecord } from '../src/lib/store'
import type { Alias } from '../src/lib/http'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const env = arg('env')
  const name = arg('name')
  const site = arg('site')?.replace(/\/$/, '')
  const reset = process.argv.includes('--reset')
  if ((env !== 'dev' && env !== 'prod') || !site || (!reset && !name)) {
    console.error('Gebruik: npm run create-owner -- --env dev|prod --name <naam> --site <url>')
    console.error('     of: npm run create-owner -- --env dev|prod --site <url> --reset')
    process.exit(1)
  }
  process.env.AWS_REGION ??= 'eu-west-2'
  const alias: Alias = env

  const existing = (await listUsers(alias)).find((u) => u.role === 'owner')

  if (reset) {
    if (!existing || existing.status === 'invited') {
      console.error('Er is nog geen actieve eigenaar. Maak er eerst een aan met --name.')
      process.exit(1)
    }
    const { link } = await issueLink(alias, existing, 'reset')
    console.log(`Herstellink voor ${existing.name}. Open binnen 24 uur:`)
    console.log(`${site}/herstel/${link.token}`)
    return
  }

  if (existing && existing.status !== 'invited') {
    console.error(`Er is al een actieve eigenaar (${existing.name}). Er is niets aangemaakt.`)
    console.error('Wachtwoord kwijt? Gebruik --reset voor een herstellink.')
    process.exit(1)
  }

  const owner: UserRecord = existing ?? {
    id: randomUUID(),
    name: name!,
    role: 'owner',
    status: 'invited',
    dailyLimit: null,
    tokenVersion: 0,
    failedLogins: 0,
    createdAt: new Date().toISOString(),
  }
  const { link } = await issueLink(alias, owner, 'invite')
  console.log(`Eigenaar ${existing ? 'bestond al, nieuwe link' : 'aangemaakt'}. Open binnen 7 dagen:`)
  console.log(`${site}/uitnodiging/${link.token}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
