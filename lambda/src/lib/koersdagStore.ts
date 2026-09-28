import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import type { Alias } from './http'
import type { BoardReading, KoersdagRecord } from './koersdag'
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

// Bordfoto readings, shared by everyone on the same koersdag:
//   DRAVERIJ#<draverijId> / BORD#<omloop>#<readAt>#<id>   quota/loting read from a photo (TTL: expiresAt)

const BOARD_KEEP_SECONDS = 2 * 24 * 60 * 60
const boardPrefix = (omloop: number) => `BORD#${String(omloop).padStart(2, '0')}#`

export async function putBoardReading(alias: Alias, draverijId: string, reading: BoardReading): Promise<void> {
  await doc.send(
    new PutCommand({
      TableName: tableName(alias),
      Item: {
        pk: `DRAVERIJ#${draverijId}`,
        sk: `${boardPrefix(reading.omloop)}${reading.readAt}#${reading.id}`,
        ...reading,
        expiresAt: Math.floor(Date.now() / 1000) + BOARD_KEEP_SECONDS,
      },
    }),
  )
}

// Newest first
export async function listBoardReadings(
  alias: Alias,
  draverijId: string,
  omloop: number,
  limit = 3,
): Promise<BoardReading[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: tableName(alias),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `DRAVERIJ#${draverijId}`, ':prefix': boardPrefix(omloop) },
      ScanIndexForward: false,
      Limit: limit,
    }),
  )
  return (res.Items ?? []).map(({ id, omloop: o, userId, readAt, quota, loting }) => ({
    id,
    omloop: o,
    userId,
    readAt,
    quota,
    loting,
  })) as BoardReading[]
}
