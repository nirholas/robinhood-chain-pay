import type { Address, Hex } from './networks.js'
import type { HoodPayErrorCode } from './errors.js'

/**
 * The lifecycle of a hood-pay payment.
 *
 * ```
 *                    ┌──────────────┐
 *   createIntent ──▶ │ requires_    │ ──▶ canceled
 *                    │ payment      │ ──▶ expired
 *                    └──────┬───────┘
 *        customer signs     │
 *        + relay claimed    ▼
 *                    ┌──────────────┐
 *                    │ processing   │
 *                    └───┬──────┬───┘
 *       receipt.status=1 │      │ revert / relay error
 *                        ▼      ▼
 *                  succeeded   failed ──▶ processing (retry)
 * ```
 *
 * `succeeded`, `canceled`, and `expired` are terminal. `failed` is retryable:
 * a reverted `transferWithAuthorization` does not consume the EIP-3009 nonce,
 * so the same intent can be paid again once the payer tops up.
 */
export type IntentStatus =
  | 'requires_payment'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'expired'

/** The EIP-3009 authorization the customer signs. Numeric fields are bigint. */
export interface Authorization {
  from: Address
  to: Address
  value: bigint
  validAfter: bigint
  validBefore: bigint
  nonce: Hex
}

/** JSON-safe form of {@link Authorization} (all numerics as decimal strings). */
export interface AuthorizationWire {
  from: Address
  to: Address
  value: string
  validAfter: string
  validBefore: string
  nonce: Hex
}

/** A signed authorization, as posted to the relay endpoint. */
export interface SignedAuthorization {
  authorization: AuthorizationWire
  /** 65-byte EIP-712 signature over the authorization. */
  signature: Hex
}

/** Parameters a merchant supplies when creating a payment intent. */
export interface CreateIntentParams {
  /** Amount due. A decimal USDG string (`'12.50'`) or atomic units as bigint. */
  amount: string | number | bigint
  /** Address that receives the USDG. */
  payTo: Address
  /** Network id or alias. Defaults to `'robinhood'`. */
  network?: string
  /** What the customer is buying. Shown on the hosted checkout page. */
  description?: string
  /** Free-form string map echoed on the intent, the receipt, and webhooks. */
  metadata?: Record<string, string>
  /** Seconds until the intent expires. Defaults to 900 (15 minutes). */
  expiresInSeconds?: number
  /**
   * Repeat-safe creation key. Calling `createIntent` twice with the same key
   * returns the same intent instead of creating a second one. Reusing a key
   * with different parameters raises `IdempotencyConflictError`.
   */
  idempotencyKey?: string
  /** Where to send the customer after a successful payment. */
  successUrl?: string
  /** Where to send the customer if they abandon checkout. */
  cancelUrl?: string
  /** Merchant-side identifier, useful when one server serves several stores. */
  merchantId?: string
}

/** A payment intent: one amount, owed once, to one address, before one deadline. */
export interface PaymentIntent {
  readonly object: 'payment_intent'
  /** `pi_` + 32 lowercase hex characters. */
  id: string
  merchantId: string
  status: IntentStatus
  /** Amount due in USDG atomic units (6 decimals). */
  amount: bigint
  /** Canonical network id, e.g. `'robinhood'`. */
  network: string
  chainId: number
  /** USDG token address on `network`. */
  asset: Address
  payTo: Address
  description: string
  metadata: Record<string, string>
  /** Unix seconds. */
  createdAt: number
  /** Unix seconds. After this, the intent will not accept an authorization. */
  expiresAt: number
  idempotencyKey?: string
  successUrl?: string
  cancelUrl?: string

  /** Set once a customer's authorization has been accepted. */
  payer?: Address
  /** The accepted authorization, retained for audit and receipt building. */
  authorization?: AuthorizationWire
  /** Settlement transaction hash. */
  txHash?: Hex
  /** Block the settlement landed in. */
  blockNumber?: bigint
  /** Unix seconds the settlement confirmed. */
  settledAt?: number
  /** Why the last attempt failed. */
  failureCode?: HoodPayErrorCode
  failureMessage?: string
}

