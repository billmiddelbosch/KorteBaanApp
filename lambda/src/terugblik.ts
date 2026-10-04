import { randomUUID } from 'node:crypto'
import { claimAiRun, nextThinkingSince } from './lib/aiAccess'
import { DRAVERIJ_ID_RE } from './lib/analysis'
import * as kb from './lib/kb/service'
import { createHandler, HttpError, ok, readString, type RouteRequest } from './lib/api'
import { MAX_BUDGET, MAX_PHOTO_BASE64, PHOTO_TYPES, sniffImage, totals, type KoersdagRecord } from './lib/koersdag'
import { getKoersdag, KoersdagChangedError, putKoersdag } from './lib/koersdagStore'
import { deletePhoto, putPhoto } from './lib/photos'
import { authenticate, requireOwner } from './lib/session'
import { listSessions, listUsers, putSession, type SessionRecord, type UserRecord } from './lib/store'
import {
  effectiveReviewStatus,
  emptyReview,
  readResults,
  toTerugblikView,
  type Review,
  type ReviewStep,
} from './lib/terugblik'
import { startWorker } from './lib/worker'

const WORKER_ENV = 'TERUGBLIK_WORKER_NAME'
const MAX_LESSONS_LISTED = 500

const NOT_FOUND = 'Deze koersdag bestaat niet (meer).'
const BUSY = 'De AI is nog bezig. Wacht even.'

async function load(req: RouteRequest, user: UserRecord): Promise<KoersdagRecord> {
  const id = req.params.id ?? ''
  const record = DRAVERIJ_ID_RE.test(id) ? await getKoersdag(req.alias, user.id, id) : undefined
  if (!record) throw new HttpError(404, NOT_FOUND)
  if (!record.finishedAt) throw new HttpError(409, 'Rond eerst de koersdag af.')
  return record
}

const reviewOf = (record: KoersdagRecord): Review => record.review ?? emptyReview()

function assertIdle(review: Review) {
  if (effectiveReviewStatus(review).status === 'thinking') throw new HttpError(409, BUSY)
}

// Same optimistic locking as Koersdag; the worker may save in between
async function mutate(
  req: RouteRequest,
  user: UserRecord,
  change: (record: KoersdagRecord) => KoersdagRecord | Promise<KoersdagRecord>,
): Promise<KoersdagRecord> {
  for (let attempt = 0; ; attempt++) {
    const current = await load(req, user)
    const next = await change(structuredClone(current))
    next.updatedAt = new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString()
    try {
      await putKoersdag(req.alias, next, { expectUpdatedAt: current.updatedAt })
      return next
    } catch (err) {
      if (err instanceof KoersdagChangedError && attempt < 2) continue
      if (err instanceof KoersdagChangedError) {
        throw new HttpError(409, 'Er veranderde net iets aan deze koersdag. Probeer het opnieuw.')
      }
      throw err
    }
  }
}

// Keeps the speelsessie (Historie, Terugblik list, owner overview) in step with the koersdag
async function writeSession(req: RouteRequest, userId: string, record: KoersdagRecord) {
  const { staked, paidOut } = totals(record)
  await putSession(req.alias, userId, {
    id: record.draverij.id,
    date: record.draverij.date,
    draverij: record.draverij.place,
    staked,
    paidOut,
    evaluated: !!record.review?.evaluation,
  })
}

// Checks the AI connection and daily limit, then hands the step to the worker
async function startStep(
  req: RouteRequest,
  user: UserRecord,
  step: ReviewStep,
  prepare: (review: Review) => void = () => {},
  photo?: { bytes: Uint8Array; mediaType: string },
): Promise<KoersdagRecord> {
  let photoKey: string | undefined
  let countedDay: string | undefined
  const started = await mutate(req, user, async (record) => {
    const review = reviewOf(record)
    assertIdle(review)
    prepare(review)
    countedDay ??= await claimAiRun(req.alias, user, review.countedDay)
    if (photo && !photoKey) {
      photoKey = `${user.id}/${record.draverij.id}/uitslag-${randomUUID()}`
      await putPhoto(req.alias, photoKey, photo.bytes, photo.mediaType)
    }
    record.review = {
      ...review,
      countedDay,
      status: 'thinking',
      error: undefined,
      step,
      thinkingSince: nextThinkingSince(review.thinkingSince),
      photoKey,
      photoMediaType: photo?.mediaType,
    }
    return record
  })
  const since = started.review!.thinkingSince!
  try {
    await startWorker(req.alias, { userId: user.id, draverijId: started.draverij.id, thinkingSince: since }, WORKER_ENV)
    return started
  } catch (err) {
    console.error(err)
    if (photoKey) await deletePhoto(req.alias, photoKey).catch(console.error)
    return mutate(req, user, (record) => {
      const review = reviewOf(record)
      if (review.thinkingSince === since) {
        record.review = { ...review, status: 'error', error: 'De AI kon niet gestart worden. Probeer het opnieuw.', photoKey: undefined }
      }
      return record
    })
  }
}

