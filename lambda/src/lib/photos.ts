import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { Alias } from './http'

// Koersdag photos live only until the worker has checked them (bucket lifecycle: 1 day as backstop).
// They go via S3 because an async Lambda invoke (256 KB) and a DynamoDB item (400 KB) are too small.
const client = new S3Client({})

function bucket(alias: Alias): string {
  const name = alias === 'prod' ? process.env.PHOTO_BUCKET_PROD : process.env.PHOTO_BUCKET_DEV
  if (!name) throw new Error(`PHOTO_BUCKET_${alias.toUpperCase()} is not set`)
  return name
}

export async function putPhoto(alias: Alias, key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  await client.send(new PutObjectCommand({ Bucket: bucket(alias), Key: key, Body: bytes, ContentType: contentType }))
}

// Returns base64 for Claude vision
export async function readPhoto(alias: Alias, key: string): Promise<string> {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket(alias), Key: key }))
  if (!res.Body) throw new Error(`Photo ${key} is empty`)
  return Buffer.from(await res.Body.transformToByteArray()).toString('base64')
}

export async function deletePhoto(alias: Alias, key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: bucket(alias), Key: key }))
}
