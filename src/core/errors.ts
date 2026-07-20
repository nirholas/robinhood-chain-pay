/**
 * Every failure mode hood-pay can produce, as a typed error with a stable
 * machine-readable `code`. The widget maps codes directly onto its designed
 * states, so adding a state and adding a code go together.
 */

export type HoodPayErrorCode =
  | 'config_invalid'
  | 'intent_not_found'
  | 'intent_expired'
  | 'intent_already_paid'
  | 'intent_canceled'
  | 'idempotency_conflict'
  | 'amount_mismatch'
  | 'recipient_mismatch'
  | 'asset_mismatch'
  | 'network_mismatch'
  | 'invalid_signature'
  | 'authorization_expired'
  | 'authorization_not_yet_valid'
  | 'authorization_already_used'
  | 'insufficient_funds'
  | 'wallet_not_found'
  | 'wallet_rejected'
  | 'wrong_chain'
  | 'relay_failed'
  | 'settlement_reverted'
  | 'receipt_mismatch'
  | 'webhook_signature_invalid'
  | 'network_error'

/** Base class for every error hood-pay throws. */
export class HoodPayError extends Error {
  override name = 'HoodPayError'
  readonly code: HoodPayErrorCode
  /** Extra context (intent id, expected/actual values). Safe to log. */
  readonly details: Readonly<Record<string, unknown>>

  constructor(code: HoodPayErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.code = code
    this.details = Object.freeze({ ...details })
  }

  /** JSON body shape returned by the merchant HTTP API for this error. */
  toJSON(): { error: { code: HoodPayErrorCode; message: string; details: Record<string, unknown> } } {
    return { error: { code: this.code, message: this.message, details: { ...this.details } } }
  }
}

/** The caller wired hood-pay up wrong. Not a payment failure. */
export class ConfigError extends HoodPayError {
  override name = 'ConfigError'
  constructor(message: string, details?: Record<string, unknown>) {
    super('config_invalid', message, details)
  }
}

/** No payment intent with that id (or it belongs to a different merchant). */
export class IntentNotFoundError extends HoodPayError {
  override name = 'IntentNotFoundError'
  constructor(id: string) {
    super('intent_not_found', `hood-pay: no payment intent with id "${id}"`, { intentId: id })
  }
}

/** The intent's `expiresAt` has passed. Create a new one. */
export class IntentExpiredError extends HoodPayError {
  override name = 'IntentExpiredError'
  constructor(id: string, expiresAt: number) {
    super('intent_expired', `hood-pay: payment intent "${id}" expired at ${new Date(expiresAt * 1000).toISOString()}`, {
      intentId: id,
      expiresAt,
    })
  }
}

/**
 * `createIntent` was called twice with the same idempotency key but different
 * parameters. Stripe's semantics: the key is a promise that the request is the
 * same request, and breaking that promise is an error, not a silent overwrite.
 */
export class IdempotencyConflictError extends HoodPayError {
  override name = 'IdempotencyConflictError'
  constructor(key: string, existingIntentId: string) {
    super(
      'idempotency_conflict',
      `hood-pay: idempotency key "${key}" was already used for intent "${existingIntentId}" with different parameters`,
      { idempotencyKey: key, existingIntentId },
    )
  }
}

/** The browser found no EIP-1193 wallet to sign with. */
export class WalletNotFoundError extends HoodPayError {
  override name = 'WalletNotFoundError'
  constructor() {
    super('wallet_not_found', 'hood-pay: no Ethereum wallet found in this browser')
  }
}

/** The customer dismissed the wallet prompt (EIP-1193 code 4001). */
export class WalletRejectedError extends HoodPayError {
  override name = 'WalletRejectedError'
  constructor(message = 'hood-pay: the customer rejected the signature request') {
    super('wallet_rejected', message)
  }
}

/** The wallet is on the wrong chain and would not (or could not) switch. */
export class WrongChainError extends HoodPayError {
  override name = 'WrongChainError'
  constructor(expected: number, actual: number | null) {
    super(
      'wrong_chain',
      `hood-pay: wallet is on chain ${actual ?? 'unknown'} but this payment requires chain ${expected}`,
      { expectedChainId: expected, actualChainId: actual },
    )
  }
}

/** The payer's USDG balance is below the amount due. */
export class InsufficientFundsError extends HoodPayError {
  override name = 'InsufficientFundsError'
  constructor(required: bigint, available: bigint) {
    super('insufficient_funds', 'hood-pay: the payer does not hold enough USDG for this payment', {
      required: required.toString(),
      available: available.toString(),
    })
  }
}

/** Relaying the authorization on-chain failed. */
export class RelayError extends HoodPayError {
  override name = 'RelayError'
  constructor(message: string, details?: Record<string, unknown>) {
    super('relay_failed', message, details)
  }
}

/** An HTTP call to the merchant API failed at the transport layer. */
export class NetworkError extends HoodPayError {
  override name = 'NetworkError'
  constructor(message: string, details?: Record<string, unknown>) {
    super('network_error', message, details)
  }
}

/**
 * Turn an unknown thrown value into a `HoodPayError`.
 *
 * The wallet's own numeric EIP-1193 code is preserved in `details.walletCode`.
 * Callers that need to branch on it (adding an unknown chain on 4902, for
 * instance) can still reach it after wrapping, which a plain re-throw of a
 * generic Error would have destroyed.
 */
export function toHoodPayError(err: unknown, fallbackCode: HoodPayErrorCode = 'network_error'): HoodPayError {
  if (err instanceof HoodPayError) return err
  const asObj = err as { code?: unknown; message?: unknown } | null
  // EIP-1193: 4001 is "user rejected request".
  if (asObj && (asObj.code === 4001 || asObj.code === 'ACTION_REJECTED')) {
    return new WalletRejectedError()
  }
  const message = err instanceof Error ? err.message : String(err)
  const walletCode = asObj && typeof asObj.code === 'number' ? asObj.code : undefined
  return new HoodPayError(
    fallbackCode,
    message,
    walletCode !== undefined ? { walletCode } : {},
  )
}

/** Read the underlying EIP-1193 code from an error, wrapped or not. */
export function walletErrorCode(err: unknown): number | undefined {
  if (err instanceof HoodPayError) {
    const code = err.details['walletCode']
    return typeof code === 'number' ? code : undefined
  }
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'number' ? code : undefined
}
