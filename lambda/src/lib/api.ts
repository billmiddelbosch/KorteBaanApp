import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda'
import { aliasOf, requestOriginOf, respond, type Alias } from './http'

// Thrown by routes to answer with a status code and a user-facing (Dutch) message
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface RouteRequest {
  event: APIGatewayProxyEvent
  alias: Alias
  params: Record<string, string>
  body: Record<string, unknown>
}

export type RouteResult = { status: number; body: unknown }
export type Route = (req: RouteRequest) => Promise<RouteResult>

function parseBody(event: APIGatewayProxyEvent): Record<string, unknown> {
  if (!event.body) return {}
  try {
    const parsed: unknown = JSON.parse(event.body)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    throw new HttpError(400, 'Het verzoek kon niet gelezen worden.')
  }
}

// One Lambda serves several routes, keyed by `${httpMethod} ${resource}` (e.g. `PATCH /friends/{id}`)
export function createHandler(routes: Record<string, Route>) {
  return async (event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> => {
    const alias = aliasOf(context)
    const requestOrigin = requestOriginOf(event)
    try {
      const route = routes[`${event.httpMethod} ${event.resource}`]
      if (!route) throw new HttpError(404, 'Niet gevonden')
      const params = Object.fromEntries(
        Object.entries(event.pathParameters ?? {}).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      )
      const result = await route({ event, alias, params, body: parseBody(event) })
      return respond(result.status, result.body, alias, requestOrigin)
    } catch (err) {
      if (err instanceof HttpError) {
        return respond(err.status, { message: err.message }, alias, requestOrigin)
      }
      console.error(err)
      return respond(
        500,
        { message: 'Er ging iets mis aan onze kant. Probeer het zo opnieuw.' },
        alias,
        requestOrigin,
      )
    }
  }
}

export const ok = (body: unknown, status = 200): RouteResult => ({ status, body })

// Small body readers that turn bad input into a 400 with a clear message
export function readString(
  body: Record<string, unknown>,
  key: string,
  message: string,
): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, message)
  return value.trim()
}
