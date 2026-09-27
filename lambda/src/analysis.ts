import { randomUUID } from 'node:crypto'
import { createHandler, HttpError, ok, readString, type RouteRequest } from './lib/api'
import {
  DRAVERIJ_ID_RE,
  MAX_CHAT_CHARS,
  MAX_MESSAGE_LENGTH,
  MAX_MESSAGES,
  draverijOf,
  effectiveStatus,
  endOfDay,
  isValidDate,
  kickoffText,
  parseReply,
  toChatSummary,
  toChatView,
  type ChatRecord,
  type Draverij,
} from './lib/analysis'
import {
  getAdvice,
  getChat,
  getDraverij,
  listAdvice,
  listChats,
  listDraverijen,
  putAdvice,
  putChat,
  putDraverij,
} from './lib/analysisStore'
import { claimAiRun, nextThinkingSince } from './lib/aiAccess'
import { authenticate } from './lib/session'
import { dayOf, type UserRecord } from './lib/store'
import { startWorker } from './lib/worker'

const MAX_PLACE_LENGTH = 40
const MAX_DAYS_AHEAD = 366

async function loadChat(req: RouteRequest, user: UserRecord): Promise<ChatRecord> {
  const id = req.params.id ?? ''
  const chat = DRAVERIJ_ID_RE.test(id) ? await getChat(req.alias, user.id, id) : undefined
  if (!chat) throw new HttpError(404, 'Deze analyse bestaat niet (meer). Misschien is de draverij al voorbij.')
  return chat
}

async function view(req: RouteRequest, chat: ChatRecord) {
  return toChatView(chat, await getAdvice(req.alias, chat.userId, chat.draverij.id))
}

// Checks the AI connection and the friend's daily limit, counts the chat for today,
// then hands the turn to the worker
async function startTurn(req: RouteRequest, user: UserRecord, chat: ChatRecord): Promise<ChatRecord> {
  chat.countedDay = await claimAiRun(req.alias, user, chat.countedDay)

  const now = nextThinkingSince(chat.thinkingSince)
  const started: ChatRecord = { ...chat, status: 'thinking', error: undefined, thinkingSince: now, updatedAt: now }
  await putChat(req.alias, started)
  try {
    await startWorker(req.alias, { userId: user.id, draverijId: chat.draverij.id, thinkingSince: now })
  } catch (err) {
    console.error(err)
    const failed: ChatRecord = { ...started, status: 'error', error: 'De AI kon niet gestart worden. Probeer het opnieuw.' }
    await putChat(req.alias, failed)
    return failed
  }
  return started
}

const userMessage = (text: string) => ({
  id: `m-${randomUUID()}`,
  role: 'user' as const,
  text,
  sources: [],
  createdAt: new Date().toISOString(),
})

function assertIdle(chat: ChatRecord) {
  if (effectiveStatus(chat).status === 'thinking') {
    throw new HttpError(409, 'De AI is nog bezig met een antwoord. Wacht even.')
  }
}

function readDraverij(body: Record<string, unknown>): Draverij | 'lookup' {
  if (typeof body.draverijId === 'string') return 'lookup'
  const place = readString(body, 'place', 'Vul de plaats van de draverij in.')
  if (place.length > MAX_PLACE_LENGTH) {
    throw new HttpError(400, `De plaats mag maximaal ${MAX_PLACE_LENGTH} tekens zijn.`)
  }
  const date = readString(body, 'date', 'Kies de datum van de draverij.')
  if (!isValidDate(date)) throw new HttpError(400, 'Kies een geldige datum.')
  const today = dayOf()
  if (date < today) throw new HttpError(400, 'Deze draverij is al voorbij. Kies een datum vanaf vandaag.')
  const latest = new Date(Date.parse(`${today}T12:00:00Z`) + MAX_DAYS_AHEAD * 86_400_000).toISOString().slice(0, 10)
  if (date > latest) throw new HttpError(400, 'Kies een datum binnen een jaar.')
  const draverij = draverijOf(place, date)
  if (!DRAVERIJ_ID_RE.test(draverij.id)) throw new HttpError(400, 'Gebruik letters in de plaatsnaam.')
  return draverij
}

