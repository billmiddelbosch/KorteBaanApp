import { describe, expect, it } from 'vitest'
import {
  STALE_ERROR,
  THINKING_STALE_MS,
  buildSystemPrompt,
  draverijOf,
  effectiveStatus,
  isValidDate,
  parseReply,
  slugify,
  type ChatRecord,
} from './analysis'
import { sourcesOf, toApiMessages } from './claude'

describe('parseReply', () => {
  const advice = {
    samenvatting: 'Voorzichtig spelen.',
    budget: 50,
    keuzes: [
      { koers: '1e omloop, koppel 3', inzet: 'Winnaar: Fleur de Lis', bedrag: 10, onderbouwing: 'Wint vaak op gras.' },
      { koers: 'Finale', inzet: '', bedrag: 5 },
    ],
  }

  it('extracts the advice and facts and strips them from the text', () => {
    const raw = `Hier is mijn advies.\n\n<advies>${JSON.stringify(advice)}</advies>\n<feiten>["Fleur de Lis won in Wolvega (2026-08-12)"]</feiten>`
    const parsed = parseReply(raw)
    expect(parsed.text).toBe('Hier is mijn advies.')
    expect(parsed.facts).toEqual(['Fleur de Lis won in Wolvega (2026-08-12)'])
    expect(parsed.proposal).toEqual({
      summary: 'Voorzichtig spelen.',
      budget: 50,
      // the pick without a bet is dropped
      picks: [{ race: '1e omloop, koppel 3', bet: 'Winnaar: Fleur de Lis', amount: 10, reasoning: 'Wint vaak op gras.' }],
    })
  })

  it('tolerates a code fence and ignores broken JSON', () => {
    expect(parseReply(`<advies>\`\`\`json\n${JSON.stringify(advice)}\n\`\`\`</advies>`).proposal?.picks).toHaveLength(1)
    const broken = parseReply('Tekst <advies>{kapot</advies>')
    expect(broken.proposal).toBeNull()
    expect(broken.text).toBe('Tekst')
  })

  it('leaves plain replies alone', () => {
    expect(parseReply('Wat is je budget?')).toEqual({ text: 'Wat is je budget?', proposal: null, facts: [] })
  })
})

describe('draverijen', () => {
  it('slugifies places into stable ids', () => {
    expect(slugify('Sint-Annaparochie')).toBe('sint-annaparochie')
    expect(slugify("  Hollandscheveld  ")).toBe('hollandscheveld')
    expect(slugify('Ée’n Plaats')).toBe('ee-n-plaats')
    expect(draverijOf('Wolvega', '2026-10-03').id).toBe('2026-10-03-wolvega')
  })

  it('validates dates', () => {
    expect(isValidDate('2026-10-03')).toBe(true)
    expect(isValidDate('2026-02-30')).toBe(false)
    expect(isValidDate('3-10-2026')).toBe(false)
  })
})

describe('effectiveStatus', () => {
  const chat = (status: ChatRecord['status'], since: number) =>
    ({ status, thinkingSince: new Date(since).toISOString() }) as ChatRecord

  it('turns a stuck thinking state into a retryable error', () => {
    const now = Date.now()
    expect(effectiveStatus(chat('thinking', now - 1000), now).status).toBe('thinking')
    expect(effectiveStatus(chat('thinking', now - THINKING_STALE_MS - 1), now)).toEqual({
      status: 'error',
      error: STALE_ERROR,
    })
  })
})

describe('buildSystemPrompt', () => {
  it('adds the koers, date and kennisbank after the instruction', () => {
    const prompt = buildSystemPrompt({
      instruction: 'Je bent een expert.',
      draverij: draverijOf('Wolvega', '2026-10-03'),
      today: '2026-09-27',
      kennisbank: '## Kennisbank (stand 2026-09-26)\nWolvega: 10 edities.',
    })
    expect(prompt.startsWith('Je bent een expert.')).toBe(true)
    expect(prompt).toContain('Wolvega op zaterdag 3 oktober 2026')
    expect(prompt).toContain('Wolvega: 10 edities.')
    expect(prompt).toContain('kb_record_claim')
    expect(prompt.indexOf('## Kennisbank')).toBeLessThan(prompt.indexOf('<advies>'))
    expect(prompt).not.toContain('<feiten>')
  })

  it('leaves the kennisbank out without one and says so when it is unreachable', () => {
    const base = { instruction: 'X', draverij: draverijOf('Wolvega', '2026-10-03'), today: '2026-09-27' }
    expect(buildSystemPrompt(base)).not.toContain('Kennisbank')
    expect(buildSystemPrompt({ ...base, kennisbank: null })).toContain('De kennisbank is nu niet bereikbaar')
  })
})

describe('claude helpers', () => {
  it('merges consecutive user turns and drops a leading assistant turn', () => {
    expect(
      toApiMessages([
        { role: 'assistant', text: 'x' },
        { role: 'user', text: 'a' },
        { role: 'user', text: 'b' },
        { role: 'assistant', text: 'c' },
      ]),
    ).toEqual([
      { role: 'user', content: 'a\n\nb' },
      { role: 'assistant', content: 'c' },
    ])
  })

  it('collects unique sources from citations, falling back to search results', () => {
    expect(
      sourcesOf([
        { type: 'text', text: 'a', citations: [{ url: 'https://a.nl/1', title: 'A' }, { url: 'https://a.nl/1', title: 'A' }] },
        { type: 'web_search_tool_result', content: [{ url: 'https://b.nl', title: 'B' }] },
      ]),
    ).toEqual([{ url: 'https://a.nl/1', title: 'A' }])
    expect(sourcesOf([{ type: 'web_search_tool_result', content: [{ url: 'https://b.nl/x', title: '' }] }])).toEqual([
      { url: 'https://b.nl/x', title: 'b.nl' },
    ])
  })

  it('lists fetched pages before search results when nothing was cited', () => {
    expect(
      sourcesOf([
        { type: 'web_search_tool_result', content: [{ url: 'https://b.nl', title: 'B' }] },
        {
          type: 'web_fetch_tool_result',
          content: { type: 'web_fetch_result', url: 'https://www.zeturf.nl/r', content: { title: 'ZEturf' } },
        },
        { type: 'web_fetch_tool_result', content: { type: 'web_fetch_tool_error', error_code: 'url_not_accessible' } },
      ]),
    ).toEqual([
      { url: 'https://www.zeturf.nl/r', title: 'ZEturf' },
      { url: 'https://b.nl', title: 'B' },
    ])
  })
})
