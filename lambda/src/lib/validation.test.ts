import { describe, expect, it } from 'vitest'
import { assertDailyLimit, assertName, assertPassword, normalizeUsername } from './validation'

describe('validation', () => {
  it('requires passwords of at least 10 characters', () => {
    expect(() => assertPassword('kort')).toThrow(/10 tekens/)
    expect(assertPassword('lang-genoeg')).toBe('lang-genoeg')
  })

  it('lowercases usernames and rejects odd characters', () => {
    expect(normalizeUsername(' Jan.Draf ')).toBe('jan.draf')
    expect(() => normalizeUsername('ja')).toThrow(/3 tot 30/)
    expect(() => normalizeUsername('jan draf')).toThrow(/3 tot 30/)
  })

  it('trims names and caps their length', () => {
    expect(assertName('  Kees ')).toBe('Kees')
    expect(() => assertName('')).toThrow('Vul een naam in.')
    expect(() => assertName('x'.repeat(41))).toThrow(/korter dan 40/)
  })

  it('accepts null or a whole number as daily limit', () => {
    expect(assertDailyLimit(null)).toBeNull()
    expect(assertDailyLimit(5)).toBe(5)
    expect(() => assertDailyLimit(-1)).toThrow(/daglimiet/)
    expect(() => assertDailyLimit(2.5)).toThrow(/daglimiet/)
  })
})