export const handler = createHandler({
  'GET /draverijen': async (req) => {
    await authenticate(req)
    return ok(await listDraverijen(req.alias, dayOf()))
  },

  'GET /analyses': async (req) => {
    const user = await authenticate(req)
    const [chats, advice] = await Promise.all([listChats(req.alias, user.id), listAdvice(req.alias, user.id)])
    const locked = new Set(advice.map((a) => a.draverij.id))
    return ok(
      chats
        .sort((a, b) => a.draverij.date.localeCompare(b.draverij.date))
        .map((chat) => toChatSummary(chat, locked.has(chat.draverij.id))),
    )
  },

  'POST /analyses': async (req) => {
    const user = await authenticate(req)
    const parsed = readDraverij(req.body)
    let draverij: Draverij
    if (parsed === 'lookup') {
      const found = await getDraverij(req.alias, String(req.body.draverijId))
      if (!found || found.date < dayOf()) throw new HttpError(404, 'Deze draverij staat niet (meer) in de lijst.')
      draverij = found
    } else {
      draverij = (await getDraverij(req.alias, parsed.id)) ?? parsed
      if (draverij === parsed) await putDraverij(req.alias, draverij)
    }

    // One chat per user per draverij: continue the existing one
    const existing = await getChat(req.alias, user.id, draverij.id)
    if (existing) return ok(await view(req, existing))

    const now = new Date().toISOString()
    const chat: ChatRecord = {
      draverij,
      userId: user.id,
      status: 'idle',
      messages: [userMessage(kickoffText(draverij))],
      createdAt: now,
      updatedAt: now,
      expiresAt: endOfDay(draverij.date),
    }
    return ok(await view(req, await startTurn(req, user, chat)), 201)
  },

  'GET /analyses/{id}': async (req) => {
    const user = await authenticate(req)
    return ok(await view(req, await loadChat(req, user)))
  },

  'POST /analyses/{id}/messages': async (req) => {
    const user = await authenticate(req)
    const chat = await loadChat(req, user)
    const text = readString(req.body, 'text', 'Typ eerst een bericht.')
    if (text.length > MAX_MESSAGE_LENGTH) {
      throw new HttpError(400, `Je bericht mag maximaal ${MAX_MESSAGE_LENGTH} tekens zijn.`)
    }
    assertIdle(chat)
    if (chat.messages.length >= MAX_MESSAGES || JSON.stringify(chat.messages).length > MAX_CHAT_CHARS) {
      throw new HttpError(409, 'Deze chat is vol. Begin opnieuw om verder te praten; je vastgelegde advies blijft staan.')
    }
    // Check limits before saving the message, so a refused message stays in the input field
    const withMessage = { ...chat, messages: [...chat.messages, userMessage(text)] }
    return ok(await view(req, await startTurn(req, user, withMessage)), 202)
  },

  'POST /analyses/{id}/retry': async (req) => {
    const user = await authenticate(req)
    const chat = await loadChat(req, user)
    if (effectiveStatus(chat).status !== 'error') throw new HttpError(409, 'Er is niets om opnieuw te proberen.')
    return ok(await view(req, await startTurn(req, user, chat)), 202)
  },

  'POST /analyses/{id}/restart': async (req) => {
    const user = await authenticate(req)
    const chat = await loadChat(req, user)
    const fresh: ChatRecord = { ...chat, messages: [userMessage(kickoffText(chat.draverij))] }
    return ok(await view(req, await startTurn(req, user, fresh)), 202)
  },

  'POST /analyses/{id}/advice': async (req) => {
    const user = await authenticate(req)
    const chat = await loadChat(req, user)
    const messageId = readString(req.body, 'messageId', 'Kies het advies dat je wilt vastleggen.')
    const message = chat.messages.find((m) => m.id === messageId && m.role === 'assistant')
    const proposal = message ? parseReply(message.text).proposal : null
    if (!message || !proposal) throw new HttpError(404, 'Dit adviesvoorstel bestaat niet (meer).')
    await putAdvice(req.alias, user.id, {
      draverij: chat.draverij,
      messageId,
      proposal,
      lockedAt: new Date().toISOString(),
    })
    return ok(await view(req, chat))
  },
})
