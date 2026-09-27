import { HttpError } from './api'
import type { Alias } from './http'
import { dayOf, getAiConfig, incrementUsage, usageOn, type UserRecord } from './store'

// Shared by Analyse and Koersdag before an AI run: the AI must be connected, and a friend's
// daily limit counts each chat/koersdag once per day. Returns the (new) counted day.
export async function claimAiRun(alias: Alias, user: UserRecord, countedDay: string | undefined): Promise<string> {
  const config = await getAiConfig(alias)
  if (!config) {
    throw new HttpError(409, 'De AI is nog niet gekoppeld. Vraag de eigenaar om de AI-koppeling in te stellen.')
  }
  if (config.status !== 'connected') {
    throw new HttpError(503, 'De AI-koppeling werkt op dit moment niet. De eigenaar is op de hoogte gebracht.')
  }

  const today = dayOf()
  if (countedDay === today) return today
  if (user.role !== 'owner' && user.dailyLimit !== null) {
    const used = (await usageOn(alias, today)).get(user.id) ?? 0
    if (used >= user.dailyLimit) {
      throw new HttpError(
        429,
        `Je hebt je daglimiet van ${user.dailyLimit} analyses bereikt. Morgen kun je weer verder.`,
      )
    }
  }
  await incrementUsage(alias, today, user.id)
  return today
}

// A worker run is identified by thinkingSince, so it must never repeat
export function nextThinkingSince(previous: string | undefined): string {
  const last = previous ? Date.parse(previous) : 0
  return new Date(Math.max(Date.now(), last + 1)).toISOString()
}
