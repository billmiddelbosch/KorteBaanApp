import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda'

// Allowed browser origins per Lambda alias.
// Keep in sync with the API Gateway preflight list in infra/lib/config.ts (ALLOWED_ORIGINS).
const PROD_ORIGINS = new Set(['https://kortebaan.nl', 'https://www.kortebaan.nl'])
const DEV_ORIGINS = new Set(['https://test.kortebaan.nl', 'http://localhost:5173'])

export type Alias = 'dev' | 'prod'

// Each Lambda has `dev` and `prod` aliases; API Gateway stage variables route each stage to one.
export function aliasOf(context: Context): Alias {
  return context.invokedFunctionArn.split(':').pop() === 'prod' ? 'prod' : 'dev'
}

export function requestOriginOf(event: APIGatewayProxyEvent): string | undefined {
  return event.headers?.['origin'] ?? event.headers?.['Origin']
}

// Echo the request origin when it is allowed for this alias, otherwise fall back to the primary site
export function corsOrigin(alias: Alias, requestOrigin?: string): string {
  if (alias === 'prod') {
    if (requestOrigin && PROD_ORIGINS.has(requestOrigin)) return requestOrigin
    return 'https://kortebaan.nl'
  }
  if (requestOrigin && DEV_ORIGINS.has(requestOrigin)) return requestOrigin
  return 'https://test.kortebaan.nl'
}

export function respond(
  statusCode: number,
  body: unknown,
  alias: Alias,
  requestOrigin?: string,
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': corsOrigin(alias, requestOrigin),
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      Vary: 'Origin',
    },
    body: JSON.stringify(body),
  }
}
