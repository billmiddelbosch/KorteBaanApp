// Creates/updates the kennisbank schema, roles and grants (as DSQL admin).
//   npm run kb-migrate -- --host <KbEndpoint> --writer-arn <KbIngestRoleArn> [--reader-arn <arn>]
// Idempotent: run it after every deploy that brings a new migration. Needs AWS credentials
// for eu-west-2 with dsql:DbConnectAdmin on the cluster.
import { connect } from '../src/lib/kb/db'
import { grantRoles, mapIamRole, migrate } from '../src/lib/kb/migrations'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const host = arg('host')
  if (!host) {
    console.error('Gebruik: npm run kb-migrate -- --host <KbEndpoint> [--writer-arn <arn>] [--reader-arn <arn>]')
    process.exit(1)
  }
  process.env.AWS_REGION ??= 'eu-west-2'
  const client = await connect({ host, role: 'admin' })
  try {
    const ran = await migrate(client)
    console.log(ran.length ? `Uitgevoerd: ${ran.join(', ')}` : 'Schema is al actueel')
    await grantRoles(client)
    console.log('Rollen kb_writer en kb_reader bijgewerkt')
    const writer = arg('writer-arn')
    const reader = arg('reader-arn')
    if (writer) {
      await mapIamRole(client, 'kb_writer', writer)
      console.log(`kb_writer gekoppeld aan ${writer}`)
    }
    if (reader) {
      await mapIamRole(client, 'kb_reader', reader)
      console.log(`kb_reader gekoppeld aan ${reader}`)
    }
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
