/**
 * Payment intents: creation, id derivation, and the lifecycle state machine.
 *
 * An intent is the unit of a human checkout. It is created by the merchant
 * before the customer ever opens a wallet, it carries the exact amount and
 * recipient the customer will later sign over, and it expires. Everything
 * downstream (the hosted page, the widget, the relay, the receipt, the
 * webhook) is a projection of one intent.
 */

import { formatUsdg, parseUsdg } from './amount.js'
import { ConfigError, HoodPayError } from './errors.js'
import { randomId, sha256Hex } from './hash.js'
import { requireNetwork, type Address } from './networks.js'
import type {
  CreateIntentParams,
  IntentStatus,
  PaymentIntent,
  PaymentIntentWire,
} from './types.js'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/** Default lifetime of an intent when the merchant does not specify one. */
export const DEFAULT_EXPIRY_SECONDS = 900
/** Shortest lifetime accepted. Below this a customer cannot realistically pay. */
export const MIN_EXPIRY_SECONDS = 60
/** Longest lifetime accepted. Beyond a day, create a fresh intent instead. */
export const MAX_EXPIRY_SECONDS = 86_400
/** Maximum number of metadata entries. */
export const MAX_METADATA_KEYS = 30
/** Maximum length of a single metadata value. */
export const MAX_METADATA_VALUE_LENGTH = 500

/** Which status transitions the state machine permits. */
const TRANSITIONS: Record<IntentStatus, readonly IntentStatus[]> = {
  requires_payment: ['processing', 'canceled', 'expired'],
  // A relay attempt can fail before broadcasting, which returns the intent to
  // `failed` (retryable), or confirm, which is terminal.
  processing: ['succeeded', 'failed'],
  succeeded: [],
  failed: ['processing', 'canceled', 'expired'],
  canceled: [],
  expired: [],
}

/** Statuses from which no further transition is possible. */
export const TERMINAL_STATUSES: readonly IntentStatus[] = ['succeeded', 'canceled', 'expired']

/** Whether `from -> to` is a legal lifecycle transition. */
export function canTransition(from: IntentStatus, to: IntentStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/** Assert a legal transition, throwing a descriptive `HoodPayError` otherwise. */
export function assertTransition(intentId: string, from: IntentStatus, to: IntentStatus): void {
  if (canTransition(from, to)) return
  const code = from === 'succeeded' ? 'intent_already_paid' : from === 'canceled' ? 'intent_canceled' : from === 'expired' ? 'intent_expired' : 'config_invalid'
  throw new HoodPayError(
    code,
    `hood-pay: payment intent "${intentId}" is ${from} and cannot move to ${to}`,
    { intentId, from, to },
  )
}

/** Whether an intent can still accept a customer authorization at `now`. */
export function isPayable(intent: PaymentIntent, now: number): boolean {
  if (intent.status !== 'requires_payment' && intent.status !== 'failed') return false
  return now < intent.expiresAt
}

/**
 * The intent's status as of `now`, folding in expiry. Stored status is only
 * updated by an explicit sweep or a write path, so readers use this to avoid
 * showing "requires_payment" for an intent whose deadline has passed.
 */
export function effectiveStatus(intent: PaymentIntent, now: number): IntentStatus {
  if ((intent.status === 'requires_payment' || intent.status === 'failed') && now >= intent.expiresAt) {
    return 'expired'
  }
  return intent.status
}

function validateAddress(value: string, field: string): Address {
  if (!ADDRESS_RE.test(value)) {
    throw new ConfigError(`hood-pay: ${field} must be a 0x-prefixed 20-byte address, got "${value}"`)
  }
  return value as Address
}

function validateUrl(value: string, field: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`hood-pay: ${field} must be an absolute URL, got "${value}"`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(
      `hood-pay: ${field} must use http or https, got "${url.protocol}". Other schemes are refused because this URL is used as a redirect target.`,
    )
  }
  return url.toString()
}

function validateMetadata(metadata: Record<string, string>): Record<string, string> {
  const keys = Object.keys(metadata)
  if (keys.length > MAX_METADATA_KEYS) {
    throw new ConfigError(
      `hood-pay: metadata has ${keys.length} keys, the maximum is ${MAX_METADATA_KEYS}`,
    )
  }
  const out: Record<string, string> = {}
  for (const key of keys.sort()) {
    const value = metadata[key]
    if (typeof value !== 'string') {
      throw new ConfigError(`hood-pay: metadata."${key}" must be a string`)
    }
    if (value.length > MAX_METADATA_VALUE_LENGTH) {
      throw new ConfigError(
        `hood-pay: metadata."${key}" is ${value.length} characters, the maximum is ${MAX_METADATA_VALUE_LENGTH}`,
      )
    }
    out[key] = value
  }
  return out
}

/**
 * Canonical encoding of metadata: keys sorted, each entry length-prefixed so
 * that `{a: 'b|c'}` and `{'a|b': 'c'}` cannot collide.
 */
