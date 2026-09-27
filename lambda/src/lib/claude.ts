// Checks a Claude setup-token (OAuth token from `claude setup-token`) with a 1-token request
export type TokenCheck = { ok: true } | { ok: false; message: string }

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const TEST_MODEL = 'claude-haiku-4-5-20251001'

export function looksLikeSetupToken(token: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(token)
}

export async function testClaudeToken(token: string): Promise<TokenCheck> {
  let res: Response
  try {
    res = await fetch(MESSAGES_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      body: JSON.stringify({
        model: TEST_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    return { ok: false, message: 'Claude reageerde niet op tijd. Probeer het zo opnieuw.' }
  }

  if (res.ok) return { ok: true }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      message: 'Claude accepteert dit token niet. Maak een nieuw token met `claude setup-token`.',
    }
  }
  if (res.status === 429) {
    return {
      ok: false,
      message: 'Je abonnementslimiet is bereikt. Probeer het later opnieuw.',
    }
  }
  return {
    ok: false,
    message: `Claude gaf een onverwachte fout (${res.status}). Probeer het zo opnieuw.`,
  }
}

export const tokenHint = (token: string) => `…${token.slice(-4)}`

// ── Analyse chat ─────────────────────────────────────────────────────────

export const CHAT_MODEL = 'claude-sonnet-5'
const MAX_TOKENS = 4096
const MAX_CONTINUATIONS = 3
// Subscription (OAuth) tokens are issued for Claude Code; requests identify as such
const OAUTH_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface ChatReply {
  text: string
  sources: { url: string; title: string }[]
}

export type ClaudeErrorKind = 'auth' | 'limit' | 'unavailable' | 'other'

export class ClaudeError extends Error {
  constructor(
    public kind: ClaudeErrorKind,
    message: string,
  ) {
    super(message)
  }
}

interface ContentBlock {
  type: string
  text?: string
  citations?: { url?: string; title?: string }[] | null
  content?: unknown
}

interface MessagesResponse {
  content: ContentBlock[]
  stop_reason: string | null
}

type ApiMessage = { role: 'user' | 'assistant'; content: string | ContentBlock[] }

// The API needs alternating roles starting with the user; a failed turn can leave two user
// messages in a row, so merge those
export function toApiMessages(turns: ChatTurn[]): ApiMessage[] {
  const messages: { role: 'user' | 'assistant'; content: string }[] = []
  for (const turn of turns) {
    const last = messages.at(-1)
    if (last && last.role === turn.role) last.content += `\n\n${turn.text}`
    else messages.push({ role: turn.role, content: turn.text })
  }
  while (messages[0]?.role === 'assistant') messages.shift()
  return messages
}

export function sourcesOf(content: ContentBlock[]): { url: string; title: string }[] {
  const found = new Map<string, string>()
  const add = (url: unknown, title: unknown) => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url) || found.has(url)) return
    found.set(url, typeof title === 'string' && title.trim() ? title.trim() : new URL(url).hostname)
  }
  for (const block of content) {
    for (const c of block.citations ?? []) add(c.url, c.title)
  }
  // No citations: fall back to what the searches returned
  if (found.size === 0) {
    for (const block of content) {
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content as { url?: unknown; title?: unknown }[]) add(r.url, r.title)
      }
    }
  }
  return [...found].slice(0, 10).map(([url, title]) => ({ url, title }))
}

async function post(token: string, body: unknown, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(MESSAGES_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch {
    throw new ClaudeError('unavailable', 'Claude reageerde niet op tijd. Probeer het opnieuw.')
  }
}

async function errorFor(res: Response): Promise<ClaudeError> {
  const detail = await res.text().catch(() => '')
  console.error(`Claude ${res.status}: ${detail.slice(0, 500)}`)
  if (res.status === 401 || res.status === 403) {
    return new ClaudeError('auth', 'Claude accepteert het token niet meer. De eigenaar moet de AI-koppeling vernieuwen.')
  }
  if (res.status === 429) {
    return new ClaudeError('limit', 'De abonnementslimiet van Claude is bereikt. Probeer het later opnieuw.')
  }
  if (res.status === 529 || res.status >= 500) {
    return new ClaudeError('unavailable', 'Claude is even overbelast. Probeer het zo opnieuw.')
  }
  return new ClaudeError('other', `Claude gaf een onverwachte fout (${res.status}). Probeer het opnieuw.`)
}

// One chat turn with web search. Non-streaming; long searches may pause the turn, which we continue.
export async function askClaude(
  token: string,
  input: { system: string; turns: ChatTurn[]; timeoutMs: number },
): Promise<ChatReply> {
  const signal = AbortSignal.timeout(input.timeoutMs)
  const system = [
    { type: 'text', text: OAUTH_SYSTEM_PREFIX },
    { type: 'text', text: input.system },
  ]
  const messages = toApiMessages(input.turns)
  let tools: unknown[] | undefined = [WEB_SEARCH_TOOL]
  const content: ContentBlock[] = []

  for (let round = 0; round <= MAX_CONTINUATIONS; round++) {
    const body = { model: CHAT_MODEL, max_tokens: MAX_TOKENS, system, messages, ...(tools ? { tools } : {}) }
    let res = await post(token, body, signal)
    // If web search isn't available for this token, answer without it rather than not at all
    if (res.status === 400 && tools) {
      const detail = await res.clone().text().catch(() => '')
      if (/web_search|tool/i.test(detail)) {
        console.warn('Web search rejected, retrying without tools')
        tools = undefined
        const { tools: _t, ...withoutTools } = body
        res = await post(token, withoutTools, signal)
      }
    }
    if (!res.ok) throw await errorFor(res)

    const data = (await res.json()) as MessagesResponse
    content.push(...data.content)
    if (data.stop_reason !== 'pause_turn') break
    messages.push({ role: 'assistant', content: data.content })
  }

  const text = content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
  if (!text) throw new ClaudeError('other', 'Claude gaf een leeg antwoord. Probeer het opnieuw.')
  return { text, sources: sourcesOf(content) }
}
