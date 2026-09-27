import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import type {
  ChatRecord,
  Draverij,
  InstructionRecord,
  KnowledgeFact,
  Lesson,
  LockedAdvice,
  Source,
} from './analysis'
import type { Alias } from './http'
import { tableName } from './store'

// Analyse items in the single table:
//   DRAVERIJ   / D#<draverijId>          known draverij (draverijId starts with the date, so sk sorts by date)
//   USER#<id>  / CHAT#<draverijId>       analysechat (TTL: expiresAt = end of the draverij day)
//   USER#<id>  / ADVICE#<draverijId>     locked advice, kept after the chat is gone
//   CONFIG     / INSTRUCTION             owner's AI-instructie + previous version
//   KB         / FACT#<iso>#<id>         fact found by the AI
//   KB         / SOURCE#<sha256(url)>    source the AI used
//   KB         / LESSON#<iso>#<id>       lesson (written by Terugblik)

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
})

function strip<T>(item: Record<string, unknown> | undefined): T | undefined {
  if (!item) return undefined
  const { pk: _pk, sk: _sk, ...rest } = item
  return rest as T
}

async function query<T>(alias: Alias, pk: string, prefix: string, opts: { from?: string; newestFirst?: boolean; limit?: number } = {}) {
  const res = await doc.send(
    new QueryCommand({
      TableName: tableName(alias),
      KeyConditionExpression: opts.from ? 'pk = :pk AND sk >= :from' : 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: opts.from ? { ':pk': pk, ':from': opts.from } : { ':pk': pk, ':prefix': prefix },
      ScanIndexForward: !opts.newestFirst,
      Limit: opts.limit,
    }),
  )
  return (res.Items ?? [])
    .filter((item) => String(item.sk).startsWith(prefix))
    .map((item) => strip<T>(item)!)
}

// ── Draverijen ───────────────────────────────────────────────────────────

export async function listDraverijen(alias: Alias, fromDate: string): Promise<Draverij[]> {
  return query<Draverij>(alias, 'DRAVERIJ', 'D#', { from: `D#${fromDate}` })
}

export async function getDraverij(alias: Alias, id: string): Promise<Draverij | undefined> {
  const res = await doc.send(new GetCommand({ TableName: tableName(alias), Key: { pk: 'DRAVERIJ', sk: `D#${id}` } }))
  return strip<Draverij>(res.Item)
}

export async function putDraverij(alias: Alias, draverij: Draverij): Promise<void> {
  await doc.send(
    new PutCommand({ TableName: tableName(alias), Item: { pk: 'DRAVERIJ', sk: `D#${draverij.id}`, ...draverij } }),
  )
}

// ── Chats ────────────────────────────────────────────────────────────────

const chatKey = (userId: string, draverijId: string) => ({ pk: `USER#${userId}`, sk: `CHAT#${draverijId}` })

// DynamoDB TTL deletes lazily, so expired chats are filtered on read too
const alive = (chat: ChatRecord) => chat.expiresAt * 1000 > Date.now()

export async function getChat(alias: Alias, userId: string, draverijId: string): Promise<ChatRecord | undefined> {
  const res = await doc.send(new GetCommand({ TableName: tableName(alias), Key: chatKey(userId, draverijId) }))
  const chat = strip<ChatRecord>(res.Item)
  return chat && alive(chat) ? chat : undefined
}

export async function listChats(alias: Alias, userId: string): Promise<ChatRecord[]> {
  return (await query<ChatRecord>(alias, `USER#${userId}`, 'CHAT#')).filter(alive)
}

export class ChatChangedError extends Error {}

// `expectThinkingSince`: only save if the chat is still waiting for this worker run
// (the user may have restarted the chat meanwhile)
export async function putChat(
  alias: Alias,
  chat: ChatRecord,
  opts: { expectThinkingSince?: string } = {},
): Promise<void> {
  try {
    await doc.send(
      new PutCommand({
        TableName: tableName(alias),
        Item: { ...chatKey(chat.userId, chat.draverij.id), ...chat },
        ...(opts.expectThinkingSince
          ? {
              ConditionExpression: 'thinkingSince = :since',
              ExpressionAttributeValues: { ':since': opts.expectThinkingSince },
            }
          : {}),
      }),
    )
  } catch (err) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') throw new ChatChangedError()
    throw err
  }
}

// ── Locked advice ────────────────────────────────────────────────────────

const adviceKey = (userId: string, draverijId: string) => ({ pk: `USER#${userId}`, sk: `ADVICE#${draverijId}` })

export async function getAdvice(alias: Alias, userId: string, draverijId: string): Promise<LockedAdvice | undefined> {
  const res = await doc.send(new GetCommand({ TableName: tableName(alias), Key: adviceKey(userId, draverijId) }))
  return strip<LockedAdvice>(res.Item)
}

export async function listAdvice(alias: Alias, userId: string): Promise<LockedAdvice[]> {
  return query<LockedAdvice>(alias, `USER#${userId}`, 'ADVICE#')
}

export async function putAdvice(alias: Alias, userId: string, advice: LockedAdvice): Promise<void> {
  await doc.send(
    new PutCommand({ TableName: tableName(alias), Item: { ...adviceKey(userId, advice.draverij.id), ...advice } }),
  )
}

// ── AI-instructie ────────────────────────────────────────────────────────

const instructionKey = { pk: 'CONFIG', sk: 'INSTRUCTION' }

export async function getInstruction(alias: Alias): Promise<InstructionRecord | undefined> {
  const res = await doc.send(new GetCommand({ TableName: tableName(alias), Key: instructionKey }))
  return strip<InstructionRecord>(res.Item)
}

export async function putInstruction(alias: Alias, record: InstructionRecord): Promise<void> {
  await doc.send(new PutCommand({ TableName: tableName(alias), Item: { ...instructionKey, ...record } }))
}

// ── Kennisbank ───────────────────────────────────────────────────────────

export async function listFacts(alias: Alias, limit: number): Promise<KnowledgeFact[]> {
  return query<KnowledgeFact>(alias, 'KB', 'FACT#', { newestFirst: true, limit })
}

export async function listLessons(alias: Alias, limit: number): Promise<Lesson[]> {
  return query<Lesson>(alias, 'KB', 'LESSON#', { newestFirst: true, limit })
}

export async function saveKnowledge(
  alias: Alias,
  facts: KnowledgeFact[],
  sources: (Source & { hash: string; lastSeenAt: string; draverijId: string })[],
): Promise<void> {
  const items = [
    ...facts.map((f) => ({ pk: 'KB', sk: `FACT#${f.createdAt}#${f.id}`, ...f })),
    ...sources.map(({ hash, ...s }) => ({ pk: 'KB', sk: `SOURCE#${hash}`, ...s })),
  ]
  const TableName = tableName(alias)
  for (let i = 0; i < items.length; i += 25) {
    await doc.send(
      new BatchWriteCommand({
        RequestItems: { [TableName]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) },
      }),
    )
  }
}
