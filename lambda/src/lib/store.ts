import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import type { Alias } from './http'

// Single-table layout, one table per alias (kortebaan-dev / kortebaan-prod):
//   USERS             / USER#<id>                 user record
//   USERNAME#<name>   / USERNAME                  username → userId (uniqueness)
//   LINK#<sha256>     / LINK                      invite/reset link → userId (TTL: expiresAt)
//   USAGE#<yyyy-mm-dd>/ USER#<id>                 AI analyses per user per day
//   USER#<id>         / SESSION#<date>#<id>       speelsessie summary (written by Koersdag)
//   CONFIG            / AI                        AI connection metadata (the token lives in Secrets Manager)

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
})

export function tableName(alias: Alias): string {
  return process.env[`TABLE_${alias.toUpperCase()}`] ?? `kortebaan-${alias}`
}

export type Role = 'owner' | 'friend'
export type UserStatus = 'invited' | 'active' | 'paused'
export type LinkType = 'invite' | 'reset'

export interface UserRecord {
  id: string
  name: string
  username?: string
  role: Role
  status: UserStatus
  passwordHash?: string
  // Max AI analyses per day; null = unlimited (always null for the owner)
  dailyLimit: number | null
  tokenVersion: number
  failedLogins: number
  lockedUntil?: number
  createdAt: string
  lastActiveAt?: string
  // The one currently valid invite/reset link
  linkHash?: string
  linkType?: LinkType
  linkExpiresAt?: number
}

export interface SessionRecord {
  id: string
  date: string
  draverij: string
  staked: number
  paidOut: number
}

export interface AiConfig {
  status: 'connected' | 'error'
  tokenHint: string
  connectedAt: string
  lastTestedAt?: string
  lastError?: string
}

const userKey = (id: string) => ({ pk: 'USERS', sk: `USER#${id}` })
const usernameKey = (username: string) => ({ pk: `USERNAME#${username}`, sk: 'USERNAME' })
const linkKey = (hash: string) => ({ pk: `LINK#${hash}`, sk: 'LINK' })

function strip<T>(item: Record<string, unknown> | undefined): T | undefined {
  if (!item) return undefined
  const { pk: _pk, sk: _sk, ...rest } = item
  return rest as T
}

// ── Users ────────────────────────────────────────────────────────────────

export async function getUser(alias: Alias, id: string): Promise<UserRecord | undefined> {
  const res = await doc.send(new GetCommand({ TableName: tableName(alias), Key: userKey(id) }))
  return strip<UserRecord>(res.Item)
}

export async function getUserByUsername(
  alias: Alias,
  username: string,
): Promise<UserRecord | undefined> {
  const res = await doc.send(
    new GetCommand({ TableName: tableName(alias), Key: usernameKey(username) }),
  )
  const userId = res.Item?.userId
  return typeof userId === 'string' ? getUser(alias, userId) : undefined
}

export async function listUsers(alias: Alias): Promise<UserRecord[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: tableName(alias),
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'USERS' },
    }),
  )
  return (res.Items ?? []).map((item) => strip<UserRecord>(item)!)
}

export async function putUser(alias: Alias, user: UserRecord): Promise<void> {
  await doc.send(new PutCommand({ TableName: tableName(alias), Item: { ...userKey(user.id), ...user } }))
}

export class UsernameTakenError extends Error {}

// Claims the username and saves the user in one transaction, so two friends can't grab the same name
export async function claimUsername(alias: Alias, user: UserRecord): Promise<void> {
  if (!user.username) throw new Error('claimUsername needs a username')
  try {
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName(alias),
              Item: { ...usernameKey(user.username), userId: user.id },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          { Put: { TableName: tableName(alias), Item: { ...userKey(user.id), ...user } } },
        ],
      }),
    )
  } catch (err) {
    if (err instanceof Error && err.name === 'TransactionCanceledException') {
      throw new UsernameTakenError()
    }
    throw err
  }
}

// Removes the user, their username, link and speelsessies
export async function deleteUser(alias: Alias, user: UserRecord): Promise<void> {
  const TableName = tableName(alias)
  const sessions = await doc.send(
    new QueryCommand({
      TableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `USER#${user.id}` },
      ProjectionExpression: 'pk, sk',
    }),
  )
  const keys = [
    userKey(user.id),
    ...(user.username ? [usernameKey(user.username)] : []),
    ...(user.linkHash ? [linkKey(user.linkHash)] : []),
    ...(sessions.Items ?? []).map((item) => ({ pk: item.pk, sk: item.sk })),
  ]
  for (let i = 0; i < keys.length; i += 25) {
    await doc.send(
      new BatchWriteCommand({
        RequestItems: {
          [TableName]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })),
        },
      }),
    )
  }
}

