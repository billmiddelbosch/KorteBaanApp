import { describe, expect, it } from 'vitest'
import type { Context } from 'aws-lambda'
import { aliasOf, corsOrigin } from './http'

const ctx = (arn: string) => ({ invokedFunctionArn: arn }) as Context
const ARN = 'arn:aws:lambda:eu-west-2:123456789012:function:kortebaan-health'

describe('aliasOf', () => {
  it('reads the alias from the invoked ARN', () => {
    expect(aliasOf(ctx(`${ARN}:prod`))).toBe('prod')
    expect(aliasOf(ctx(`${ARN}:dev`))).toBe('dev')
  })

  it('treats an unqualified ARN as dev', () => {
    expect(aliasOf(ctx(ARN))).toBe('dev')
  })
})

describe('corsOrigin', () => {
  it('echoes allowed prod origins', () => {
    expect(corsOrigin('prod', 'https://www.kortebaan.nl')).toBe('https://www.kortebaan.nl')
    expect(corsOrigin('prod', 'https://kortebaan.aintern.nl')).toBe('https://kortebaan.aintern.nl')
  })

  it('never lets prod answer localhost or the test site', () => {
    expect(corsOrigin('prod', 'http://localhost:5173')).toBe('https://kortebaan.nl')
    expect(corsOrigin('prod', 'https://test.kortebaan.nl')).toBe('https://kortebaan.nl')
    expect(corsOrigin('prod', 'https://test.kortebaan.aintern.nl')).toBe('https://kortebaan.nl')
  })

  it('serves both the test site and localhost on dev', () => {
    expect(corsOrigin('dev', 'http://localhost:5173')).toBe('http://localhost:5173')
    expect(corsOrigin('dev', 'https://test.kortebaan.nl')).toBe('https://test.kortebaan.nl')
    expect(corsOrigin('dev', 'https://evil.example')).toBe('https://test.kortebaan.nl')
  })
})
