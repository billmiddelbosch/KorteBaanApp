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
// Reads a page whose URL is in the prompt (e.g. ZEturf for loting and quoteringen)
const WEB_FETCH_TOOL = { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 4, max_content_tokens: 40_000 }

export interface ChatImage {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
  // base64, without a data: prefix
  data: string
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
  // Only on user turns: photos sent along for Claude vision
  images?: ChatImage[]
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
  source?: { type: 'base64'; media_type: string; data: string }
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
  const messages: { role: 'user' | 'assistant'; text: string; images: ChatImage[] }[] = []
  for (const turn of turns) {
    const last = messages.at(-1)
    if (last && last.role === turn.role) {
      last.text += `\n\n${turn.text}`
      last.images.push(...(turn.images ?? []))
    } else {
      messages.push({ role: turn.role, text: turn.text, images: [...(turn.images ?? [])] })
    }
  }
  while (messages[0]?.role === 'assistant') messages.shift()
  // Plain text stays a string; photos go first as image blocks, followed by the text
  return messages.map(({ role, text, images }): ApiMessage =>
    images.length && role === 'user'
      ? {
          role,
          content: [
            ...images.map(
              (img): ContentBlock => ({
                type: 'image',
                source: { type: 'base64', media_type: img.mediaType, data: img.data },
              }),
            ),
            { type: 'text', text },
          ],
        }
      : { role, content: text },
  )
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
  // No citations: fall back to the fetched pages and what the searches returned
  if (found.size === 0) {
    for (const block of content) {
      if (block.type === 'web_fetch_tool_result' && block.content && typeof block.content === 'object') {
        const r = block.content as { type?: unknown; url?: unknown; content?: { title?: unknown } }
        if (r.type === 'web_fetch_result') add(r.url, r.content?.title)
      }
    }
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

// One chat turn with web search (and web fetch when asked). Non-streaming; long searches may
// pause the turn, which we continue.
export async function askClaude(
  token: string,
  input: { system: string; turns: ChatTurn[]; timeoutMs: number; webFetch?: boolean },
): Promise<ChatReply> {
  const signal = AbortSignal.timeout(input.timeoutMs)
  const system = [
    { type: 'text', text: OAUTH_SYSTEM_PREFIX },
    { type: 'text', text: input.system },
  ]
  const messages = toApiMessages(input.turns)
  let tools: unknown[] | undefined = input.webFetch ? [WEB_SEARCH_TOOL, WEB_FETCH_TOOL] : [WEB_SEARCH_TOOL]
  const content: ContentBlock[] = []

  for (let round = 0; round <= MAX_CONTINUATIONS; round++) {
    const body = { model: CHAT_MODEL, max_tokens: MAX_TOKENS, system, messages, ...(tools ? { tools } : {}) }
    let res = await post(token, body, signal)
    // If a web tool isn't available for this token, drop web fetch first, then all tools:
    // answering with less is better than not answering
    while (res.status === 400 && tools) {
      const detail = await res.clone().text().catch(() => '')
      if (!/web_search|web_fetch|tool/i.test(detail)) break
      const withoutFetch: unknown[] = tools.filter((t) => t !== WEB_FETCH_TOOL)
      tools = /web_fetch/i.test(detail) && withoutFetch.length < tools.length ? withoutFetch : undefined
      console.warn(tools ? 'Web fetch rejected, retrying with web search only' : 'Web search rejected, retrying without tools')
      const { tools: _t, ...rest } = body
      res = await post(token, tools ? { ...rest, tools } : rest, signal)
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