/** JSON-safe wire form of a {@link PaymentIntent}. */
export interface PaymentIntentWire
  extends Omit<PaymentIntent, 'amount' | 'blockNumber' | 'object'> {
  object: 'payment_intent'
  /** Atomic units as a decimal string. */
  amount: string
  /** Human-readable amount, e.g. `'12.50'`. Derived, never authoritative. */
  amountFormatted: string
  blockNumber?: string
}

/**
 * A verifiable payment receipt. Everything a third party needs to confirm the
 * payment independently, with nothing but an RPC URL.
 */
export interface PaymentReceipt {
  readonly object: 'payment_receipt'
  /** Receipt format version. Bumped only on a breaking field change. */
  version: 1
  intentId: string
  merchantId: string
  network: string
  chainId: number
  asset: Address
  from: Address
  to: Address
  /** Atomic units. */
  amount: bigint
  nonce: Hex
  validAfter: bigint
  validBefore: bigint
  txHash: Hex
  blockNumber: bigint
  /** Unix seconds. */
  settledAt: number
  /** SHA-256 over the canonical metadata encoding, binding metadata to the receipt. */
  metadataHash: Hex
  /** SHA-256 over {@link canonicalReceipt}. A short, quotable payment fingerprint. */
  digest: Hex
}

/** JSON-safe wire form of a {@link PaymentReceipt}. */
export interface PaymentReceiptWire
  extends Omit<
    PaymentReceipt,
    'amount' | 'validAfter' | 'validBefore' | 'blockNumber' | 'object'
  > {
  object: 'payment_receipt'
  amount: string
  amountFormatted: string
  validAfter: string
  validBefore: string
  blockNumber: string
}

/** Chain facts the browser needs, delivered with the checkout session. */
export interface NetworkDescriptor {
  id: string
  chainId: number
  /** `eth_chainId` form, e.g. `'0x1237'`. */
  chainIdHex: string
  label: string
  rpcUrl: string
  explorerUrl: string
  usdg: Address
  usdgDecimals: number
  usdgDomain: { name: string; version: string }
  testnet: boolean
}

/**
 * Everything a browser needs to render checkout and produce a signature. This
 * is the JSON body of `GET /api/intents/:id`, and the only server response the
 * widget and the client SDK depend on.
 */
export interface CheckoutSession {
  intent: PaymentIntentWire
  network: NetworkDescriptor
  /** Lifetime to stamp into a fresh authorization, in seconds. */
  authorizationValiditySeconds: number
  receipt?: PaymentReceiptWire
  /** Explorer link for a settled payment. */
  explorerTxUrl?: string
}

/** JSON body of a successful `POST /api/intents/:id/pay`. */
export interface PayResponse {
  intent: PaymentIntentWire
  receipt?: PaymentReceiptWire
  explorerTxUrl?: string
}

/** JSON body of any hood-pay error response. */
export interface ErrorResponse {
  error: {
    code: string
    message: string
    details: Record<string, unknown>
  }
}

/** Event names emitted to merchant webhooks. */
export type WebhookEventType =
  | 'payment_intent.created'
  | 'payment_intent.processing'
  | 'payment_intent.succeeded'
  | 'payment_intent.failed'
  | 'payment_intent.expired'
  | 'payment_intent.canceled'

/** The JSON body delivered to a merchant webhook endpoint. */
export interface WebhookEvent {
  readonly object: 'event'
  /** `evt_` + 32 lowercase hex characters. */
  id: string
  type: WebhookEventType
  /** Unix seconds the event was created. */
  created: number
  data: {
    intent: PaymentIntentWire
    receipt?: PaymentReceiptWire
  }
}
