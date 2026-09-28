import { draverijOf } from './lib/analysis'
import { KALENDER_URL, parseKalender } from './lib/kalender'
import { kbClient } from './lib/kb/db'
import { loadEvent } from './lib/kb/ingest'
import { knownState, Resolver, writeRecord, writeWeather } from './lib/kb/store'
import { fetchWeather } from './lib/kb/weather'

// Scheduled (EventBridge, daily) and manually invokable: adds the results of recent draverijen
// to the kennisbank. There is one kennisbank for dev and prod, so this runs once, not per alias.
// Manual: invoke with {"event": "/events/53/tzand-2025"} to (re)load one draverij.
const LOOKBACK_DAYS = 21

// Calendar day in Amsterdam (own copy: lib/store pulls in the DynamoDB client)
const dayOf = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(d)

interface IngestEvent {
  event?: string
  place?: string
}

export async function handler(input: IngestEvent = {}) {
  const host = process.env.KB_HOST
  if (!host) throw new Error('KB_HOST ontbreekt')
  const client = await kbClient({ host, role: 'kb_writer' })
  const today = dayOf()

  let targets: { path: string; place?: string; id?: string }[]
  if (input.event) {
    if (!/^\/events\/\d+\/[\w'%.-]+$/.test(input.event)) throw new Error(`Ongeldig event-pad: ${input.event}`)
    targets = [{ path: input.event, place: input.place }]
  } else {
    const res = await fetch(KALENDER_URL, { headers: { 'User-Agent': 'KorteBaanApp kennisbank' } })
    if (!res.ok) throw new Error(`Kortebaankalender ophalen mislukt: HTTP ${res.status}`)
    const entries = parseKalender(await res.text())
    if (!entries.length) throw new Error('Geen kortebanen gevonden op de kalenderpagina')
    const from = dayOf(new Date(Date.now() - LOOKBACK_DAYS * 86_400_000))
    const recent = entries
      .filter((e) => !e.cancelled && e.event && e.date >= from && e.date < today)
      .map((e) => ({ path: e.event!, place: e.place, id: draverijOf(e.place, e.date).id }))
    // Skip draverijen that are already complete
    const state = await knownState(
      client,
      recent.map((t) => t.id),
    )
    targets = recent.filter((t) => {
      const s = state.get(t.id)
      return !(s && s.detail === 'volledig' && s.weather)
    })
  }

  const resolver = await Resolver.load(client)
  const results: Record<string, string> = {}
  for (const target of targets) {
    try {
      const loaded = await loadEvent(target.path, target.place)
      for (const w of loaded?.warnings ?? []) console.warn('kb-ingest', target.path, w)
      const record = loaded?.record
      if (!record) {
        results[target.path] = 'nog geen uitslag'
        continue
      }
      const written = await writeRecord(client, resolver, record)
      let weather = ''
      if (record.baan.lat !== null && record.baan.lon !== null) {
        const w = await fetchWeather(record.baan.lat, record.baan.lon, record.date, today).catch((err: Error) => {
          console.warn('kb-ingest weer', record.id, err.message)
          return null
        })
        if (w) {
          await writeWeather(client, record.id, w)
          weather = ' + weer'
        }
      }
      results[target.path] = `${record.id} ${record.detail} ${written}${weather}`
    } catch (err) {
      console.error('kb-ingest', target.path, err)
      results[target.path] = `fout: ${(err as Error).message}`
    }
  }

  const summary = { today, targets: targets.length, results }
  console.log('kb-ingest', JSON.stringify(summary))
  return summary
}
