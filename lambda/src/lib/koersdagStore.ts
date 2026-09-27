import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import type { Alias } from './http'
import type { KoersdagRecord } from './koersdag'
import { tableName } from './store'

// Koersdag items in the single table:
//   USER#<id> / KOERSDAG#<draverijId>   one koersdag per user per draverij (TTL: expiresAt)

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
})

const key = (userId: string, draverijId: string) => ({ pk: `USER#${userId}`, sk: `KOERSDAG#${draverijId}` })

export async function getKoersdag(alias: Alias, userId: string, draverijId: string): Promise<KoersdagRecord | undefined> {
  const res = await doc.send(new GetCommand({ TableName: tableName(alias), Key: key(userId, draverijId) }))
  if (!res.Item) return undefined
  const { pk: _pk, sk: _sk, ...record } = res.Item
  const koersdag = record as KoersdagRecord
  // DynamoDB TTL deletes lazily
  return koersdag.expiresAt * 1000 > Date.now() ? koersdag : undefined
}

// Someone else (the worker, another tab) saved in between
export class KoersdagChangedError extends Error {}

// Optimistic locking: `expectUpdatedAt` saves only over the version that was read;
// `create` only when there is no koersdag yet
export async function putKoersdag(
  alias: Alias,
  record: KoersdagRecord,
  opts: { expectUpdatedAt?: string; create?: boolean } = {},
): Promise<void> {
  const condition = opts.create
    ? { ConditionExpression: 'attribute_not_exists(pk)' }
    : opts.expectUpdatedAt
      ? {
          ConditionExpression: 'updatedAt = :expected',
          ExpressionAttributeValues: { ':expected': opts.expectUpdatedAt },
        }
      : {}
  try {
    await doc.send(
      new PutCommand({
        TableName: tableName(alias),
        Item: { ...key(record.userId, record.draverij.id), ...record },
        ...condition,
      }),
    )
  } catch (err) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') throw new KoersdagChangedError()
    throw err
  }
}
