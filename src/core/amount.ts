/**
 * USDG amount handling.
 *
 * The rule for the whole package: **amounts are `bigint` atomic units end to
 * end**. Decimal strings exist only at the two boundaries where a human reads
 * or writes one (a merchant calling `createIntent({ amount: '12.50' })`, and a
 * UI rendering `$12.50`). Nothing in between ever sees a float.
 *
 * These parsers are hand-written rather than delegating to viem's
 * `parseUnits`/`formatUnits` because this module is imported by the browser
 * bundle, which must not depend on viem. They are pure string/bigint math with
 * no rounding: an input with more than 6 decimal places is an error, never a
 * silent truncation.
 */

/** USDG has 6 decimals on both Robinhood Chain networks. */
export const USDG_DECIMALS = 6

/** Thrown when a human-readable amount cannot be represented exactly in USDG. */
export class AmountError extends Error {
  override name = 'AmountError'
}

const AMOUNT_RE = /^(\d+)(?:\.(\d+))?$/

/**
 * Parse a decimal USDG string into atomic units.
 *
 * ```ts
 * parseUsdg('12.5')   // 12500000n
 * parseUsdg('0.000001') // 1n
 * ```
 *
 * @throws {AmountError} on a negative, non-numeric, or over-precise input.
 */
export function parseUsdg(amount: string | number | bigint, decimals = USDG_DECIMALS): bigint {
  if (typeof amount === 'bigint') {
    if (amount < 0n) throw new AmountError('hood-pay: amount must not be negative')
    return amount
  }
  const raw = typeof amount === 'number' ? numberToDecimalString(amount) : amount.trim()
  const match = AMOUNT_RE.exec(raw)
  if (!match) {
    throw new AmountError(
      `hood-pay: "${raw}" is not a valid USDG amount (expected a non-negative decimal like "12.50")`,
    )
  }
  const whole = match[1] ?? '0'
  const frac = match[2] ?? ''
  if (frac.length > decimals) {
    throw new AmountError(
      `hood-pay: "${raw}" has ${frac.length} decimal places but USDG has only ${decimals}. Round before charging; hood-pay will not silently truncate.`,
    )
  }
  return BigInt(whole + frac.padEnd(decimals, '0'))
}

/**
 * Format atomic units as a decimal string. Always emits exactly `decimals`
 * fractional digits so amounts line up in a column and never look truncated.
 *
 * ```ts
 * formatUsdg(12500000n) // '12.500000'
 * ```
 */
export function formatUsdg(atomic: bigint, decimals = USDG_DECIMALS): string {
  if (atomic < 0n) throw new AmountError('hood-pay: amount must not be negative')
  const s = atomic.toString().padStart(decimals + 1, '0')
  const cut = s.length - decimals
  return `${s.slice(0, cut)}.${s.slice(cut)}`
}

/**
 * Format atomic units for display: trims trailing zeros past two decimals, so
 * `12500000n` renders as `12.50` and `1n` as `0.000001`.
 */
export function displayUsdg(atomic: bigint, decimals = USDG_DECIMALS): string {
  const full = formatUsdg(atomic, decimals)
  const [whole = '0', frac = ''] = full.split('.')
  const trimmed = frac.replace(/0+$/, '')
  const padded = trimmed.length < 2 ? trimmed.padEnd(2, '0') : trimmed
  return `${withThousands(whole)}.${padded}`
}

function withThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Convert a JS number to an exact decimal string, rejecting anything that is
 * not finite. Numbers are accepted as a convenience at the API boundary, but
 * exponential notation and non-finite values are refused rather than guessed
 * at.
 */
function numberToDecimalString(n: number): string {
  if (!Number.isFinite(n)) {
    throw new AmountError('hood-pay: amount must be a finite number')
  }
  const s = String(n)
  if (s.includes('e') || s.includes('E')) {
    throw new AmountError(
      `hood-pay: amount ${s} uses exponential notation. Pass a decimal string instead, e.g. "0.000001".`,
    )
  }
  return s
}
