/**
 * `HoodPayMerchant` is the whole product in one object: it creates payment
 * intents and payment links, accepts a customer's signed authorization,
 * relays it on-chain, writes a verifiable receipt, and notifies the merchant
 * over a signed webhook.
 *
 * It is framework-agnostic on purpose. The Express and Hono adapters in this
 * package are thin translations of HTTP into these method calls, so anything
 * that can call a function (a Lambda, a Cloudflare Worker, a queue consumer,
 * a test) can run a hood-pay merchant without an HTTP server at all.
 */

import {
  ConfigError,
  HoodPayError,
  IntentExpiredError,
  IntentNotFoundError,
} from '../core/errors.js'
import { createIntent, effectiveStatus, intentFingerprint, serializeIntent } from '../core/intent.js'
import { buildReceipt, serializeReceipt } from '../core/receipt.js'
import { chainIdHex, requireNetwork, txUrl, type Address, type HoodPayNetwork } from '../core/networks.js'
import type {
  CheckoutSession,
  CreateIntentParams,
  PaymentIntent,
  PaymentReceipt,
  SignedAuthorization,
  WebhookEvent,
} from '../core/types.js'
import { fromWire } from '../core/eip712.js'
import { preflight, relayAuthorization, type ChainReader, type ChainWriter } from './relay.js'
import { MemoryStore, type PaymentStore, type WebhookDelivery } from './store.js'
import { buildEvent, dispatchWebhook } from './webhooks.js'
import { randomId } from '../core/hash.js'

export type { CheckoutSession }

/**
 * Intent parameters as a merchant supplies them. `payTo` and `network` are
 * optional here because `HoodPayMerchant` already knows both: a shop that
 * always pays into one address should not have to repeat it on every charge.
 */
export type MerchantIntentParams = Omit<CreateIntentParams, 'payTo'> & { payTo?: Address }

/** Chain wiring the relay needs. Omit it to run an intents-only merchant. */
export interface RelayerConfig {
  /** viem `PublicClient` (or anything satisfying {@link ChainReader}). */
  reader: ChainReader
  /** viem `WalletClient` (or anything satisfying {@link ChainWriter}). */
  writer: ChainWriter
  /** The gas-paying address bound to `writer`. */
  address: Address
  /** viem chain object, forwarded to `writeContract`. */
  chain?: unknown
  /**
   * Refuse to relay a single payment above this amount, in atomic USDG.
   * A spend limit on the relayer bounds the damage from a compromised
   * merchant API, since the relayer only ever pays gas but a flood of relays
   * still drains its gas balance.
   */
  maxAmountPerPayment?: bigint
}

export interface WebhookConfig {
  url: string
  secret: string
  maxAttempts?: number
  timeoutMs?: number
}

export interface HoodPayMerchantOptions {
  /** Address that receives USDG, used when an intent does not name one. */
  payTo: Address
  /** Persistence. Defaults to an in-memory store. */
  store?: PaymentStore
  /** Network id or alias. Defaults to `'robinhood'`. */
  network?: string
  /** Identifier for this merchant, stamped on every intent and receipt. */
  merchantId?: string
  /** Public base URL of this server, used to build payment link URLs. */
  baseUrl?: string
  /** Chain wiring for settlement. */
  relayer?: RelayerConfig
  /** Where to POST signed events. */
  webhook?: WebhookConfig
  /**
   * How long a customer's signed authorization stays valid, in seconds.
   * Defaults to 900. Kept short so an authorization captured in transit has a
   * bounded life, and never allowed to outlive the intent.
   */
  authorizationValiditySeconds?: number
  /** Injectable clock (unix seconds). */
  now?: () => number
  fetchImpl?: typeof fetch
}

export interface PaymentLink {
  intent: PaymentIntent
  /** Absolute URL of the hosted checkout page. Requires `baseUrl`. */
  url: string
}

export interface PayResult {
  intent: PaymentIntent
  receipt?: PaymentReceipt
}

