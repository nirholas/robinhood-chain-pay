/**
 * Persistence contract for a hood-pay merchant server, plus an in-memory
 * implementation.
 *
 * The interface is deliberately small and deliberately opinionated about
 * atomicity: `createIntent` and `claimRelay` are compare-and-set operations,
 * not read-then-write pairs. Everything that protects a customer from being
 * charged twice reduces to those two methods being atomic in the backing
 * store, so they are the only place a race can hide.
 */

import type { HoodPayErrorCode } from '../core/errors.js'
import { IdempotencyConflictError } from '../core/errors.js'
import type {
  AuthorizationWire,
  PaymentIntent,
  PaymentReceipt,
  WebhookEvent,
} from '../core/types.js'
import type { Address, Hex } from '../core/networks.js'

/** Fields a write path may update on an intent. */
export interface IntentPatch {
  status?: PaymentIntent['status']
  payer?: Address
  authorization?: AuthorizationWire
  txHash?: Hex
  blockNumber?: bigint
  settledAt?: number
  failureCode?: HoodPayErrorCode
  failureMessage?: string
}

/** Outcome of an idempotent intent creation. */
export interface CreateResult {
  intent: PaymentIntent
  /** `false` when an intent with this id already existed (idempotent replay). */
  created: boolean
}

/** Outcome of an attempt to take ownership of relaying a payment. */
export type ClaimResult =
  | { claimed: true; intent: PaymentIntent }
  | { claimed: false; reason: 'not_found' | 'already_processing' | 'already_paid' | 'expired' | 'terminal'; intent?: PaymentIntent }

/** A webhook delivery attempt, retained for audit and replay. */
export interface WebhookDelivery {
  id: string
  intentId: string
  eventType: WebhookEvent['type']
  url: string
  /** HTTP status of the last attempt, or `null` if the request never completed. */
  status: number | null
  attempts: number
  /** Error text of the last failed attempt. */
  error: string | null
  createdAt: number
  updatedAt: number
  delivered: boolean
}

export interface ListIntentsOptions {
  merchantId?: string
  status?: PaymentIntent['status']
  limit?: number
}

/**
 * The storage contract. Implement this to put hood-pay on Postgres, Redis, or
 * whatever a merchant already runs. Two shipped implementations satisfy it:
 * {@link MemoryStore} and `SqliteStore` from `hood-pay/server`.
 */
export interface PaymentStore {
  /**
   * Insert an intent, or return the existing one when its id is already
   * present. The id is derived from the idempotency key, so a retried create
   * lands on the same row.
   *
   * @param fingerprint Hash of the economically meaningful parameters. When an
   *   intent already exists with a different fingerprint, implementations must
   *   throw {@link IdempotencyConflictError}.
   */
  createIntent(intent: PaymentIntent, fingerprint: string): Promise<CreateResult>

  getIntent(id: string): Promise<PaymentIntent | undefined>

  /** Apply a patch. Throws if the intent does not exist. */
  updateIntent(id: string, patch: IntentPatch): Promise<PaymentIntent>

  /**
   * Atomically move an intent from `requires_payment`/`failed` to
   * `processing`, recording the payer and the authorization. Exactly one
   * concurrent caller may succeed. This is the double-charge guard.
   */
  claimRelay(
    id: string,
    payer: Address,
    authorization: AuthorizationWire,
    now: number,
  ): Promise<ClaimResult>

  /** Mark expired every payable intent whose deadline has passed. Returns them. */
  expireDue(now: number): Promise<PaymentIntent[]>

  listIntents(options?: ListIntentsOptions): Promise<PaymentIntent[]>

  saveReceipt(receipt: PaymentReceipt): Promise<void>
  getReceipt(intentId: string): Promise<PaymentReceipt | undefined>

  recordWebhookDelivery(delivery: WebhookDelivery): Promise<void>
  listWebhookDeliveries(intentId: string): Promise<WebhookDelivery[]>

  close(): Promise<void>
}

function clone(intent: PaymentIntent): PaymentIntent {
  return { ...intent, metadata: { ...intent.metadata } }
}

function applyPatch(intent: PaymentIntent, patch: IntentPatch): PaymentIntent {
  const next: PaymentIntent = clone(intent)
  if (patch.status !== undefined) next.status = patch.status
  if (patch.payer !== undefined) next.payer = patch.payer
  if (patch.authorization !== undefined) next.authorization = { ...patch.authorization }
  if (patch.txHash !== undefined) next.txHash = patch.txHash
  if (patch.blockNumber !== undefined) next.blockNumber = patch.blockNumber
  if (patch.settledAt !== undefined) next.settledAt = patch.settledAt
  if (patch.failureCode !== undefined) next.failureCode = patch.failureCode
  if (patch.failureMessage !== undefined) next.failureMessage = patch.failureMessage
  return next
}