// ── Links ────────────────────────────────────────────────────────────────

// Replaces the user's current link (the old one stops working) and saves the user
export async function setLink(
  alias: Alias,
  user: UserRecord,
  link: { hash: string; type: LinkType; expiresAt: number },
): Promise<UserRecord> {
  const TableName = tableName(alias)
  if (user.linkHash) await doc.send(new DeleteCommand({ TableName, Key: linkKey(user.linkHash) }))
  const updated: UserRecord = {
    ...user,
    linkHash: link.hash,
    linkType: link.type,
    linkExpiresAt: link.expiresAt,
  }
  await doc.send(
    new PutCommand({
      TableName,
      // expiresAt is in seconds so DynamoDB TTL cleans up old links
      Item: { ...linkKey(link.hash), userId: user.id, expiresAt: Math.floor(link.expiresAt / 1000) },
    }),
  )
  await putUser(alias, updated)
  return updated
}

export async function findLinkUser(alias: Alias, hash: string): Promise<UserRecord | undefined> {
  const res = await doc.send(new GetCommand({ TableName: tableName(alias), Key: linkKey(hash) }))
  const userId = res.Item?.userId
  if (typeof userId !== 'string') return undefined
  const user = await getUser(alias, userId)
  return user?.linkHash === hash ? user : undefined
}

export async function clearLink(alias: Alias, user: UserRecord): Promise<UserRecord> {
  if (user.linkHash) {
    await doc.send(new DeleteCommand({ TableName: tableName(alias), Key: linkKey(user.linkHash) }))
  }
  const { linkHash: _h, linkType: _t, linkExpiresAt: _e, ...rest } = user
  return rest
}

// ── Usage ────────────────────────────────────────────────────────────────

// Calendar day in the Netherlands, since that's where the draverijen are
export function dayOf(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(date)
}

// Analyses per user on one day
export async function usageOn(alias: Alias, day: string): Promise<Map<string, number>> {
  const res = await doc.send(
    new QueryCommand({
      TableName: tableName(alias),
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `USAGE#${day}` },
    }),
  )
  return new Map(
    (res.Items ?? []).map((item) => [String(item.sk).replace('USER#', ''), Number(item.count ?? 0)]),
  )
}

// Counts one AI analysis for the user on that day; the item expires after a few weeks
export async function incrementUsage(alias: Alias, day: string, userId: string): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: tableName(alias),
      Key: { pk: `USAGE#${day}`, sk: `USER#${userId}` },
      UpdateExpression: 'ADD #count :one SET expiresAt = if_not_exists(expiresAt, :exp)',
      ExpressionAttributeNames: { '#count': 'count' },
      ExpressionAttributeValues: {
        ':one': 1,
        ':exp': Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60,
      },
    }),
  )
}

// ── Speelsessies ─────────────────────────────────────────────────────────

export async function listSessions(alias: Alias, userId: string): Promise<SessionRecord[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: tableName(alias),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':prefix': 'SESSION#' },
      ScanIndexForward: false,
    }),
  )
  return (res.Items ?? []).map((item) => strip<SessionRecord>(item)!)
}

export async function putSession(alias: Alias, userId: string, session: SessionRecord): Promise<void> {
  await doc.send(
    new PutCommand({
      TableName: tableName(alias),
      Item: { pk: `USER#${userId}`, sk: `SESSION#${session.date}#${session.id}`, ...session },
    }),
  )
}

// ── AI config ────────────────────────────────────────────────────────────

const aiKey = { pk: 'CONFIG', sk: 'AI' }

export async function getAiConfig(alias: Alias): Promise<AiConfig | undefined> {
  const res = await doc.send(new GetCommand({ TableName: tableName(alias), Key: aiKey }))
  return strip<AiConfig>(res.Item)
}

export async function putAiConfig(alias: Alias, config: AiConfig): Promise<void> {
  await doc.send(new PutCommand({ TableName: tableName(alias), Item: { ...aiKey, ...config } }))
}

export async function deleteAiConfig(alias: Alias): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: tableName(alias), Key: aiKey }))
}