export class HoodPayMerchant {
  readonly store: PaymentStore
  readonly network: HoodPayNetwork
  readonly merchantId: string
  readonly payTo: Address
  readonly baseUrl: string | undefined
  readonly authorizationValiditySeconds: number

  private readonly relayer: RelayerConfig | undefined
  private readonly webhook: WebhookConfig | undefined
  private readonly clock: () => number
  private readonly fetchImpl: typeof fetch | undefined

  constructor(options: HoodPayMerchantOptions) {
    if (!options.payTo) {
      throw new ConfigError('hood-pay: `payTo` is required, it is the address that receives USDG')
    }
    this.store = options.store ?? new MemoryStore()
    this.network = requireNetwork(options.network ?? 'robinhood')
    this.merchantId = options.merchantId ?? 'default'
    this.payTo = options.payTo
    this.baseUrl = options.baseUrl?.replace(/\/+$/, '')
    this.relayer = options.relayer
    this.webhook = options.webhook
    this.authorizationValiditySeconds = options.authorizationValiditySeconds ?? 900
    this.clock = options.now ?? ((): number => Math.floor(Date.now() / 1000))
    this.fetchImpl = options.fetchImpl
    if (options.webhook && !options.webhook.secret) {
      throw new ConfigError('hood-pay: a webhook secret is required when a webhook url is set')
    }
  }

  /** Current time in unix seconds, through the injectable clock. */
  now(): number {
    return this.clock()
  }

  /** Create a payment intent. Idempotent when `idempotencyKey` is supplied. */
  async createIntent(params: MerchantIntentParams): Promise<PaymentIntent> {
    const intent = await createIntent(
      {
        ...params,
        payTo: params.payTo ?? this.payTo,
        network: params.network ?? this.network.id,
        merchantId: params.merchantId ?? this.merchantId,
      },
      { defaultMerchantId: this.merchantId, now: this.now() },
    )
    const fingerprint = await intentFingerprint({
      merchantId: intent.merchantId,
      amount: intent.amount,
      payTo: intent.payTo,
      network: intent.network,
      description: intent.description,
      metadata: intent.metadata,
    })
    const { intent: stored, created } = await this.store.createIntent(intent, fingerprint)
    if (created) await this.emit('payment_intent.created', stored)
    return stored
  }

  /**
   * Create an intent and return the hosted checkout URL for it. This is the
   * "payment link" surface: one URL a merchant can email, embed in an invoice,
   * or put behind a QR code.
   */
  async createPaymentLink(params: MerchantIntentParams): Promise<PaymentLink> {
    if (!this.baseUrl) {
      throw new ConfigError(
        'hood-pay: `baseUrl` must be set on HoodPayMerchant to build payment link URLs',
      )
    }
    const intent = await this.createIntent(params)
    return { intent, url: `${this.baseUrl}/pay/${intent.id}` }
  }

  /** Fetch an intent, folding expiry into its status. Throws when unknown. */
  async getIntent(id: string): Promise<PaymentIntent> {
    const intent = await this.store.getIntent(id)
    if (!intent) throw new IntentNotFoundError(id)
    const status = effectiveStatus(intent, this.now())
    if (status !== intent.status) {
      const updated = await this.store.updateIntent(id, { status })
      if (status === 'expired') await this.emit('payment_intent.expired', updated)
      return updated
    }
    return intent
  }

  async getReceipt(intentId: string): Promise<PaymentReceipt | undefined> {
    return this.store.getReceipt(intentId)
  }

  /** Everything the browser needs to render checkout for an intent. */
  async getCheckoutSession(id: string): Promise<CheckoutSession> {
    const intent = await this.getIntent(id)
    const net = requireNetwork(intent.network)
    const receipt = await this.store.getReceipt(id)
    return {
      intent: serializeIntent(intent, this.now()),
      network: {
        id: net.id,
        chainId: net.chainId,
        chainIdHex: chainIdHex(net),
        label: net.label,
        rpcUrl: net.rpcUrl,
        explorerUrl: net.explorerUrl,
        usdg: net.usdg,
        usdgDecimals: net.usdgDecimals,
        usdgDomain: { ...net.usdgDomain },
        testnet: net.testnet,
      },
      authorizationValiditySeconds: Math.min(
        this.authorizationValiditySeconds,
        Math.max(0, intent.expiresAt - this.now()),
      ),
      ...(receipt ? { receipt: serializeReceipt(receipt) } : {}),
      ...(intent.txHash ? { explorerTxUrl: txUrl(net, intent.txHash) } : {}),
    }
  }

