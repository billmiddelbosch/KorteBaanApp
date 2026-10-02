import { randomUUID } from 'node:crypto'
import { claimAiRun, nextThinkingSince } from './lib/aiAccess'
import { DRAVERIJ_ID_RE, draverijOf, endOfDay, type Draverij } from './lib/analysis'
import { getAdvice, getDraverij, listAdvice, listDraverijen, putDraverij } from './lib/analysisStore'
import { createHandler, HttpError, ok, readString, type RouteRequest } from './lib/api'
import {
  KEEP_DAYS,
  MAX_BET_LENGTH,
  MAX_BETS,
  MAX_BUDGET,
  MAX_PHOTO_BASE64,
  MAX_PHOTOS,
  MAX_PLACE_LENGTH,
  MAX_UPDATES,
  PHOTO_TYPES,
  effectiveKoersdagStatus,
  sniffImage,
  toKoersdagView,
  totals,
  type Bet,
  type KoersdagRecord,
  type StoredPhoto,
  type UpdateKind,
} from './lib/koersdag'
import { getKoersdag, KoersdagChangedError, putKoersdag } from './lib/koersdagStore'
import { deletePhoto, putPhoto } from './lib/photos'
import { authenticate } from './lib/session'
import { dayOf, putSession, type UserRecord } from './lib/store'
import { startWorker } from './lib/worker'

const WORKER_ENV = 'KOERSDAG_WORKER_NAME'

const NOT_FOUND = 'Deze koersdag bestaat niet (meer).'
const FINISHED = 'Deze koersdag is al afgerond.'
const BUSY = 'De AI is nog bezig met de vorige update. Wacht even.'

async function load(req: RouteRequest, user: UserRecord): Promise<KoersdagRecord> {
  const id = req.params.id ?? ''
  const record = DRAVERIJ_ID_RE.test(id) ? await getKoersdag(req.alias, user.id, id) : undefined
  if (!record) throw new HttpError(404, NOT_FOUND)
  return record
}

async function view(req: RouteRequest, record: KoersdagRecord) {
  return toKoersdagView(record, await getAdvice(req.alias, record.userId, record.draverij.id))
}

const isThinking = (record: KoersdagRecord) => effectiveKoersdagStatus(record).status === 'thinking'

function assertOpen(record: KoersdagRecord) {
  if (record.finishedAt) throw new HttpError(409, FINISHED)
}

function assertIdle(record: KoersdagRecord) {
  assertOpen(record)
  if (isThinking(record)) throw new HttpError(409, BUSY)
}

// Read-modify-write with optimistic locking; the worker may save in between, so retry on a fresh copy
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
        throw new HttpError(409, 'Er veranderde net iets aan je koersdag. Probeer het opnieuw.')
      }
      throw err
    }
  }
}

// One photo from the request body; the declared type only filters, the bytes decide
function readPhoto(value: unknown): { bytes: Uint8Array; mediaType: string; size: number } {
  const body = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const mediaType = body.mediaType
  if (typeof mediaType !== 'string' || !(PHOTO_TYPES as readonly string[]).includes(mediaType)) {
    throw new HttpError(400, 'Gebruik een foto (JPG, PNG of WebP).')
  }
  const image = readString(body, 'image', 'Maak eerst een foto.')
  if (image.length > MAX_PHOTO_BASE64) {
    throw new HttpError(413, 'De foto is te groot. Probeer het opnieuw; de app verkleint de foto automatisch.')
  }
  const bytes = new Uint8Array(Buffer.from(image, 'base64'))
  const actualType = sniffImage(bytes)
  if (!actualType) throw new HttpError(400, 'Dit bestand is geen foto. Probeer het opnieuw.')
  return { bytes, mediaType: actualType, size: image.length }
}

// Checks the AI connection and daily limit, then hands the update to the worker
async function startUpdate(
  req: RouteRequest,
  user: UserRecord,
  kind: UpdateKind,
  prepare: (record: KoersdagRecord) => void = () => {},
  photos: { bytes: Uint8Array; mediaType: string }[] = [],
): Promise<KoersdagRecord> {
  // Kept across mutate() retries, so a retry neither counts twice nor uploads twice
  let stored: StoredPhoto[] | undefined
  let countedDay: string | undefined
  const removePhotos = () =>
    Promise.all((stored ?? []).map((p) => deletePhoto(req.alias, p.key).catch(console.error)))
  const started = await mutate(req, user, async (record) => {
    assertIdle(record)
    if (record.updates.length >= MAX_UPDATES) {
      throw new HttpError(409, 'Deze koersdag heeft het maximale aantal updates bereikt. Rond de koersdag af.')
    }
    countedDay ??= await claimAiRun(req.alias, user, record.countedDay)
    record.countedDay = countedDay
    prepare(record)
    if (photos.length && !stored) {
      const prefix = `${user.id}/${record.draverij.id}/${randomUUID()}`
      stored = photos.map((p, i) => ({ key: `${prefix}-${i + 1}`, mediaType: p.mediaType }))
      await Promise.all(stored.map((p, i) => putPhoto(req.alias, p.key, photos[i]!.bytes, p.mediaType)))
    }
    const since = nextThinkingSince(record.thinkingSince)
    return {
      ...record,
      status: 'thinking',
      error: undefined,
      step: kind,
      thinkingSince: since,
      photos: stored,
      photoKey: undefined,
      photoMediaType: undefined,
    }
  })
  try {
    await startWorker(
      req.alias,
      { userId: user.id, draverijId: started.draverij.id, thinkingSince: started.thinkingSince! },
      WORKER_ENV,
    )
    return started
  } catch (err) {
    console.error(err)
    await removePhotos()
    return mutate(req, user, (record) =>
      record.thinkingSince === started.thinkingSince
        ? { ...record, status: 'error', error: 'De AI kon niet gestart worden. Probeer het opnieuw.', photos: undefined }
        : record,
    )
  }
}

