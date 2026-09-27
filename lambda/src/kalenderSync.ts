import type { Context } from 'aws-lambda'
import { draverijOf } from './lib/analysis'
import { deleteKalenderDraverij, putKalenderDraverij } from './lib/analysisStore'
import { aliasOf } from './lib/http'
import { inWindow, KALENDER_URL, parseKalender } from './lib/kalender'
import { dayOf } from './lib/store'

// Scheduled (EventBridge, daily): copies the Kortebaanbond calendar for the coming year into
// the draverijen list that Analyse and Koersdag choose from. Cancelled kortebanen are removed.
export async function handler(_event: unknown, context: Context) {
  const alias = aliasOf(context)
  const res = await fetch(KALENDER_URL, { headers: { 'User-Agent': 'KorteBaanApp kalender-sync' } })
  if (!res.ok) throw new Error(`Kortebaankalender ophalen mislukt: HTTP ${res.status}`)

  const entries = parseKalender(await res.text())
  // An empty result means the page layout changed; fail loudly instead of silently syncing nothing
  if (!entries.length) throw new Error('Geen kortebanen gevonden op de kalenderpagina')

  const today = dayOf()
  const upcoming = entries.filter((e) => inWindow(e.date, today))
  let added = 0
  let removed = 0
  for (const entry of upcoming) {
    const draverij = draverijOf(entry.place, entry.date)
    if (entry.cancelled) {
      await deleteKalenderDraverij(alias, draverij.id)
      removed++
    } else {
      await putKalenderDraverij(alias, draverij)
      added++
    }
  }

  const summary = { alias, found: entries.length, upcoming: upcoming.length, added, removed }
  console.log('kalender-sync', JSON.stringify(summary))
  return summary
}
