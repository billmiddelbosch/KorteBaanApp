// Small text helpers shared by the kennisbank parsers and entity resolution.

export const decode = (text: string) =>
  text
    .replace(/&#0*39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&euro;/g, '€')

export const textOf = (html: string) =>
  decode(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()

// Canonical key for names of horses, pikeurs and stallen: case, accents, quotes, dots and
// spacing do not matter ("Jetlag d'Amour" = "jetlag d’amour", "M.T. Tapdancer" = "MT Tapdancer").
export function nameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

// Tidy display name: single spaces, straight apostrophes
export const cleanName = (name: string) =>
  name
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

// The uitslag-pdf's font drops ligatures: "ti" becomes "_" or "I", "tt" becomes "0"
// ("King Fana_c", "Heine A0ack", "Co0on Eye Joe"). Builds a matcher for such a garbled name.
export function garbledMatcher(garbled: string): RegExp {
  const pattern = cleanName(garbled)
    .split('')
    .map((ch, i, all) => {
      if (ch === '_') return '(?:ti|tt|fi|fl|ff|t)'
      if (ch === '0' && /[a-z]/i.test(all[i - 1] ?? '') && /[a-z]/i.test(all[i + 1] ?? '')) return '(?:tt|ti|ff)'
      if (ch === 'I' && /[a-z]/.test(all[i - 1] ?? '') && /[a-z]/.test(all[i + 1] ?? '')) return '(?:ti|I)'
      return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
  return new RegExp(`^${pattern}$`, 'i')
}

export const looksGarbled = (name: string) => /_|[a-z]0[a-z]/i.test(name) || /[a-z]I[a-z]/.test(name)

// "€46.612,00" / "46.612,00" / "2.500" / "6000,-" → 46612 / 2500 / 6000
export function parseEuro(text: string): number | null {
  const m = /(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}|-))?/.exec(text.replace(/\s/g, ''))
  if (!m) return null
  const whole = Number(m[1]!.replace(/\./g, ''))
  const cents = m[2] && m[2] !== '-' ? Number(m[2].padEnd(2, '0')) / 100 : 0
  return whole + cents
}

export const DUTCH_MONTHS: Record<string, number> = {
  januari: 1,
  februari: 2,
  maart: 3,
  april: 4,
  mei: 5,
  juni: 6,
  juli: 7,
  augustus: 8,
  september: 9,
  oktober: 10,
  november: 11,
  december: 12,
}

// "13 oktober 2025" → "2025-10-13"
export function parseDutchDate(text: string): string | null {
  const m = /(\d{1,2})\s+([a-z]+)\s+(\d{4})/i.exec(text)
  const month = m && DUTCH_MONTHS[m[2]!.toLowerCase()]
  if (!m || !month) return null
  return `${m[3]}-${String(month).padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
}
