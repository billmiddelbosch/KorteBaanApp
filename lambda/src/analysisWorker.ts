import { randomUUID } from 'node:crypto'
import type { Context } from 'aws-lambda'
import {
  DEFAULT_INSTRUCTION,
  MAX_REPLY_CHARS,
  buildSystemPrompt,
  parseReply,
  type ChatRecord,
} from './lib/analysis'
import { ChatChangedError, getChat, getInstruction, listFacts, listLessons, putChat, saveKnowledge } from './lib/analysisStore'
import { askClaude, ClaudeError } from './lib/claude'
import { sha256 } from './lib/crypto'
import { aliasOf, type Alias } from './lib/http'
import { readClaudeToken } from './lib/secrets'
import { dayOf, getAiConfig, putAiConfig } from './lib/store'
import type { WorkerJob } from './lib/worker'

// Leave room within the Lambda timeout (5 min) to save the result
const CLAUDE_TIMEOUT_MS = 4 * 60 * 1000
const KB_FACTS_IN_PROMPT = 40
const KB_LESSONS_IN_PROMPT = 20

async function save(alias: Alias, job: WorkerJob, chat: ChatRecord) {
  try {
    await putChat(alias, chat, { expectThinkingSince: job.thinkingSince })
  } catch (err) {
    // The user restarted the chat meanwhile; this reply is no longer wanted
    if (err instanceof ChatChangedError) return
    throw err
  }
}

async function markAuthProblem(alias: Alias, message: string) {
  const config = await getAiConfig(alias)
  if (config) await putAiConfig(alias, { ...config, status: 'error', lastError: message })
}

// Runs one AI turn for a chat, invoked asynchronously by the analysis API. Never throws:
// a failed async invoke would be retried and answer twice.
export async function handler(job: WorkerJob, context: Context): Promise<void> {
  const alias = aliasOf(context)
  const chat = await getChat(alias, job.userId, job.draverijId).catch(() => undefined)
  if (!chat || chat.status !== 'thinking' || chat.thinkingSince !== job.thinkingSince) return

  const fail = (error: string) =>
    save(alias, job, { ...chat, status: 'error', error, updatedAt: new Date().toISOString() })

  try {
    const token = await readClaudeToken(alias)
    if (!token) {
      await fail('De AI is nog niet gekoppeld. Vraag de eigenaar om de AI-koppeling in te stellen.')
      return
    }
    const [instruction, facts, lessons] = await Promise.all([
      getInstruction(alias),
      listFacts(alias, KB_FACTS_IN_PROMPT),
      listLessons(alias, KB_LESSONS_IN_PROMPT),
    ])
    const system = buildSystemPrompt({
      instruction: instruction?.text ?? DEFAULT_INSTRUCTION,
      draverij: chat.draverij,
      today: dayOf(),
      facts,
      lessons,
    })

    const reply = await askClaude(token, {
      system,
      turns: chat.messages.map((m) => ({ role: m.role, text: m.text })),
      timeoutMs: CLAUDE_TIMEOUT_MS,
    })

    const now = new Date().toISOString()
    await save(alias, job, {
      ...chat,
      status: 'idle',
      error: undefined,
      thinkingSince: job.thinkingSince,
      messages: [
        ...chat.messages,
        {
          id: `m-${randomUUID()}`,
          role: 'assistant',
          text: reply.text.slice(0, MAX_REPLY_CHARS),
          sources: reply.sources,
          createdAt: now,
        },
      ],
      updatedAt: now,
    })

    // Kennisbank: facts and sources are shared by everyone; failing here shouldn't lose the reply
    const { facts: newFacts } = parseReply(reply.text)
    await saveKnowledge(
      alias,
      newFacts.map((text) => ({ id: randomUUID(), text, draverijId: chat.draverij.id, createdAt: now })),
      reply.sources.map((s) => ({ ...s, hash: sha256(s.url), lastSeenAt: now, draverijId: chat.draverij.id })),
    ).catch((err) => console.error('Saving knowledge failed', err))
  } catch (err) {
    console.error(err)
    if (err instanceof ClaudeError) {
      if (err.kind === 'auth') await markAuthProblem(alias, err.message).catch(console.error)
      await fail(err.message).catch(console.error)
      return
    }
    await fail('Er ging iets mis bij de AI. Probeer het opnieuw.').catch(console.error)
  }
}
