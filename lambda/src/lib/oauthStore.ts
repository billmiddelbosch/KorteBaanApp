import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import type { Alias } from './http'
import { tableName } from './store'

// OAuth items in the single table (TTL: expiresAt, in seconds). Codes and tokens are random;
// only their SHA-256 is stored.
//   OAUTH#CLIENT#<clientId> / CLIENT    dynamically registered client (Claude Code, claude.ai)
//   OAUTH#CODE#<sha256>     / CODE      authorization code, single use
//   OAUTH#TOKEN#<sha256>    / ACCESS    access token for the MCP server
//   OAUTH#TOKEN#<sha256>    / REFRESH   refresh token, rotated on every use

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
})

export interface OAuthClient {
  clientId: string
  name: string
  redirectUris: string[]
  createdAt: string
  expiresAt: number
}

export interface OAuthGrant {
  userId: string
  clientId: string
  scopes: string[]
  // The user's tokenVersion at approval: a password change revokes the grant
  tokenVersion: number
}

export interface OAuthCode extends OAuthGrant {
  redirectUri: string
  codeChallenge: string
  expiresAt: number
}

export type TokenKind = 'ACCESS' | 'REFRESH'

export interface OAuthToken extends OAuthGrant {
  expiresAt: number
}

const clientKey = (id: string) => ({ pk: `OAUTH#CLIENT#${id}`, sk: 'CLIENT' })
const codeKey = (hash: string) => ({ pk: `OAUTH#CODE#${hash}`, sk: 'CODE' })
const tokenKey = (hash: string, kind: TokenKind) => ({ pk: `OAUTH#TOKEN#${hash}`, sk: kind })

function strip<T>(item: Record<string, unknown> | undefined): T | undefined {
  if (!item) return undefined
  const { pk: _pk, sk: _sk, ...rest } = item
  return rest as T
}

// TTL deletes lazily, so every read also checks the expiry itself
const live = <T extends { expiresAt: number }>(item: T | undefined): T | undefined =>
  item && item.expiresAt > Date.now() / 1000 ? item : undefined

export async function putClient(alias: Alias, client: OAuthClient): Promise<void> {
  await doc.send(new PutCommand({ TableName: tableName(alias), Item: { ...clientKey(client.clientId), ...client } }))
}

export async function getClient(alias: Alias, clientId: string): Promise<OAuthClient | undefined> {
  const res = await doc.send(new GetCommand({ TableName: tableName(alias), Key: clientKey(clientId) }))
  return live(strip<OAuthClient>(res.Item))
}

export async function putCode(alias: Alias, hash: string, code: OAuthCode): Promise<void> {
  await doc.send(new PutCommand({ TableName: tableName(alias), Item: { ...codeKey(hash), ...code } }))
}

// Deletes and returns in one call, so a code can be redeemed only once
export async function takeCode(alias: Alias, hash: string): Promise<OAuthCode | undefined> {
  const res = await doc.send(new DeleteCommand({ TableName: tableName(alias), Key: codeKey(hash), ReturnValues: 'ALL_OLD' }))
  return live(strip<OAuthCode>(res.Attributes))
}

export async function putToken(alias: Alias, hash: string, kind: TokenKind, token: OAuthToken): Promise<void> {
  await doc.send(new PutCommand({ TableName: tableName(alias), Item: { ...tokenKey(hash, kind), ...token } }))
}

export async function getToken(alias: Alias, hash: string, kind: TokenKind): Promise<OAuthToken | undefined> {
  const res = await doc.send(new GetCommand({ TableName: tableName(alias), Key: tokenKey(hash, kind) }))
  return live(strip<OAuthToken>(res.Item))
}

export async function takeToken(alias: Alias, hash: string, kind: TokenKind): Promise<OAuthToken | undefined> {
  const res = await doc.send(new DeleteCommand({ TableName: tableName(alias), Key: tokenKey(hash, kind), ReturnValues: 'ALL_OLD' }))
  return live(strip<OAuthToken>(res.Attributes))
}
