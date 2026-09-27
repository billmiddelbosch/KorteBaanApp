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