// ── Body readers ─────────────────────────────────────────────────────────

function readAmount(body: Record<string, unknown>, key: string, message: string, opts: { allowZero?: boolean } = {}) {
  const value = body[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (!opts.allowZero && value === 0)) {
    throw new HttpError(400, message)
  }
  if (value > MAX_BUDGET) throw new HttpError(400, `Een bedrag mag maximaal € ${MAX_BUDGET} zijn.`)
  return Math.round(value * 100) / 100
}

async function readTodayDraverij(req: RouteRequest): Promise<Draverij> {
  const today = dayOf()
  if (typeof req.body.draverijId === 'string') {
    const found = await getDraverij(req.alias, req.body.draverijId)
    if (!found || found.date !== today) throw new HttpError(404, 'Deze draverij is niet vandaag.')
    return found
  }
  const place = readString(req.body, 'place', 'Kies de draverij van vandaag.')
  if (place.length > MAX_PLACE_LENGTH) {
    throw new HttpError(400, `De plaats mag maximaal ${MAX_PLACE_LENGTH} tekens zijn.`)
  }
  const draverij = draverijOf(place, today)
  if (!DRAVERIJ_ID_RE.test(draverij.id)) throw new HttpError(400, 'Gebruik letters in de plaatsnaam.')
  const existing = await getDraverij(req.alias, draverij.id)
  if (existing) return existing
  await putDraverij(req.alias, draverij)
  return draverij
}

function findBet(record: KoersdagRecord, betId: string | undefined): Bet {
  const bet = record.bets.find((b) => b.id === betId)
  if (!bet) throw new HttpError(404, 'Deze inzet bestaat niet (meer).')
  return bet
}

// ── Routes ───────────────────────────────────────────────────────────────

