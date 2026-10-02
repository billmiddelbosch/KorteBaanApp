// Creates/updates the kennisbank schema, roles and grants (as DSQL admin).
//   npm run kb-migrate -- --host <KbEndpoint> --writer-arn <arn>[,<arn>…] [--reader-arn <arn>[,<arn>…]]
//                         [--lessons-table <prod table>]
// Idempotent: run it after every deploy that brings a new migration or a new Lambda role
// (pass the KbWriterRoleArns output as --writer-arn). Needs AWS credentials for eu-west-2 with
// dsql:DbConnectAdmin on the cluster. --lessons-table copies the Terugblik lessons from the
// DynamoDB table (KB / LESSON#…) into kb.lesson once; running it again adds nothing.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb'
import type pg from 'pg'
import { connect, insertMany } from '../src/lib/kb/db'
import { grantRoles, mapIamRole, migrate, type ROLES } from '../src/lib/kb/migrations'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

async function mapRoles(client: pg.Client, role: (typeof ROLES)[number], arns: string[]) {
  for (const arn of arns) {
    try {
      await mapIamRole(client, role, arn)
      console.log(`${role} gekoppeld aan ${arn}`)
    } catch (err) {
      // Mapping an IAM role twice fails; that is the state we want
      if (!/already|exists|bestaat/i.test((err as Error).message)) throw err
      console.log(`${role} was al gekoppeld aan ${arn}`)
    }
  }
}

interface DynamoLesson {
  id: string
  text: string
  createdAt: string
  draverijId?: string
}

async function migrateLessons(client: pg.Client, table: string) {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}))
  const lessons: DynamoLesson[] = []
  let ExclusiveStartKey: Record<string, unknown> | undefined
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': 'KB', ':prefix': 'LESSON#' },
        ExclusiveStartKey,
      }),
    )
    lessons.push(...((res.Items ?? []) as DynamoLesson[]))
    ExclusiveStartKey = res.LastEvaluatedKey
  } while (ExclusiveStartKey)

  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const rows = lessons
    .filter((l) => uuid.test(l.id) && l.text?.trim())
    .map((l) => [l.id, l.text.trim(), 0.6, 'actief', l.draverijId ?? null, 'terugblik', 'prod', l.createdAt])
  await client.query('begin')
  try {
    await insertMany(
      client,
      'kb.lesson',
      ['id', 'text', 'confidence', 'status', 'draverij_id', 'created_by', 'origin', 'created_at'],
      rows,
      'on conflict (id) do nothing',
    )
    await client.query('commit')
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  }
  console.log(`${rows.length} van ${lessons.length} lessen overgezet uit ${table} (bestaande overgeslagen)`)
}

async function main() {
  const host = arg('host')
  if (!host) {
    console.error(
      'Gebruik: npm run kb-migrate -- --host <KbEndpoint> [--writer-arn <arn>[,<arn>…]] [--reader-arn <arn>[,<arn>…]] [--lessons-table <tabel>]',
    )
    process.exit(1)
  }
  process.env.AWS_REGION ??= 'eu-west-2'
  const client = await connect({ host, role: 'admin' })
  try {
    const ran = await migrate(client)
    console.log(ran.length ? `Uitgevoerd: ${ran.join(', ')}` : 'Schema is al actueel')
    await grantRoles(client)
    console.log('Rollen kb_writer en kb_reader bijgewerkt')
    await mapRoles(client, 'kb_writer', list(arg('writer-arn')))
    await mapRoles(client, 'kb_reader', list(arg('reader-arn')))
    const lessonsTable = arg('lessons-table')
    if (lessonsTable) await migrateLessons(client, lessonsTable)
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