function readAmount(body: Record<string, unknown>, key: string, message: string, opts: { allowZero?: boolean } = {}) {
  const value = body[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (!opts.allowZero && value === 0)) {
    throw new HttpError(400, message)
  }
  if (value > MAX_BUDGET) throw new HttpError(400, `Een bedrag mag maximaal € ${MAX_BUDGET} zijn.`)
  return Math.round(value * 100) / 100
}

const withBalance = (s: SessionRecord) => ({
  id: s.id,
  date: s.date,
  draverij: s.draverij,
  staked: s.staked,
  paidOut: s.paidOut,
  balance: Math.round((s.paidOut - s.staked) * 100) / 100,
  evaluated: s.evaluated === true,
})

function sumUp(rows: { staked: number; paidOut: number }[]) {
  const round = (n: number) => Math.round(n * 100) / 100
  const staked = round(rows.reduce((sum, r) => sum + r.staked, 0))
  const paidOut = round(rows.reduce((sum, r) => sum + r.paidOut, 0))
  return { staked, paidOut, balance: round(paidOut - staked) }
}

// ── Routes ───────────────────────────────────────────────────────────────

export const handler = createHandler({
  // The player's own finished koersdagen, newest first, with the total saldo
  'GET /terugblik': async (req) => {
    const user = await authenticate(req)
    const koersdagen = (await listSessions(req.alias, user.id)).map(withBalance)
    return ok({ koersdagen, totals: sumUp(koersdagen) })
  },

  'GET /terugblik/{id}': async (req) => {
    const user = await authenticate(req)
    return ok(toTerugblikView(await load(req, user)))
  },

  // The AI looks up the uitslagen online (also "Opnieuw proberen")
  'POST /terugblik/{id}/results/fetch': async (req) => {
    const user = await authenticate(req)
    return ok(toTerugblikView(await startStep(req, user, 'results')), 202)
  },

  'POST /terugblik/{id}/results/photo': async (req) => {
    const user = await authenticate(req)
    const mediaType = req.body.mediaType
    if (typeof mediaType !== 'string' || !(PHOTO_TYPES as readonly string[]).includes(mediaType)) {
      throw new HttpError(400, 'Gebruik een foto (JPG, PNG of WebP).')
    }
    const image = readString(req.body, 'image', 'Maak eerst een foto van het uitslagbord.')
    if (image.length > MAX_PHOTO_BASE64) {
      throw new HttpError(413, 'De foto is te groot. Probeer het opnieuw; de app verkleint de foto automatisch.')
    }
    const bytes = new Uint8Array(Buffer.from(image, 'base64'))
    const actualType = sniffImage(bytes)
    if (!actualType) throw new HttpError(400, 'Dit bestand is geen foto. Probeer het opnieuw.')
    return ok(toTerugblikView(await startStep(req, user, 'photo', undefined, { bytes, mediaType: actualType })), 202)
  },

  // Confirms the uitslagen and starts the evaluation. When the AI can't start (daily limit,
  // no connection) the uitslagen stay confirmed and the evaluation can follow later.
  'PUT /terugblik/{id}/results': async (req) => {
    const user = await authenticate(req)
    const results = readResults(req.body.results)
    if (typeof results === 'string') throw new HttpError(400, results)
    await mutate(req, user, (record) => {
      const review = reviewOf(record)
      assertIdle(review)
      // New uitslagen make an earlier evaluation outdated
      record.review = { ...review, results, resultsConfirmedAt: new Date().toISOString(), evaluation: null }
      return record
    })
    try {
      return ok(toTerugblikView(await startStep(req, user, 'evaluate')), 202)
    } catch (err) {
      if (err instanceof HttpError && err.status !== 404) {
        const failed = await mutate(req, user, (record) => {
          record.review = { ...reviewOf(record), status: 'error', error: err.message, step: 'evaluate' }
          return record
        })
        await writeSession(req, user.id, failed)
        return ok(toTerugblikView(failed))
      }
      throw err
    }
  },

  // Starts (or retries) the evaluation of confirmed uitslagen
  'POST /terugblik/{id}/evaluate': async (req) => {
    const user = await authenticate(req)
    const record = await startStep(req, user, 'evaluate', (review) => {
      if (!review.resultsConfirmedAt || !review.results?.length) {
        throw new HttpError(409, 'Bevestig eerst de uitslagen.')
      }
    })
    return ok(toTerugblikView(record), 202)
  },

  // Finish open bets (uitbetaling) or correct an amount after the koersdag
  'PATCH /terugblik/{id}/bets/{betId}': async (req) => {
    const user = await authenticate(req)
    const hasAmount = 'amount' in req.body
    const hasWinnings = 'winnings' in req.body
    if (!hasAmount && !hasWinnings) throw new HttpError(400, 'Er is niets om te wijzigen.')
    const amount = hasAmount ? readAmount(req.body, 'amount', 'Vul een inzet in van meer dan € 0.') : undefined
    const winnings =
      hasWinnings && req.body.winnings !== null
        ? readAmount(req.body, 'winnings', 'Vul de uitbetaling in (0 als de inzet verloren is).', { allowZero: true })
        : null
    const record = await mutate(req, user, (r) => {
      const bet = r.bets.find((b) => b.id === req.params.betId)
      if (!bet) throw new HttpError(404, 'Deze inzet bestaat niet (meer).')
      if (amount !== undefined) bet.amount = amount
      if (hasWinnings) bet.winnings = winnings
      return r
    })
    await writeSession(req, user.id, record)
    return ok(toTerugblikView(record))
  },

  // Owner: totals per friend and every koersdag per user
  'GET /terugblik/overview': async (req) => {
    await requireOwner(req)
    const users = await listUsers(req.alias)
    const perUser = await Promise.all(
      users.map(async (u) => ({ user: u, sessions: (await listSessions(req.alias, u.id)).map(withBalance) })),
    )
    return ok({
      users: perUser
        .map(({ user: u, sessions }) => ({ id: u.id, name: u.name, role: u.role, koersdagen: sessions.length, ...sumUp(sessions) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'nl')),
      koersdagen: perUser
        .flatMap(({ user: u, sessions }) => sessions.map((s) => ({ ...s, userId: u.id, userName: u.name })))
        .sort((a, b) => b.date.localeCompare(a.date) || a.userName.localeCompare(b.userName, 'nl')),
    })
  },

  'GET /lessons': async (req) => {
    await requireOwner(req)
    // Only test lessons can move to production
    return ok({ lessons: await kb.listLessons(req.alias, MAX_LESSONS_LISTED), canPromote: req.alias === 'dev' })
  },

  // Moves a test lesson to production; it then leaves this list
  'POST /lessons/{id}/promote': async (req) => {
    await requireOwner(req)
    if (req.alias !== 'dev') throw new HttpError(409, 'Alleen lessen uit de testomgeving kunnen naar productie.')
    const id = req.params.id ?? ''
    if (!/^[\w-]{1,80}$/.test(id) || !(await kb.promoteLesson(id))) {
      throw new HttpError(404, 'Deze les bestaat niet (meer).')
    }
    return ok({ ok: true })
  },

  'DELETE /lessons/{id}': async (req) => {
    await requireOwner(req)
    const id = req.params.id ?? ''
    if (!/^[\w-]{1,80}$/.test(id) || !(await kb.removeLesson(req.alias, id))) {
      throw new HttpError(404, 'Deze les bestaat niet (meer).')
    }
    return ok({ ok: true })
  },
})
