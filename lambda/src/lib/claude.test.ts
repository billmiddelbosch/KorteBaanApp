import { afterEach, describe, expect, it, vi } from 'vitest'
import { askClaude, TOOL_BUDGET_SPENT } from './claude'

interface Body {
  messages: { role: string; content: unknown }[]
  tools?: { name?: string; type?: string; max_uses?: number }[]
  tool_choice?: { type: string }
}

function stubApi(replies: { content: unknown[]; stop_reason: string }[]) {
  const bodies: Body[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Body)
      return new Response(JSON.stringify(replies[bodies.length - 1]), { status: 200 })
    }),
  )
  return bodies
}

const toolUse = (id: string) => ({ type: 'tool_use', id, name: 'kb_field', input: { namen: ['Fleur'] } })
const tool = { name: 'kb_field', description: 'x', input_schema: { type: 'object' } }
const ask = { system: 's', turns: [{ role: 'user' as const, text: 'Advies?' }], timeoutMs: 5000, tools: [tool] }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('askClaude with own tools', () => {
  it('runs tool rounds and answers with the text after the last one', async () => {
    const bodies = stubApi([
      { content: [{ type: 'text', text: 'Even kijken.' }, toolUse('t1')], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Fleur wint.' }], stop_reason: 'end_turn' },
    ])
    const runTool = vi.fn(async () => '### Fleur')
    const reply = await askClaude('token', { ...ask, runTool, searchBudget: 3 })
    expect(reply.text).toBe('Fleur wint.')
    expect(runTool).toHaveBeenCalledWith('kb_field', { namen: ['Fleur'] })
    expect(bodies[0]!.tools?.map((t) => t.name)).toContain('kb_field')
    expect(bodies[0]!.tools?.find((t) => t.type?.startsWith('web_search'))?.max_uses).toBe(3)
    expect(bodies[1]!.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: '### Fleur' }],
    })
  })

  it('tells Claude the budget is spent and reports failing tools as errors', async () => {
    const bodies = stubApi([
      { content: [toolUse('t1')], stop_reason: 'tool_use' },
      { content: [toolUse('t2')], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Klaar.' }], stop_reason: 'end_turn' },
    ])
    const runTool = async () => {
      throw new Error('stuk')
    }
    const reply = await askClaude('token', { ...ask, runTool, maxToolRounds: 1 })
    expect(reply.text).toBe('Klaar.')
    expect(bodies[1]!.messages.at(-1)!.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'Tool kb_field faalde: stuk', is_error: true },
    ])
    expect(bodies[2]!.messages.at(-1)!.content).toEqual([
      { type: 'tool_result', tool_use_id: 't2', content: TOOL_BUDGET_SPENT, is_error: true },
    ])
  })

  it('forces an answer without tools once the tool budget is spent', async () => {
    const bodies = stubApi([
      { content: [toolUse('t1')], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Fleur wint.' }], stop_reason: 'end_turn' },
    ])
    const reply = await askClaude('token', { ...ask, runTool: async () => '### Fleur', maxToolRounds: 1 })
    expect(reply.text).toBe('Fleur wint.')
    expect(bodies[0]!.tool_choice).toBeUndefined()
    expect(bodies[1]!.tool_choice).toEqual({ type: 'none' })
  })

  it('forces an answer on the last request when searches paused the turn', async () => {
    const pause = { content: [{ type: 'server_tool_use', id: 's', name: 'web_search', input: {} }], stop_reason: 'pause_turn' }
    // 3 continuations + 1 + (1 tool round + 1): the 6th request is the last
    const bodies = stubApi([
      pause,
      pause,
      pause,
      pause,
      pause,
      { content: [{ type: 'text', text: 'Fleur wint.' }], stop_reason: 'end_turn' },
    ])
    const reply = await askClaude('token', { ...ask, runTool: async () => '### Fleur', maxToolRounds: 1 })
    expect(reply.text).toBe('Fleur wint.')
    expect(bodies).toHaveLength(6)
    expect(bodies[4]!.tool_choice).toBeUndefined()
    expect(bodies[5]!.tool_choice).toEqual({ type: 'none' })
  })

  it('never ends on unanswered tool results', async () => {
    // Claude keeps calling tools; the last reply is kept instead of sending results nobody reads
    const bodies = stubApi(
      Array.from({ length: 6 }, (_, i) => ({
        content: [{ type: 'text', text: `Stap ${i}.` }, toolUse(`t${i}`)],
        stop_reason: 'tool_use',
      })),
    )
    const reply = await askClaude('token', { ...ask, runTool: async () => '### Fleur', maxToolRounds: 1 })
    expect(bodies).toHaveLength(6)
    expect(reply.text).toBe('Stap 5.')
  })
})

describe('askClaude without text in the reply', () => {
  it('says the answer got too long when the output limit is reached without text', async () => {
    const bodies = stubApi([{ content: [{ type: 'thinking', thinking: '…' }], stop_reason: 'max_tokens' }])
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(askClaude('token', { ...ask, maxTokens: 16_000 })).rejects.toThrow('Het antwoord werd te lang')
    expect((bodies[0] as Body & { max_tokens: number }).max_tokens).toBe(16_000)
    expect(error).toHaveBeenCalledWith('Claude reply without text; blocks: thinking')
  })

  it('keeps the general message for other empty replies', async () => {
    const bodies = stubApi([{ content: [], stop_reason: 'end_turn' }])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(askClaude('token', ask)).rejects.toThrow('Claude gaf een leeg antwoord')
    expect((bodies[0] as Body & { max_tokens: number }).max_tokens).toBe(4096)
  })
})
