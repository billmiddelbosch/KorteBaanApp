import { createHandler, HttpError, ok, readString } from './lib/api'
import { DEFAULT_INSTRUCTION, MAX_INSTRUCTION_LENGTH, type InstructionRecord } from './lib/analysis'
import { getInstruction, putInstruction } from './lib/analysisStore'
import type { Alias } from './lib/http'
import { requireOwner } from './lib/session'

function toView(record: InstructionRecord | undefined) {
  return {
    text: record?.text ?? DEFAULT_INSTRUCTION,
    isDefault: !record || record.text === DEFAULT_INSTRUCTION,
    updatedAt: record?.updatedAt ?? null,
    hasPrevious: Boolean(record?.previous),
    defaultText: DEFAULT_INSTRUCTION,
  }
}

// Saves `text`, keeping the version it replaces as the one to revert to
async function save(alias: Alias, current: InstructionRecord | undefined, text: string, userId: string) {
  const now = new Date().toISOString()
  const record: InstructionRecord = {
    text,
    updatedAt: now,
    updatedBy: userId,
    previous: { text: current?.text ?? DEFAULT_INSTRUCTION, updatedAt: current?.updatedAt ?? now },
  }
  await putInstruction(alias, record)
  return record
}

export const handler = createHandler({
  'GET /ai-instruction': async (req) => {
    await requireOwner(req)
    return ok(toView(await getInstruction(req.alias)))
  },

  'PUT /ai-instruction': async (req) => {
    const owner = await requireOwner(req)
    const text = readString(req.body, 'text', 'De instructie mag niet leeg zijn.')
    if (text.length > MAX_INSTRUCTION_LENGTH) {
      throw new HttpError(400, `De instructie mag maximaal ${MAX_INSTRUCTION_LENGTH} tekens zijn.`)
    }
    const current = await getInstruction(req.alias)
    if (current?.text === text) return ok(toView(current))
    return ok(toView(await save(req.alias, current, text, owner.id)))
  },

  'POST /ai-instruction/revert': async (req) => {
    const owner = await requireOwner(req)
    const current = await getInstruction(req.alias)
    const to = req.body.to
    if (to === 'default') {
      if (!current || current.text === DEFAULT_INSTRUCTION) return ok(toView(current))
      return ok(toView(await save(req.alias, current, DEFAULT_INSTRUCTION, owner.id)))
    }
    if (to === 'previous') {
      if (!current?.previous) throw new HttpError(409, 'Er is geen vorige versie om naar terug te zetten.')
      return ok(toView(await save(req.alias, current, current.previous.text, owner.id)))
    }
    throw new HttpError(400, 'Kies of je terugzet naar de vorige of de standaardversie.')
  },
})
