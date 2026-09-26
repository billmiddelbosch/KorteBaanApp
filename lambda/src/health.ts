import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda'
import { aliasOf, requestOriginOf, respond } from './lib/http'

// GET /health — smoke-test endpoint used after each deploy
export async function handler(
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> {
  const alias = aliasOf(context)
  const requestOrigin = requestOriginOf(event)
  return respond(200, { status: 'ok', env: alias }, alias, requestOrigin)
}
