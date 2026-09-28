// One-off: fills the kennisbank with the history on kortebaanbond.nl.
//   npm run kb-backfill -- --dry-run                       (fetch + parse only, prints a summary)
//   npm run kb-backfill -- --host <KbEndpoint> [--from 2016] [--only tzand]
// Starts from the kortebanen on this year's kalender and follows the "Edities" of each
// kortebaan. Event pages exist from 2023 on and give the full rittenverloop; older years come
// from the "Statistieken" table (winner, pikeur, starters, totalisator). Idempotent: a draverij
// is never downgraded to less detail. Needs AWS credentials with dsql:DbConnectAdmin.
import { slugify } from '../src/lib/analysis'
import { KALENDER_URL, parseKalender } from '../src/lib/kalender'
import { connect } from '../src/lib/kb/db'
import { fetchText, loadEvent } from '../src/lib/kb/ingest'
import type { EventPage } from '../src/lib/kb/kbbond'
import { statRecord, type DraverijRecord } from '../src/lib/kb/record'
import { Resolver, writeRecord, writeWeather } from '../src/lib/kb/store'
import { fetchWeather } from '../src/lib/kb/weather'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const dayOf = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(d)

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const host = arg('host')
  const fromYear = Number(arg('from') ?? 2016)
  const only = arg('only')
  if (!dryRun && !host) {
    console.error('Gebruik: npm run kb-backfill -- --host <KbEndpoint> [--from 2016] [--only <plaats-slug>] | --dry-run')
    process.exit(1)
  }
  process.env.AWS_REGION ??= 'eu-west-2'
  const today = dayOf()

  // 1. Walk all event pages, keeping the kalender's place name so ids match the app's draverijen
  const kalender = parseKalender(await fetchText(KALENDER_URL))
  const queue = kalender
    .filter((e) => e.event && (!only || slugify(e.place) === only))
    .map((e) => ({ path: e.event!, place: e.place }))
  const seen = new Set<string>()
  const records = new Map<string, DraverijRecord>()
  const stats = new Map<string, { page: EventPage; url: string }>() // per place
  const warnings: string[] = []

  while (queue.length) {
    const { path, place } = queue.shift()!
    const eventId = /\/events\/(\d+)/.exec(path)?.[1]
    if (!eventId || seen.has(eventId)) continue
    seen.add(eventId)
    await sleep(500)
    try {
      const loaded = await loadEvent(path, place)
      if (!loaded) continue
      warnings.push(...loaded.warnings.map((w) => `${path}: ${w}`))
      for (const e of loaded.page.edities) queue.push({ path: e.path, place })
      if (!stats.has(place) && loaded.page.stats.length) stats.set(place, { page: loaded.page, url: `https://kortebaanbond.nl${path}` })
      const r = loaded.record
      if (r && Number(r.date.slice(0, 4)) >= fromYear) records.set(r.id, r)
      console.log(`${path} → ${r ? `${r.id} ${r.detail} (${r.deelnames.length} deelnames, ${r.koppels.length} koppels)` : 'geen uitslag'}`)
    } catch (err) {
      warnings.push(`${path}: ${(err as Error).message}`)
    }
  }

  // 2. Older years from the statistieken table of each kortebaan
  let statCount = 0
  for (const [place, { page, url }] of stats) {
    for (const row of page.stats) {
      if (row.year < fromYear || row.year >= Number(today.slice(0, 4)) + 1) continue
      const r = statRecord(place, page.coords, row, url)
      if (!r || records.has(r.id)) continue
      records.set(r.id, r)
      statCount++
    }
  }

  const byDetail = { volledig: 0, uitslag: 0, winnaar: 0 }
  for (const r of records.values()) byDetail[r.detail]++
  console.log(
    `\n${seen.size} eventpagina's, ${stats.size} kortebanen, ${records.size} draverijen sinds ${fromYear} ` +
      `(volledig ${byDetail.volledig}, uitslag ${byDetail.uitslag}, alleen winnaar ${byDetail.winnaar}; ${statCount} uit statistieken)`,
  )
  for (const w of warnings) console.warn(`waarschuwing: ${w}`)
  if (dryRun) return

  // 3. Write, oldest first
  const client = await connect({ host: host!, role: 'admin' })
  try {
    const resolver = await Resolver.load(client)
    const sorted = [...records.values()].sort((a, b) => a.date.localeCompare(b.date))
    let written = 0
    let weather = 0
    const failed: string[] = []
    for (const r of sorted) {
      // One bad draverij must not stop the rest of the history
      try {
        if ((await writeRecord(client, resolver, r)) === 'written') written++
      } catch (err) {
        console.error(`${r.id} mislukt: ${(err as Error).message}`)
        failed.push(r.id)
        continue
      }
      if (!r.cancelled && r.baan.lat !== null && r.baan.lon !== null) {
        await sleep(200)
        const w = await fetchWeather(r.baan.lat, r.baan.lon, r.date, today).catch(() => null)
        if (w) {
          await writeWeather(client, r.id, w)
          weather++
        }
      }
    }
    console.log(`Geschreven: ${written} draverijen, ${weather} met weer`)
    if (failed.length) console.log(`Mislukt (${failed.length}): ${failed.join(', ')}`)
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
