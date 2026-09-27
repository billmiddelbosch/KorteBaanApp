import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager'
import type { Alias } from './http'

const client = new SecretsManagerClient({})

// Secret ARNs per alias come from env vars set in infra/lib/api-stack.ts
function secretArn(kind: 'JWT' | 'CLAUDE', alias: Alias): string {
  const arn = process.env[`${kind}_SECRET_ARN_${alias.toUpperCase()}`]
  if (!arn) throw new Error(`${kind}_SECRET_ARN_${alias.toUpperCase()} is not set`)
  return arn
}

// The JWT signing secret never changes during a Lambda's lifetime, so cache it per alias
const jwtCache = new Map<Alias, string>()

export async function jwtSecret(alias: Alias): Promise<string> {
  const cached = jwtCache.get(alias)
  if (cached) return cached
  const res = await client.send(new GetSecretValueCommand({ SecretId: secretArn('JWT', alias) }))
  if (!res.SecretString) throw new Error('JWT secret is empty')
  jwtCache.set(alias, res.SecretString)
  return res.SecretString
}

// The Claude setup-token is stored as {"token": string | null}
export async function readClaudeToken(alias: Alias): Promise<string | null> {
  const res = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn('CLAUDE', alias) }),
  )
  try {
    const value = JSON.parse(res.SecretString ?? '{}') as { token?: unknown }
    return typeof value.token === 'string' && value.token ? value.token : null
  } catch {
    return null
  }
}

export async function writeClaudeToken(alias: Alias, token: string | null): Promise<void> {
  await client.send(
    new PutSecretValueCommand({
      SecretId: secretArn('CLAUDE', alias),
      SecretString: JSON.stringify({ token }),
    }),
  )
}