  /** Cancel an unpaid intent. */
  async cancel(id: string): Promise<PaymentIntent> {
    const intent = await this.getIntent(id)
    if (intent.status === 'succeeded') {
      throw new HoodPayError('intent_already_paid', `hood-pay: intent "${id}" is already paid`, {
        intentId: id,
      })
    }
    if (intent.status === 'canceled') return intent
    if (intent.status === 'processing') {
      throw new HoodPayError(
        'config_invalid',
        `hood-pay: intent "${id}" is being settled and cannot be canceled`,
        { intentId: id },
      )
    }
    const updated = await this.store.updateIntent(id, { status: 'canceled' })
    await this.emit('payment_intent.canceled', updated)
    return updated
  }

  /** Expire every intent past its deadline, emitting an event for each. */
  async expireDue(): Promise<PaymentIntent[]> {
    const expired = await this.store.expireDue(this.now())
    for (const intent of expired) await this.emit('payment_intent.expired', intent)
    return expired
  }

  /**
   * Accept a customer's signed authorization and settle it.
   *
   * Double-submit safety has three independent layers, in order:
   *
   *  1. `store.claimRelay` is a compare-and-set. The second concurrent request
   *     for the same intent never reaches the chain at all.
   *  2. The nonce is derived from `(intentId, payer)`, so even if a second
   *     process bypassed the store, USDG's `authorizationState` mapping makes
   *     the second `transferWithAuthorization` revert.
   *  3. A settled intent is terminal, so a late retry returns the original
   *     receipt rather than starting a new payment.
   */
  async pay(id: string, signed: SignedAuthorization): Promise<PayResult> {
    const relayer = this.relayer
    if (!relayer) {
      throw new ConfigError(
        'hood-pay: this merchant was constructed without a `relayer`, so it cannot settle payments',
      )
    }

    const existing = await this.getIntent(id)

    // A settled intent answers with its receipt. This is what makes a retried
    // POST from a flaky mobile connection safe.
    if (existing.status === 'succeeded') {
      const receipt = await this.store.getReceipt(id)
      return { intent: existing, ...(receipt ? { receipt } : {}) }
    }

    // Reject a non-payable intent up front, so the failure carries the status
    // that actually caused it rather than whatever the claim step infers.
    if (existing.status === 'expired') {
      throw new IntentExpiredError(id, existing.expiresAt)
    }
    if (existing.status === 'canceled') {
      throw new HoodPayError('intent_canceled', `hood-pay: intent "${id}" was canceled`, {
        intentId: id,
      })
    }
    if (existing.status === 'processing') {
      throw new HoodPayError(
        'config_invalid',
        `hood-pay: intent "${id}" is already being settled. Poll its status rather than retrying.`,
        { intentId: id, status: 'processing' },
      )
    }

    const now = this.now()
    const net = requireNetwork(existing.network)

    if (relayer.maxAmountPerPayment !== undefined && existing.amount > relayer.maxAmountPerPayment) {
      throw new HoodPayError(
        'config_invalid',
        `hood-pay: intent amount ${existing.amount} exceeds the relayer limit of ${relayer.maxAmountPerPayment} atomic USDG`,
        { intentId: id },
      )
    }

    // Validate before claiming, so a bad signature does not park the intent in
    // `processing` and lock out the customer's next attempt.
    const pre = await preflight({
      intent: existing,
      signed,
      network: net,
      reader: relayer.reader,
      now,
    })
    if (!pre.ok) {
      throw new HoodPayError(pre.code, pre.message, { intentId: id })
    }

    const claim = await this.store.claimRelay(id, pre.payer, signed.authorization, now)
    if (!claim.claimed) {
      if (claim.reason === 'already_paid' && claim.intent) {
        const receipt = await this.store.getReceipt(id)
        return { intent: claim.intent, ...(receipt ? { receipt } : {}) }
      }
      if (claim.reason === 'already_processing') {
        throw new HoodPayError(
          'config_invalid',
          `hood-pay: intent "${id}" is already being settled. Poll its status rather than retrying.`,
          { intentId: id, status: 'processing' },
        )
      }
      if (claim.reason === 'expired') {
        throw new HoodPayError('intent_expired', `hood-pay: intent "${id}" has expired`, {
          intentId: id,
        })
      }
      if (claim.reason === 'not_found') throw new IntentNotFoundError(id)
      const status = claim.intent?.status
      throw new HoodPayError(
        status === 'expired' ? 'intent_expired' : 'intent_canceled',
        `hood-pay: intent "${id}" is ${status ?? 'not payable'}`,
        { intentId: id },
      )
    }

    await this.emit('payment_intent.processing', claim.intent)

    const outcome = await relayAuthorization({
      intent: claim.intent,
      signed,
      network: net,
      reader: relayer.reader,
      writer: relayer.writer,
      relayerAddress: relayer.address,
      ...(relayer.chain !== undefined ? { chain: relayer.chain } : {}),
      skipPreflight: true,
      now,
    })

    if (!outcome.ok) {
      const failed = await this.store.updateIntent(id, {
        status: 'failed',
        failureCode: outcome.code,
        failureMessage: outcome.message,
        ...(outcome.txHash ? { txHash: outcome.txHash } : {}),
      })
      await this.emit('payment_intent.failed', failed)
      throw new HoodPayError(outcome.code, outcome.message, { intentId: id })
    }

    const auth = fromWire(signed.authorization)
    const settledAt = this.now()
    const receipt = await buildReceipt({
      intent: claim.intent,
      from: outcome.payer,
      nonce: auth.nonce,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      txHash: outcome.txHash,
      blockNumber: outcome.blockNumber,
      settledAt,
    })
    await this.store.saveReceipt(receipt)

    const settled = await this.store.updateIntent(id, {
      status: 'succeeded',
      txHash: outcome.txHash,
      blockNumber: outcome.blockNumber,
      settledAt,
    })
    await this.emit('payment_intent.succeeded', settled, receipt)
    return { intent: settled, receipt }
  }

