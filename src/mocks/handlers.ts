import { http, HttpResponse, delay } from 'msw'
import { userForToken } from './data'

const BASE = '/api'
const LAG = 300 // simulated network delay in ms

// Resolve the logged-in user from the Authorization header
function resolveUser(request: Request) {
  const token = (request.headers.get('Authorization') ?? '').replace('Bearer ', '')
  return userForToken(token) ?? null
}

export const handlers = [
  http.get(`${BASE}/health`, async () => {
    await delay(LAG)
    return HttpResponse.json({ status: 'ok' })
  }),

  http.get(`${BASE}/me`, async ({ request }) => {
    await delay(LAG)
    const user = resolveUser(request)
    if (!user) return HttpResponse.json({ message: 'Niet ingelogd' }, { status: 401 })
    return HttpResponse.json(user)
  }),
]
