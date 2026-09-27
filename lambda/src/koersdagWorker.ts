import { randomUUID } from 'node:crypto'
import type { Context } from 'aws-lambda'
import { DEFAULT_INSTRUCTION } from './lib/analysis'
import { getAdvice, getInstruction } from './lib/analysisStore'
import { askClaude, ClaudeError, type ChatImage } from './lib/claude'
import { aliasOf, type Alias } from './lib/http'
import {
  buildKoersdagPrompt,
  parseUpdate,
  UNREADABLE_ERROR,
  type KoersdagRecord,
  type KoersdagUpdate,
} from './lib/koersdag'
import { getKoersdag, KoersdagChangedError, putKoersdag } from './lib/koersdagStore'
import { deletePhoto, readPhoto } from './lib/photos'
import { readClaudeToken } from './lib/secrets'
import { dayOf, getAiConfig, putAiConfig } from './lib/store'
import type { WorkerJob } from './lib/worker'

// Leave room within the Lambda timeout (5 min) to save the result
const CLAUDE_TIMEOUT_MS = 4 * 60 * 1000

type Outcome = { update: KoersdagUpdate } | { error: string }

// The user may place bets while the AI works, so merge into the latest version instead of
// overwriting it. Drops the result when the koersdag moved on (finished, new run).
async function save(alias: Alias, job: WorkerJob, outcome: Outcome) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await getKoersdag(alias, job.userId, job.draverijId)
    if (!latest || latest.status !== 'thinking' || latest.thinkingSince !== job.thinkingSince) return
    const next: KoersdagRecord = {
      ...latest,
      photoKey: undefined,
      photoMediaType: undefined,
      updatedAt: new Date(Math.max(Date.now(), Date.parse(latest.updatedAt) + 1)).toISOString(),
      ...('update' in outcome
        ? { status: 'idle', error: undefined, updates: [...latest.updates, outcome.update] }
        : { status: 'error', error: outcome.error }),
    }
    try {
      await putKoersdag(alias, next, { expectUpdatedAt: latest.updatedAt })
      return
    } catch (err) {
      if (!(err instanceof KoersdagChangedError)) throw err
    }
  }
  console.error('Could not save koersdag update after 3 attempts')
}

async function markAuthProblem(alias: Alias, message: string) {
  const config = await getAiConfig(alias)
  if (config) await putAiConfig(alias, { ...config, status: 'error', lastError: message })
}

async function run(alias: Alias, job: WorkerJob, record: KoersdagRecord): Promise<Outcome> {
  const kind = record.step ?? 'fetch'
  const token = await readClaudeToken(alias)
  if (!token) return { error: 'De AI is nog niet gekoppeld. Vraag de eigenaar om de AI-koppeling in te stellen.' }

  const [instruction, advice] = await Promise.all([
    getInstruction(alias),
    getAdvice(alias, record.userId, record.draverij.id),
  ])
  const images: ChatImage[] = []
  if (kind === 'photo') {
    if (!record.photoKey) return { error: 'De foto is niet aangekomen. Maak de foto opnieuw.' }
    images.push({ mediaType: (record.photoMediaType ?? 'image/jpeg') as ChatImage['mediaType'], data: await readPhoto(alias, record.photoKey) })
  }

  const { system, text } = buildKoersdagPrompt({
    instruction: instruction?.text ?? DEFAULT_INSTRUCTION,
    record,
    advice,
    today: dayOf(),
    kind,
  })
  const reply = await askClaude(token, { system, turns: [{ role: 'user', text, images }], timeoutMs: CLAUDE_TIMEOUT_MS })

  const update = parseUpdate(reply.text, {
    id: `u-${randomUUID()}`,
    omloop: record.omloop,
    kind,
    createdAt: new Date().toISOString(),
    sources: reply.sources,
    hadAdvice: !!advice || record.updates.length > 0,
    newId: () => `s-${randomUUID()}`,
  })
  if (!update) {
    console.error('Unparseable koersdag reply', reply.text.slice(0, 1000))
    return { error: UNREADABLE_ERROR }
  }
  return { update }
}

// Runs one koersdag update (online check or photo check), invoked asynchronously by the
// koersdag API. Never throws: a failed async invoke would be retried and answer twice.
export async function handler(job: WorkerJob, context: Context): Promise<void> {
  const alias = aliasOf(context)
  const record = await getKoersdag(alias, job.userId, job.draverijId).catch(() => undefined)
  if (!record || record.status !== 'thinking' || record.thinkingSince !== job.thinkingSince) return

  let outcome: Outcome
  try {
    outcome = await run(alias, job, record)
  } catch (err) {
    console.error(err)
    if (err instanceof ClaudeError) {
      if (err.kind === 'auth') await markAuthProblem(alias, err.message).catch(console.error)
      outcome = { error: err.message }
    } else {
      outcome = { error: 'Er ging iets mis bij de AI. Probeer het opnieuw.' }
    }
  }

  if (record.photoKey) await deletePhoto(alias, record.photoKey).catch(console.error)
  await save(alias, job, outcome).catch(console.error)
}