  /**
   * Build and deliver a webhook event. Delivery failures are recorded and
   * never thrown: a merchant's own webhook endpoint being down must not fail
   * the customer's payment, which has already settled on-chain and cannot be
   * undone.
   */
  private async emit(
    type: WebhookEvent['type'],
    intent: PaymentIntent,
    receipt?: PaymentReceipt,
  ): Promise<void> {
    const webhook = this.webhook
    if (!webhook) return
    const now = this.now()
    const event = buildEvent(
      type,
      {
        intent: serializeIntent(intent, now),
        ...(receipt ? { receipt: serializeReceipt(receipt) } : {}),
      },
      now,
    )
    const delivery: WebhookDelivery = {
      id: `whd_${randomId(12)}`,
      intentId: intent.id,
      eventType: type,
      url: webhook.url,
      status: null,
      attempts: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
      delivered: false,
    }
    try {
      const result = await dispatchWebhook({
        url: webhook.url,
        secret: webhook.secret,
        event,
        ...(webhook.maxAttempts !== undefined ? { maxAttempts: webhook.maxAttempts } : {}),
        ...(webhook.timeoutMs !== undefined ? { timeoutMs: webhook.timeoutMs } : {}),
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        now: this.clock,
      })
      await this.store.recordWebhookDelivery({
        ...delivery,
        status: result.status,
        attempts: result.attempts,
        error: result.error,
        delivered: result.delivered,
        updatedAt: this.now(),
      })
    } catch (err) {
      await this.store.recordWebhookDelivery({
        ...delivery,
        attempts: 1,
        error: err instanceof Error ? err.message : String(err),
        updatedAt: this.now(),
      })
    }
  }

  async close(): Promise<void> {
    await this.store.close()
  }
}
