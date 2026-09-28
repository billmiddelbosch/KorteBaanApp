// Fetches one Kortebaanbond event page with its pdf's and turns it into a DraverijRecord.
// Shared by the daily kbIngest Lambda and the one-off backfill script.
import { KBB, parseEventPage, type EventPage } from './kbbond'
import { pdfLines } from './pdf'
import { eventRecord, type DraverijRecord } from './record'
import { parseRitverloop, type Ritverloop } from './ritverloop'
import { parseUitslagPdf, type UitslagPdf } from './uitslagPdf'

const HEADERS = { 'User-Agent': 'KorteBaanApp kennisbank (kortebaan.nl)' }

const absolute = (url: string) => {
  const full = url.startsWith('http') ? url : `${KBB}${url}`
  return /\s/.test(full) ? encodeURI(full) : full
}

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(absolute(url), { headers: HEADERS })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.text()
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(absolute(url), { headers: HEADERS })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

export const eventIdOf = (path: string) => Number(/\/events\/(\d+)/.exec(path)?.[1] ?? NaN)

export interface LoadedEvent {
  page: EventPage
  record: DraverijRecord | null
  warnings: string[]
}

// A broken pdf costs detail, not the whole draverij: the record falls back to the next source
export async function loadEvent(path: string, place?: string): Promise<LoadedEvent | null> {
  const url = absolute(path)
  const page = parseEventPage(await fetchText(url))
  if (!page) return null
  const warnings: string[] = []

  let ritverloop: Ritverloop | null = null
  if (page.pdfs.ritverloop) {
    try {
      ritverloop = parseRitverloop(await pdfLines(await fetchBytes(page.pdfs.ritverloop)))
      if (!ritverloop.omlopen.length) warnings.push(`rittenverloop zonder omlopen: ${page.pdfs.ritverloop}`)
    } catch (err) {
      warnings.push(`rittenverloop: ${(err as Error).message}`)
    }
  }
  let uitslag: UitslagPdf | null = null
  if (page.pdfs.uitslag) {
    try {
      uitslag = parseUitslagPdf(await pdfLines(await fetchBytes(page.pdfs.uitslag)))
    } catch (err) {
      warnings.push(`uitslag-pdf: ${(err as Error).message}`)
    }
  }
  const record = eventRecord(eventIdOf(path), url, page, { ritverloop, uitslag }, place ?? page.place)
  return { page, record, warnings }
}
