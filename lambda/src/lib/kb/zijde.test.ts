import { describe, expect, it } from 'vitest'
import { zijdeOf } from './zijde'

describe('zijdeOf', () => {
  it('puts the lowest startnummer on the right at equal afstand', () => {
    expect(zijdeOf('2026-07-01', 'roden', { startnr: 3, afstand: 300 }, { startnr: 8, afstand: 300 })).toEqual({ a: 'rechts', b: 'links' })
    expect(zijdeOf('2026-07-01', 'roden', { startnr: 9, afstand: 300 }, { startnr: 2, afstand: 300 })).toEqual({ a: 'links', b: 'rechts' })
  })

  it('falls back to the koppel order without startnummers', () => {
    expect(zijdeOf('2025-06-01', 'lisse', { startnr: null, afstand: 300 }, { startnr: 4, afstand: 300 })).toEqual({ a: 'rechts', b: 'links' })
  })

  it('leaves the zijde unknown at unequal afstand or without an opponent', () => {
    expect(zijdeOf('2026-07-01', 'roden', { startnr: 1, afstand: 300 }, { startnr: 2, afstand: 310 })).toEqual({ a: null, b: null })
    expect(zijdeOf('2026-07-01', 'roden', { startnr: 1, afstand: null }, { startnr: 2, afstand: null })).toEqual({ a: null, b: null })
    expect(zijdeOf('2026-07-01', 'roden', { startnr: 1, afstand: 300 }, undefined)).toEqual({ a: null, b: null })
  })

  it('applies the rule before 2025 only in Medemblik', () => {
    expect(zijdeOf('2024-08-01', 'roden', { startnr: 1, afstand: 300 }, { startnr: 2, afstand: 300 })).toEqual({ a: null, b: null })
    expect(zijdeOf('2023-08-01', 'medemblik', { startnr: 1, afstand: 300 }, { startnr: 2, afstand: 300 })).toEqual({ a: 'rechts', b: 'links' })
  })
})