/**
 * In-memory store. Real behaviour, no persistence: it is the store the test
 * suite runs against and a reasonable choice for a single-process demo. It is
 * not a mock, it implements the contract exactly, including the atomicity
 * guarantees (which hold because each critical section runs to completion
 * without awaiting).
 */
export class MemoryStore implements PaymentStore {
  private readonly intents = new Map<string, PaymentIntent>()
  private readonly fingerprints = new Map<string, string>()
  private readonly receipts = new Map<string, PaymentReceipt>()
  private readonly deliveries = new Map<string, WebhookDelivery[]>()

  async createIntent(intent: PaymentIntent, fingerprint: string): Promise<CreateResult> {
    const existing = this.intents.get(intent.id)
    if (existing) {
      const seen = this.fingerprints.get(intent.id)
      if (seen !== fingerprint && intent.idempotencyKey) {
        throw new IdempotencyConflictError(intent.idempotencyKey, existing.id)
      }
      return { intent: clone(existing), created: false }
    }
    this.intents.set(intent.id, clone(intent))
    this.fingerprints.set(intent.id, fingerprint)
    return { intent: clone(intent), created: true }
  }

  async getIntent(id: string): Promise<PaymentIntent | undefined> {
    const found = this.intents.get(id)
    return found ? clone(found) : undefined
  }

  async updateIntent(id: string, patch: IntentPatch): Promise<PaymentIntent> {
    const existing = this.intents.get(id)
    if (!existing) throw new Error(`hood-pay: cannot update unknown intent "${id}"`)
    const next = applyPatch(existing, patch)
    this.intents.set(id, next)
    return clone(next)
  }

  async claimRelay(
    id: string,
    payer: Address,
    authorization: AuthorizationWire,
    now: number,
  ): Promise<ClaimResult> {
    // No `await` between the read and the write: this critical section is
    // atomic with respect to other JavaScript tasks on this thread.
    const existing = this.intents.get(id)
    if (!existing) return { claimed: false, reason: 'not_found' }
    if (existing.status === 'succeeded') {
      return { claimed: false, reason: 'already_paid', intent: clone(existing) }
    }
    if (existing.status === 'processing') {
      return { claimed: false, reason: 'already_processing', intent: clone(existing) }
    }
    if (existing.status === 'canceled' || existing.status === 'expired') {
      return { claimed: false, reason: 'terminal', intent: clone(existing) }
    }
    if (now >= existing.expiresAt) {
      const expired = applyPatch(existing, { status: 'expired' })
      this.intents.set(id, expired)
      return { claimed: false, reason: 'expired', intent: clone(expired) }
    }
    const next = applyPatch(existing, { status: 'processing', payer, authorization })
    this.intents.set(id, next)
    return { claimed: true, intent: clone(next) }
  }

  async expireDue(now: number): Promise<PaymentIntent[]> {
    const expired: PaymentIntent[] = []
    for (const [id, intent] of this.intents) {
      if ((intent.status === 'requires_payment' || intent.status === 'failed') && now >= intent.expiresAt) {
        const next = applyPatch(intent, { status: 'expired' })
        this.intents.set(id, next)
        expired.push(clone(next))
      }
    }
    return expired
  }

  async listIntents(options: ListIntentsOptions = {}): Promise<PaymentIntent[]> {
    const all = [...this.intents.values()]
      .filter((i) => (options.merchantId ? i.merchantId === options.merchantId : true))
      .filter((i) => (options.status ? i.status === options.status : true))
      .sort((a, b) => b.createdAt - a.createdAt)
    return all.slice(0, options.limit ?? 100).map(clone)
  }

  async saveReceipt(receipt: PaymentReceipt): Promise<void> {
    this.receipts.set(receipt.intentId, { ...receipt })
  }

  async getReceipt(intentId: string): Promise<PaymentReceipt | undefined> {
    const found = this.receipts.get(intentId)
    return found ? { ...found } : undefined
  }

  async recordWebhookDelivery(delivery: WebhookDelivery): Promise<void> {
    const list = this.deliveries.get(delivery.intentId) ?? []
    const idx = list.findIndex((d) => d.id === delivery.id)
    if (idx >= 0) list[idx] = { ...delivery }
    else list.push({ ...delivery })
    this.deliveries.set(delivery.intentId, list)
  }

  async listWebhookDeliveries(intentId: string): Promise<WebhookDelivery[]> {
    return (this.deliveries.get(intentId) ?? []).map((d) => ({ ...d }))
  }

  async close(): Promise<void> {
    this.intents.clear()
    this.fingerprints.clear()
    this.receipts.clear()
    this.deliveries.clear()
  }
}
