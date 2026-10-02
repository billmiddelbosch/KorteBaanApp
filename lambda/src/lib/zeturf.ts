// ZEturf runs the kortebaan totalisator and publishes starters, loting and uitslagen per omloop.
// Every "reunion-du-jour" page of a date links all races of that day, so we read one and pick the
// Winnend & Plaats omlopen of our kortebaan. The live quoteringen are pushed to the browser with
// JavaScript and are not in the HTML; those come from bordfoto's instead.
import type { Draverij } from './analysis'

const ZETURF = 'https://www.zeturf.nl'
const FETCH_TIMEOUT_MS = 8000

export interface ZeturfOmloop {
  omloop: number
  url: string
}

// Compares place slugs loosely: ZEturf may write "st-annaparochie" where we write "sint-annaparochie"
const placeKey = (slug: string) => slug.replace(/^sint-/, 'st-').replace(/[^a-z0-9]/g, '')

export function findOmlopen(html: string, draverij: Draverij): ZeturfOmloop[] {
  const place = placeKey(draverij.id.slice(draverij.date.length + 1))
  const date = draverij.date.replace(/[^0-9-]/g, '')
  const re = new RegExp(
    `href="(/nl/course-du-jour/${date}/R\\d+C\\d+-kortebaan-([a-z0-9-]+?)-winnend-plaats-omloop-(\\d+))"`,
    'g',
  )
  const found = new Map<number, string>()
  for (const [, path, slug, n] of html.matchAll(re)) {
    if (placeKey(slug!) === place && !found.has(Number(n))) found.set(Number(n), `${ZETURF}${path}`)
  }
  return [...found].sort(([a], [b]) => a - b).map(([omloop, url]) => ({ omloop, url }))
}

// null: ZEturf could not be read; [] : ZEturf has no Winnend & Plaats for this kortebaan (yet)
export async function zeturfOmlopen(draverij: Draverij): Promise<ZeturfOmloop[] | null> {
  try {
    const res = await fetch(`${ZETURF}/nl/reunion-du-jour/${draverij.date}/R50-kortebaan`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (KorteBaanApp koersdag)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.warn(`ZEturf ${res.status} for ${draverij.id}`)
      return null
    }
    return findOmlopen(await res.text(), draverij)
  } catch (err) {
    console.warn('ZEturf not reachable', err)
    return null
  }
}