export function canonicalMetadata(metadata: Record<string, string>): string {
  return Object.keys(metadata)
    .sort()
    .map((k) => `${k.length}:${k}=${(metadata[k] ?? '').length}:${metadata[k] ?? ''}`)
    .join('&')
}

/**
 * A fingerprint of the economically meaningful parameters of a create request.
 * Two `createIntent` calls sharing an idempotency key must agree on this, or
 * the second one is a bug in the caller and is rejected.
 */
export async function intentFingerprint(params: {
  merchantId: string
  amount: bigint
  payTo: string
  network: string
  description: string
  metadata: Record<string, string>
}): Promise<string> {
  return sha256Hex(
    [
      'hood-pay/intent-fingerprint/v1',
      params.merchantId,
      params.amount.toString(),
      params.payTo.toLowerCase(),
      params.network,
      params.description,
      canonicalMetadata(params.metadata),
    ].join('|'),
  )
}

/**
 * Derive a payment intent id.
 *
 * With an idempotency key the id is a deterministic function of
 * `(merchantId, key)`, so a retried create request lands on the same row even
 * if the first response was lost in flight. Without one, the id is 16 random
 * bytes.
 */
export async function deriveIntentId(merchantId: string, idempotencyKey?: string): Promise<string> {
  if (!idempotencyKey) return `pi_${randomId(16)}`
  const digest = await sha256Hex(`hood-pay/intent-id/v1|${merchantId}|${idempotencyKey}`)
  return `pi_${digest.slice(2, 34)}`
}

export interface CreateIntentContext {
  /** Merchant id used when the caller does not pass one. */
  defaultMerchantId?: string
  /** Unix seconds. Injectable for deterministic tests. */
  now?: number
}

/**
 * Build a payment intent. Pure: it performs no I/O and touches no store, so
 * the same function is used by the merchant server, by tests, and by anything
 * that wants to preview an intent before persisting it.
 */
export async function createIntent(
  params: CreateIntentParams,
  ctx: CreateIntentContext = {},
): Promise<PaymentIntent> {
  const now = ctx.now ?? Math.floor(Date.now() / 1000)
  const merchantId = params.merchantId ?? ctx.defaultMerchantId ?? 'default'
  const net = requireNetwork(params.network ?? 'robinhood')

  const amount = parseUsdg(params.amount)
  if (amount <= 0n) {
    throw new ConfigError('hood-pay: amount must be greater than zero')
  }

  const payTo = validateAddress(params.payTo, 'payTo')
  const description = params.description ?? ''
  if (description.length > 500) {
    throw new ConfigError('hood-pay: description must be 500 characters or fewer')
  }
  const metadata = validateMetadata(params.metadata ?? {})

  const ttl = params.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS
  if (!Number.isInteger(ttl) || ttl < MIN_EXPIRY_SECONDS || ttl > MAX_EXPIRY_SECONDS) {
    throw new ConfigError(
      `hood-pay: expiresInSeconds must be an integer between ${MIN_EXPIRY_SECONDS} and ${MAX_EXPIRY_SECONDS}, got ${ttl}`,
    )
  }

  const id = await deriveIntentId(merchantId, params.idempotencyKey)

  const intent: PaymentIntent = {
    object: 'payment_intent',
    id,
    merchantId,
    status: 'requires_payment',
    amount,
    network: net.id,
    chainId: net.chainId,
    asset: net.usdg,
    payTo,
    description,
    metadata,
    createdAt: now,
    expiresAt: now + ttl,
    ...(params.idempotencyKey !== undefined ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(params.successUrl !== undefined ? { successUrl: validateUrl(params.successUrl, 'successUrl') } : {}),
    ...(params.cancelUrl !== undefined ? { cancelUrl: validateUrl(params.cancelUrl, 'cancelUrl') } : {}),
  }
  return intent
}

/** Serialize an intent for the wire (bigints become decimal strings). */
export function serializeIntent(intent: PaymentIntent, now?: number): PaymentIntentWire {
  const status = now === undefined ? intent.status : effectiveStatus(intent, now)
  const { blockNumber, ...rest } = intent
  return {
    ...rest,
    object: 'payment_intent',
    status,
    amount: intent.amount.toString(),
    amountFormatted: formatUsdg(intent.amount),
    ...(blockNumber !== undefined ? { blockNumber: blockNumber.toString() } : {}),
  }
}

/** Parse a wire intent back into bigint fields. */
export function deserializeIntent(wire: PaymentIntentWire): PaymentIntent {
  const { amountFormatted: _amountFormatted, blockNumber, ...rest } = wire
  return {
    ...rest,
    object: 'payment_intent',
    amount: BigInt(wire.amount),
    ...(blockNumber !== undefined ? { blockNumber: BigInt(blockNumber) } : {}),
  }
}
