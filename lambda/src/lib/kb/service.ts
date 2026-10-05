// Entry point for workers and handlers: everything they need from the kennisbank, per alias.
// Without KB_HOST (tests, local runs) the kennisbank is simply absent; when it is unreachable
// the reading functions return null, so an analysis carries on with web search alone.
import type pg from 'pg'
import { slugify, type Draverij } from '../analysis'
import type { CustomTool, ToolRunner } from '../claude'
import { kbClient } from './db'
import { formatDossier, formatLessons, formatScorecard } from './dossier'
import { ratingIsPredictive, type Backtest } from './glicko'
import { aiTrackRecord, baanHistory, getMeta, lastIngested, lessonsFor, originsFor, seasonLeaders, sideStats, type Env, type LessonRow } from './queries'
import { kbTools, type ToolMode } from './tools'
import * as write from './write'

export type { Kans, LessonInput, LessonVerdict, ListedLesson, Scorecard } from './write'

export const kbConfigured = () => !!process.env.KB_HOST

async function client(): Promise<pg.Client> {
  const host = process.env.KB_HOST
  if (!host) throw new Error('KB_HOST ontbreekt')
  return kbClient({ host, role: 'kb_writer' })
}

// Reading helpers: undefined = no kennisbank configured, null = unreachable or failed
async function read<T>(what: string, fn: (c: pg.Client) => Promise<T>): Promise<T | null | undefined> {
  if (!kbConfigured()) return undefined
  try {
    return await fn(await client())
  } catch (err) {
    console.error(`kennisbank: ${what} mislukt`, err)
    return null
  }
}

export function dossier(alias: Env, draverij: Draverij, today: string): Promise<string | null | undefined> {
  return read('dossier', async (c) => {
    const baanId = slugify(draverij.place)
    const origins = originsFor(alias)
    const year = Number(draverij.date.slice(0, 4))
    const [stand, history, sides, backtest, lessons, trackRecord] = await Promise.all([
      lastIngested(c),
      baanHistory(c, baanId, 11),
      sideStats(c, baanId),
      getMeta<Backtest>(c, 'rating_backtest'),
      lessonsFor(c, [{ kind: 'baan', id: baanId }], origins, 12),
      aiTrackRecord(c, [alias], draverij.id),
    ])
    let leadersYear = year
    let leaders = await seasonLeaders(c, year, 15)
    if (leaders.length < 5) {
      leadersYear = year - 1
      leaders = await seasonLeaders(c, leadersYear, 15)
    }
    return formatDossier({
      stand,
      today,
      place: draverij.place,
      baanName: history.name,
      // The draverij itself is no history (when analysing afterwards)
      editions: history.editions.filter((e) => e.id !== draverij.id).slice(0, 10),
      sides,
      leaders,
      leadersYear,
      lessons,
      backtest,
      ratingsPredictive: ratingIsPredictive(backtest),
      trackRecord,
    })
  })
}

export async function workerTools(
  alias: Env,
  draverij: Draverij,
  mode: ToolMode,
  today: string,
): Promise<{ tools: CustomTool[]; runTool: ToolRunner } | null> {
  const found = await read('tools', async (c) => kbTools({ client: c, env: alias, today, place: draverij.place }, mode))
  return found ?? null
}

// Writing helpers: failures are logged, never fatal for the worker
async function attempt<T>(what: string, fn: (c: pg.Client) => Promise<T>, fallback: T): Promise<T> {
  if (!kbConfigured()) return fallback
  try {
    return await fn(await client())
  } catch (err) {
    console.error(`kennisbank: ${what} mislukt`, err)
    return fallback
  }
}

export const recordKoersdag = (alias: Env, draverijId: string, kansen: write.Kans[], adviesRef: string | null) =>
  attempt('voorspellingen vastleggen', (c) => write.recordPredictions(c, alias, draverijId, kansen, adviesRef), 0)

// Scores what can be scored now (the official result may have come in since) and summarises
export const scorecard = (alias: Env, draverijId: string) =>
  attempt<write.Scorecard | null>(
    'scorekaart',
    async (c) => {
      await write.scorePredictions(c, draverijId)
      return write.scorecard(c, alias, draverijId)
    },
    null,
  )

export const lessonsForCheck = (alias: Env, draverij: Draverij) =>
  attempt<LessonRow[]>('lessen ophalen', (c) => lessonsFor(c, [{ kind: 'baan', id: slugify(draverij.place) }], [alias], 15), [])

// What the terugblik evaluation gets from the kennisbank; one after the other on the shared client
export async function evaluationContext(alias: Env, draverij: Draverij): Promise<{ scorecard: string | null; lessonsToCheck: string[] }> {
  const card = await scorecard(alias, draverij.id)
  const lessons = await lessonsForCheck(alias, draverij)
  return { scorecard: card ? formatScorecard(card) : null, lessonsToCheck: formatLessons(lessons) }
}

export const saveLessons = (alias: Env, lessons: write.LessonInput[], draverijId: string) =>
  attempt('lessen opslaan', (c) => write.saveLessons(c, alias, lessons, draverijId), [] as string[])

export const checkLessons = (alias: Env, verdicts: write.LessonVerdict[], today: string) =>
  attempt('lessen toetsen', (c) => write.checkLessons(c, alias, verdicts, today), 0)

// Terugblik API: errors propagate so the handler can answer 500
export async function listLessons(alias: Env, limit: number): Promise<write.ListedLesson[]> {
  if (!kbConfigured()) return []
  return write.listLessons(await client(), alias, limit)
}

export async function removeLesson(alias: Env, id: string): Promise<boolean> {
  if (!kbConfigured()) return false
  return write.removeLesson(await client(), alias, id)
}

export async function promoteLesson(id: string): Promise<boolean> {
  if (!kbConfigured()) return false
  return write.promoteLesson(await client(), id)
}
