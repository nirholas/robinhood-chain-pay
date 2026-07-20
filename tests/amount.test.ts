import { describe, expect, it } from 'vitest'
import { parseUnits, formatUnits } from 'viem'

import { AmountError, displayUsdg, formatUsdg, parseUsdg } from '../src/core/amount.js'

describe('parseUsdg', () => {
  it('parses whole and fractional amounts to 6-decimal atomic units', () => {
    expect(parseUsdg('1')).toBe(1_000_000n)
    expect(parseUsdg('12.5')).toBe(12_500_000n)
    expect(parseUsdg('0.000001')).toBe(1n)
    expect(parseUsdg('0')).toBe(0n)
    expect(parseUsdg('1000000.123456')).toBe(1_000_000_123_456n)
  })

  it('agrees with viem parseUnits across a range of values', () => {
    for (const value of ['0', '0.1', '0.000001', '7', '123.456789', '99999999.999999']) {
      expect(parseUsdg(value)).toBe(parseUnits(value, 6))
    }
  })

  it('accepts bigint atomic units unchanged', () => {
    expect(parseUsdg(12_500_000n)).toBe(12_500_000n)
  })

  it('refuses more precision than USDG can represent, rather than truncating', () => {
    expect(() => parseUsdg('0.0000001')).toThrow(AmountError)
    expect(() => parseUsdg('1.1234567')).toThrow(/only 6/)
  })

  it('refuses negative, non-numeric, and exponential input', () => {
    expect(() => parseUsdg('-1')).toThrow(AmountError)
    expect(() => parseUsdg('abc')).toThrow(AmountError)
    expect(() => parseUsdg('1e-7')).toThrow(AmountError)
    expect(() => parseUsdg(1e-7)).toThrow(/exponential/)
    expect(() => parseUsdg(Number.NaN)).toThrow(/finite/)
    expect(() => parseUsdg(-1n)).toThrow(AmountError)
  })
})

describe('formatUsdg', () => {
  it('always emits six fractional digits', () => {
    expect(formatUsdg(12_500_000n)).toBe('12.500000')
    expect(formatUsdg(1n)).toBe('0.000001')
    expect(formatUsdg(0n)).toBe('0.000000')
  })

  it('agrees with viem formatUnits', () => {
    for (const atomic of [0n, 1n, 999_999n, 12_500_000n, 99_999_999_999_999n]) {
      expect(Number(formatUsdg(atomic))).toBe(Number(formatUnits(atomic, 6)))
    }
  })

  it('round-trips through parseUsdg', () => {
    for (const atomic of [0n, 1n, 42n, 12_500_000n, 1_000_000_123_456n]) {
      expect(parseUsdg(formatUsdg(atomic))).toBe(atomic)
    }
  })
})

describe('displayUsdg', () => {
  it('trims to a currency-like two decimals but never loses precision', () => {
    expect(displayUsdg(12_500_000n)).toBe('12.50')
    expect(displayUsdg(1_000_000n)).toBe('1.00')
    expect(displayUsdg(1n)).toBe('0.000001')
    expect(displayUsdg(1_234_567_000_000n)).toBe('1,234,567.00')
  })
})
