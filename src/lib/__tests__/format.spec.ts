import { describe, expect, it } from 'vitest'
import { parseEuro } from '../format'

describe('parseEuro', () => {
  it.each([
    ['50', 50],
    ['12,50', 12.5],
    ['€ 7.5', 7.5],
    [' 0 ', 0],
  ])('reads %j as %d', (input, expected) => {
    expect(parseEuro(input)).toBe(expected)
  })

  it.each(['', 'abc', '-5', '1,234', '10,5,0', '€'])('rejects %j', (input) => {
    expect(parseEuro(input)).toBeNull()
  })
})
