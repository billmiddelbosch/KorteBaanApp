import type { Context } from 'aws-lambda'
import { DEFAULT_INSTRUCTION, type Source } from './lib/analysis'
import { getAdvice, getInstruction } from './lib/analysisStore'
import { askClaude, ClaudeError, type ChatImage } from './lib/claude'
import { aliasOf, type Alias } from './lib/http'
import * as kb from './lib/kb/service'
import { totals, UNREADABLE_ERROR, type KoersdagRecord } from './lib/koersdag'
import { getKoersdag, KoersdagChangedError, putKoersdag } from './lib/koersdagStore'
import { deletePhoto, readPhoto } from './lib/photos'
import { readClaudeToken } from './lib/secrets'
import { dayOf, getAiConfig, putAiConfig, putSession } from './lib/store'
import {
  buildEvaluationPrompt,
  buildResultsPrompt,
  parseEvaluation,
  parseResults,
  RESULTS_NOT_FOUND,
  type Evaluation,
  type LessonCheck,
  type OmloopResult,
  type ParsedLesson,
} from './lib/terugblik'
import type { WorkerJob } from './lib/worker'

// Leave room within the Lambda timeout (5 min) to save the result
const CLAUDE_TIMEOUT_MS = 4 * 60 * 1000

type Outcome =
  | { results: OmloopResult[]; sources: Source[] }
  | { evaluation: Evaluation; lessons: ParsedLesson[]; checks: LessonCheck[] }
  | { error: string }

// Merges into the latest version (the user may correct bets meanwhile); drops the result
// when a newer run started. Returns the saved record.
async function save(alias: Alias, job: WorkerJob, outcome: Outcome): Promise<KoersdagRecord | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await getKoersdag(alias, job.userId, job.draverijId)
    const review = latest?.review
    if (!latest || !review || review.status !== 'thinking' || review.thinkingSince !== job.thinkingSince) return
    const base = { ...review, photoKey: undefined, photoMediaType: undefined }
    const next: KoersdagRecord = {
      ...latest,
      updatedAt: new Date(Math.max(Date.now(), Date.parse(latest.updatedAt) + 1)).toISOString(),
      review:
        'results' in outcome
          ? // A fresh draft for the user to check and confirm
            { ...base, status: 'idle', error: undefined, results: outcome.results, resultsSources: outcome.sources }
          : 'evaluation' in outcome
            ? { ...base, status: 'idle', error: undefined, evaluation: outcome.evaluation }
            : { ...base, status: 'error', error: outcome.error },
    }
    try {
      await putKoersdag(alias, next, { expectUpdatedAt: latest.updatedAt })
      return next
    } catch (err) {
      if (!(err instanceof KoersdagChangedError)) throw err
    }
  }
  console.error('Could not save terugblik result after 3 attempts')
}

async function markAuthProblem(alias: Alias, message: string) {
  const config = await getAiConfig(alias)
  if (config) await putAiConfig(alias, { ...config, status: 'error', lastError: message })
}

async function run(alias: Alias, record: KoersdagRecord): Promise<Outcome> {
  const review = record.review!
  const step = review.step ?? 'results'
  const token = await readClaudeToken(alias)
  if (!token) return { error: 'De AI is nog niet gekoppeld. Vraag de eigenaar om de AI-koppeling in te stellen.' }
  const instruction = (await getInstruction(alias))?.text ?? DEFAULT_INSTRUCTION

  if (step === 'evaluate') {
    if (!review.results?.length) return { error: 'Bevestig eerst de uitslagen.' }
    const [advice, kennisbank] = await Promise.all([
      getAdvice(alias, record.userId, record.draverij.id),
      kb.evaluationContext(alias, record.draverij),
    ])
    const { system, text } = buildEvaluationPrompt({ instruction, record, advice, results: review.results, ...kennisbank })
    const reply = await askClaude(token, { system, turns: [{ role: 'user', text }], timeoutMs: CLAUDE_TIMEOUT_MS })
    const parsed = parseEvaluation(reply.text, new Date().toISOString())
    if (!parsed) {
      console.error('Unparseable evaluation reply', reply.text.slice(0, 1000))
      return { error: UNREADABLE_ERROR }
    }
    return parsed
  }

  const images: ChatImage[] = []
  if (step === 'photo') {
    if (!review.photoKey) return { error: 'De foto is niet aangekomen. Maak de foto opnieuw.' }
    images.push({
      mediaType: (review.photoMediaType ?? 'image/jpeg') as ChatImage['mediaType'],
      data: await readPhoto(alias, review.photoKey),
    })
  }
  const { system, text } = buildResultsPrompt({ instruction, record, kind: step })
  const reply = await askClaude(token, { system, turns: [{ role: 'user', text, images }], timeoutMs: CLAUDE_TIMEOUT_MS })
  const results = parseResults(reply.text)
  if (results === null) {
    console.error('Unparseable results reply', reply.text.slice(0, 1000))
    return { error: UNREADABLE_ERROR }
  }
  if (!results.length) return { error: RESULTS_NOT_FOUND }
  return { results, sources: reply.sources }
}

// Runs one Terugblik step (uitslagen ophalen, foto lezen or evalueren), invoked asynchronously by
// the terugblik API. Never throws: a failed async invoke would be retried and answer twice.
export async function handler(job: WorkerJob, context: Context): Promise<void> {
  const alias = aliasOf(context)
  const record = await getKoersdag(alias, job.userId, job.draverijId).catch(() => undefined)
  const review = record?.review
  if (!record || !review || review.status !== 'thinking' || review.thinkingSince !== job.thinkingSince) return

  let outcome: Outcome
  try {
    outcome = await run(alias, record)
  } catch (err) {
    console.error(err)
    if (err instanceof ClaudeError) {
      if (err.kind === 'auth') await markAuthProblem(alias, err.message).catch(console.error)
      outcome = { error: err.message }
    } else {
      outcome = { error: 'Er ging iets mis bij de AI. Probeer het opnieuw.' }
    }
  }

  if (review.photoKey) await deletePhoto(alias, review.photoKey).catch(console.error)
  const saved = await save(alias, job, outcome).catch((err) => {
    console.error(err)
    return undefined
  })
  if (!saved || !('evaluation' in outcome)) return

  // The list shows "geëvalueerd"; lessons go to the kennisbank, invisible to the player
  const { staked, paidOut } = totals(saved)
  await putSession(alias, saved.userId, {
    id: saved.draverij.id,
    date: saved.draverij.date,
    draverij: saved.draverij.place,
    staked,
    paidOut,
    evaluated: true,
  }).catch(console.error)
  // Lessons about this kortebaan unless the AI named another; failures are logged by the service
  const lessons = outcome.lessons.map((l) => ({ ...l, baan: l.baan ?? saved.draverij.place }))
  await kb.checkLessons(alias, outcome.checks, dayOf())
  await kb.saveLessons(alias, lessons, saved.draverij.id)
}