export const handler = createHandler({
  // Today's koersdag (active or finished), the draverijen to start one for, and the next locked advice
  'GET /koersdagen/today': async (req) => {
    const user = await authenticate(req)
    const today = dayOf()
    const [draverijen, advice] = await Promise.all([listDraverijen(req.alias, today), listAdvice(req.alias, user.id)])
    const todays = draverijen.filter((d) => d.date === today)
    const records = (await Promise.all(todays.map((d) => getKoersdag(req.alias, user.id, d.id)))).filter(
      (r): r is KoersdagRecord => r !== undefined,
    )
    // An open koersdag wins over a finished one
    const current = records.find((r) => !r.finishedAt) ?? records[0]
    const adviceFor = new Map(advice.map((a) => [a.draverij.id, a]))
    const next = advice
      .filter((a) => a.draverij.date > today)
      .sort((a, b) => a.draverij.date.localeCompare(b.draverij.date))[0]
    return ok({
      current: current ? toKoersdagView(current, adviceFor.get(current.draverij.id)) : null,
      options: todays.map((d) => ({ draverij: d, advice: adviceFor.get(d.id) ?? null })),
      next: next ?? null,
    })
  },

  'POST /koersdagen': async (req) => {
    const user = await authenticate(req)
    const budget = readAmount(req.body, 'budget', 'Vul een budget in van meer dan € 0.')
    const draverij = await readTodayDraverij(req)

    // One koersdag per user per draverij: continue the existing one
    const existing = await getKoersdag(req.alias, user.id, draverij.id)
    if (existing) return ok(await view(req, existing))

    const now = new Date().toISOString()
    const record: KoersdagRecord = {
      draverij,
      userId: user.id,
      budget,
      status: 'idle',
      omloop: 1,
      updates: [],
      bets: [],
      createdAt: now,
      updatedAt: now,
      expiresAt: endOfDay(draverij.date) + KEEP_DAYS * 86_400,
    }
    try {
      await putKoersdag(req.alias, record, { create: true })
    } catch (err) {
      // Started twice at the same moment (double tap): show the one that won
      if (err instanceof KoersdagChangedError) return ok(await view(req, await load({ ...req, params: { id: draverij.id } }, user)))
      throw err
    }
    const reqWithId = { ...req, params: { id: draverij.id } }
    try {
      return ok(await view(reqWithId, await startUpdate(reqWithId, user, 'fetch')), 201)
    } catch (err) {
      // The koersdag exists; the AI couldn't start (limit, no connection). Show it with the reason.
      if (err instanceof HttpError && err.status !== 404) {
        const failed = await mutate(reqWithId, user, (r) => ({ ...r, status: 'error', error: err.message, step: 'fetch' }))
        return ok(await view(reqWithId, failed), 201)
      }
      throw err
    }
  },

  'GET /koersdagen/{id}': async (req) => {
    const user = await authenticate(req)
    return ok(await view(req, await load(req, user)))
  },

  // Fetch the latest news for the current omloop again (also "Opnieuw proberen")
  'POST /koersdagen/{id}/refresh': async (req) => {
    const user = await authenticate(req)
    return ok(await view(req, await startUpdate(req, user, 'fetch')), 202)
  },

  // Body { images: [{ image, mediaType }, …] }; the older { image, mediaType } is one photo
  'POST /koersdagen/{id}/photo': async (req) => {
    const user = await authenticate(req)
    const list = Array.isArray(req.body.images) ? (req.body.images as unknown[]) : [req.body]
    if (list.length === 0) throw new HttpError(400, 'Maak eerst een foto.')
    if (list.length > MAX_PHOTOS) throw new HttpError(400, `Stuur maximaal ${MAX_PHOTOS} foto's tegelijk.`)
    const photos = list.map(readPhoto)
    const total = photos.reduce((sum, p) => sum + p.size, 0)
    if (total > MAX_PHOTO_BASE64) {
      throw new HttpError(413, "De foto's zijn samen te groot. Stuur minder foto's tegelijk.")
    }
    return ok(await view(req, await startUpdate(req, user, 'photo', undefined, photos)), 202)
  },

  'POST /koersdagen/{id}/next': async (req) => {
    const user = await authenticate(req)
    return ok(
      await view(
        req,
        await startUpdate(req, user, 'fetch', (record) => {
          record.omloop += 1
        }),
      ),
      202,
    )
  },

  'POST /koersdagen/{id}/finish': async (req) => {
    const user = await authenticate(req)
    const record = await mutate(req, user, (r) => {
      assertOpen(r)
      const now = new Date().toISOString()
      // A new thinkingSince makes a still-running worker drop its result
      return { ...r, status: 'idle', error: undefined, thinkingSince: nextThinkingSince(r.thinkingSince), finishedAt: now }
    })
    const { staked, paidOut } = totals(record)
    await putSession(req.alias, user.id, {
      id: record.draverij.id,
      date: record.draverij.date,
      draverij: record.draverij.place,
      staked,
      paidOut,
    })
    return ok(await view(req, record))
  },

  'POST /koersdagen/{id}/bets': async (req) => {
    const user = await authenticate(req)
    const text = readString(req.body, 'bet', 'Vul in waarop je hebt ingezet.').slice(0, MAX_BET_LENGTH)
    const amount = readAmount(req.body, 'amount', 'Vul een inzet in van meer dan € 0.')
    const suggestionId = typeof req.body.suggestionId === 'string' ? req.body.suggestionId : null
    const record = await mutate(req, user, (r) => {
      assertOpen(r)
      if (r.bets.length >= MAX_BETS) throw new HttpError(409, 'Je kunt geen inzetten meer toevoegen aan deze koersdag.')
      if (suggestionId && !r.updates.some((u) => u.advice.some((s) => s.id === suggestionId))) {
        throw new HttpError(404, 'Deze suggestie bestaat niet (meer).')
      }
      if (suggestionId && r.bets.some((b) => b.suggestionId === suggestionId)) return r
      r.bets.push({
        id: `b-${randomUUID()}`,
        omloop: r.omloop,
        suggestionId,
        bet: text,
        amount,
        winnings: null,
        createdAt: new Date().toISOString(),
      })
      return r
    })
    return ok(await view(req, record), 201)
  },

  'PATCH /koersdagen/{id}/bets/{betId}': async (req) => {
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
      assertOpen(r)
      const bet = findBet(r, req.params.betId)
      if (amount !== undefined) bet.amount = amount
      if (hasWinnings) bet.winnings = winnings
      return r
    })
    return ok(await view(req, record))
  },

  'DELETE /koersdagen/{id}/bets/{betId}': async (req) => {
    const user = await authenticate(req)
    const record = await mutate(req, user, (r) => {
      assertOpen(r)
      const bet = findBet(r, req.params.betId)
      return { ...r, bets: r.bets.filter((b) => b !== bet) }
    })
    return ok(await view(req, record))
  },
})
