import { draverijOf } from './lib/analysis'
import { KALENDER_URL, parseKalender } from './lib/kalender'
import { kbClient } from './lib/kb/db'
import { loadEvent, loadProgramma } from './lib/kb/ingest'
import { firstOmloop } from './lib/kb/programma'
import { recomputeRatings } from './lib/kb/ratings'
import { knownState, Resolver, writeRecord, writeWeather } from './lib/kb/store'
import { fetchWeather } from './lib/kb/weather'
import { recordPredictions, scorePredictions } from './lib/kb/write'

// Scheduled (EventBridge, daily) and manually invokable: adds the results of recent draverijen
// to the kennisbank. There is one kennisbank for dev and prod, so this runs once, not per alias.
// Manual: invoke with {"event": "/events/53/tzand-2025"} to (re)load one draverij, or with
// {"ratings": true} to only recompute the ratings. After new results it scores the AI's win
// chances for those draverijen and recomputes all ratings. Then, for the draverijen of the next
// days whose programma is out, it records the rating chance (p_rating) of every first-omloop
// koppel, so each draverij has a prediction made beforehand to score the AI and the rating against.
const LOOKBACK_DAYS = 21
const LOOKAHEAD_DAYS = 3

// Calendar day in Amsterdam (own copy: lib/store pulls in the DynamoDB client)
const dayOf = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(d)

interface IngestEvent {
  event?: string
  place?: string
  ratings?: boolean
}

export async function handler(input: IngestEvent = {}) {
  const host = process.env.KB_HOST
  if (!host) throw new Error('KB_HOST ontbreekt')
  const client = await kbClient({ host, role: 'kb_writer' })
  const today = dayOf()
  if (input.ratings && !input.event) return { today, ratings: await ratings(client) }

  let targets: { path: string; place?: string; id?: string }[]
  let upcoming: { path: string; id: string }[] = []
  if (input.event) {
    if (!/^\/events\/\d+\/[\w'%.-]+$/.test(input.event)) throw new Error(`Ongeldig event-pad: ${input.event}`)
    targets = [{ path: input.event, place: input.place }]
  } else {
    const res = await fetch(KALENDER_URL, { headers: { 'User-Agent': 'KorteBaanApp kennisbank' } })
    if (!res.ok) throw new Error(`Kortebaankalender ophalen mislukt: HTTP ${res.status}`)
    const entries = parseKalender(await res.text())
    if (!entries.length) throw new Error('Geen kortebanen gevonden op de kalenderpagina')
    const from = dayOf(new Date(Date.now() - LOOKBACK_DAYS * 86_400_000))
    const until = dayOf(new Date(Date.now() + LOOKAHEAD_DAYS * 86_400_000))
    upcoming = entries
      .filter((e) => !e.cancelled && e.event && e.date >= today && e.date <= until)
      .map((e) => ({ path: e.event!, id: draverijOf(e.place, e.date).id }))
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
  const changed: string[] = []
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
      if (written !== 'skipped') changed.push(record.id)
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

  let scored = 0
  for (const id of changed) {
    scored += await scorePredictions(client, id).catch((err: Error) => {
      console.error('kb-ingest scoren', id, err)
      return 0
    })
  }
  const rated = changed.length ? await ratings(client) : 'ongewijzigd'
  // After the ratings, so the prediction uses the latest ones
  const predicted: Record<string, string> = {}
  for (const u of upcoming) {
    predicted[u.id] = await predict(client, u).catch((err: Error) => {
      console.error('kb-ingest voorspelling', u.id, err)
      return `fout: ${err.message}`
    })
  }
  const summary = { today, targets: targets.length, results, scored, ratings: rated, predicted }
  console.log('kb-ingest', JSON.stringify(summary))
  return summary
}

// Rating chance per first-omloop koppel from the programma; redone every day until the draverij
async function predict(client: Awaited<ReturnType<typeof kbClient>>, u: { path: string; id: string }): Promise<string> {
  const ridden = await client.query(`select 1 from kb.koppel where draverij_id = $1 and origin = 'shared' limit 1`, [u.id])
  if (ridden.rowCount) return 'al verreden'
  const programma = await loadProgramma(u.path)
  if (!programma) return 'nog geen programma'
  if (programma.date && !u.id.startsWith(programma.date)) return `programma van ${programma.date}`
  const kansen = firstOmloop(programma)
    .filter((k): k is typeof k & { b: string } => k.b !== null)
    .map((k) => ({ omloop: 1, koppel: k.koppel, links: k.a, rechts: k.b, winkansLinks: null, quotaLinks: null, quotaRechts: null }))
  // A horse can be scratched between two runs: start from a clean first omloop
  await client.query(`delete from kb.prediction where draverij_id = $1 and omloop = 1 and origin = 'shared'`, [u.id])
  return `${await recordPredictions(client, 'shared', u.id, kansen, 'programma')} koppels`
}

async function ratings(client: Awaited<ReturnType<typeof kbClient>>): Promise<string> {
  try {
    const { rows, backtest } = await recomputeRatings(client)
    return `${rows} ratings; backtest ${backtest.matches} koppels, Brier ${backtest.brier}`
  } catch (err) {
    console.error('kb-ingest ratings', err)
    return `fout: ${(err as Error).message}`
  }
}
