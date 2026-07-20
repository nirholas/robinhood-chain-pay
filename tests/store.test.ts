/**
 * The store contract, run twice: once against the in-memory implementation and
 * once against SQLite. Both must behave identically, especially under the
 * concurrent claim that stops a double charge.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { IdempotencyConflictError } from '../src/core/errors.js'
import { createIntent, intentFingerprint } from '../src/core/intent.js'
import { buildReceipt } from '../src/core/receipt.js'
import type { AuthorizationWire, PaymentIntent } from '../src/core/types.js'
import type { Hex } from '../src/core/networks.js'
import { MemoryStore, type PaymentStore } from '../src/server/store.js'
import { SqliteStore } from '../src/server/sqlite-store.js'

const PAY_TO = '0x1111111111111111111111111111111111111111'
const PAYER = '0x2222222222222222222222222222222222222222'
const NOW = 1_800_000_000

const authorization: AuthorizationWire = {
  from: PAYER,
  to: PAY_TO,
  value: '12500000',
  validAfter: '0',
  validBefore: String(NOW + 900),
  nonce: '0xaa'.padEnd(66, '0') as Hex,
}

async function makeIntent(overrides: Parameters<typeof createIntent>[0] = { amount: '12.50', payTo: PAY_TO }) {
  const intent = await createIntent(overrides, { now: NOW })
  const fingerprint = await intentFingerprint({
    merchantId: intent.merchantId,
    amount: intent.amount,
    payTo: intent.payTo,
    network: intent.network,
    description: intent.description,
    metadata: intent.metadata,
  })
  return { intent, fingerprint }
}

const implementations: Array<[string, () => PaymentStore]> = [
  ['MemoryStore', () => new MemoryStore()],
  ['SqliteStore', () => new SqliteStore(':memory:')],
]

describe.each(implementations)('%s', (_name, make) => {
  let store: PaymentStore

  afterEach(async () => {
    await store?.close()
  })

  it('stores and reads an intent unchanged', async () => {
    store = make()
    const { intent, fingerprint } = await makeIntent({
      amount: '12.50',
      payTo: PAY_TO,
      description: 'Widget',
      metadata: { orderId: '7' },
      successUrl: 'https://shop.example.com/thanks',
    })
    const created = await store.createIntent(intent, fingerprint)
    expect(created.created).toBe(true)
    const read = await store.getIntent(intent.id)
    expect(read).toEqual(intent)
  })

  it('is idempotent on repeat creation with the same id and fingerprint', async () => {
    store = make()
    const { intent, fingerprint } = await makeIntent({
      amount: '5',
      payTo: PAY_TO,
      idempotencyKey: 'order-1',
    })
    const first = await store.createIntent(intent, fingerprint)
    const second = await store.createIntent(intent, fingerprint)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.intent.id).toBe(intent.id)
    expect(await store.listIntents()).toHaveLength(1)
  })

  it('rejects a reused idempotency key with different parameters', async () => {
    store = make()
    const first = await makeIntent({ amount: '5', payTo: PAY_TO, idempotencyKey: 'order-1' })
    await store.createIntent(first.intent, first.fingerprint)
    const second = await makeIntent({ amount: '500', payTo: PAY_TO, idempotencyKey: 'order-1' })
    expect(second.intent.id).toBe(first.intent.id)
    await expect(store.createIntent(second.intent, second.fingerprint)).rejects.toThrow(
      IdempotencyConflictError,
    )
  })

  it('lets exactly one concurrent caller claim the relay', async () => {
    store = make()
    const { intent, fingerprint } = await makeIntent()
    await store.createIntent(intent, fingerprint)

    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.claimRelay(intent.id, PAYER, authorization, NOW)),
    )
    expect(results.filter((r) => r.claimed)).toHaveLength(1)
    expect(results.filter((r) => !r.claimed)).toHaveLength(7)
    for (const rejected of results.filter((r) => !r.claimed)) {
      expect(rejected).toMatchObject({ reason: 'already_processing' })
    }
    expect((await store.getIntent(intent.id))?.status).toBe('processing')
  })

  it('records the payer and authorization on the claim', async () => {
    store = make()
    const { intent, fingerprint } = await makeIntent()
    await store.createIntent(intent, fingerprint)
    const claim = await store.claimRelay(intent.id, PAYER, authorization, NOW)
    expect(claim.claimed).toBe(true)
    const stored = await store.getIntent(intent.id)
    expect(stored?.payer).toBe(PAYER)
    expect(stored?.authorization).toEqual(authorization)
  })

  it('refuses to claim a settled intent and reports it as paid', async () => {
    store = make()
    const { intent, fingerprint } = await makeIntent()
    await store.createIntent(intent, fingerprint)
    await store.claimRelay(intent.id, PAYER, authorization, NOW)
    await store.updateIntent(intent.id, { status: 'succeeded' })
    const claim = await store.claimRelay(intent.id, PAYER, authorization, NOW)
    expect(claim).toMatchObject({ claimed: false, reason: 'already_paid' })
  })

  it('refuses to claim after the deadline and marks the intent expired', async () => {
    store = make()
    const { intent, fingerprint } = await makeIntent()
    await store.createIntent(intent, fingerprint)
    const claim = await store.claimRelay(intent.id, PAYER, authorization, intent.expiresAt + 1)
    expect(claim).toMatchObject({ claimed: false, reason: 'expired' })
    expect((await store.getIntent(intent.id))?.status).toBe('expired')
  })

  it('allows a retry claim after a failed attempt', async () => {
    store = make()
    const { intent, fingerprint } = await makeIntent()
    await store.createIntent(intent, fingerprint)
    await store.claimRelay(intent.id, PAYER, authorization, NOW)
    await store.updateIntent(intent.id, { status: 'failed', failureCode: 'insufficient_funds' })
    const retry = await store.claimRelay(intent.id, PAYER, authorization, NOW)
    expect(retry.claimed).toBe(true)
  })

  it('reports a missing intent rather than inventing one', async () => {
    store = make()
    expect(await store.getIntent('pi_missing')).toBeUndefined()
    expect(await store.claimRelay('pi_missing', PAYER, authorization, NOW)).toMatchObject({
      claimed: false,
      reason: 'not_found',
    })
  })

  it('expires everything past its deadline in one sweep', async () => {
    store = make()
    const a = await makeIntent({ amount: '1', payTo: PAY_TO })
    const b = await makeIntent({ amount: '2', payTo: PAY_TO })
    await store.createIntent(a.intent, a.fingerprint)
    await store.createIntent(b.intent, b.fingerprint)
    const expired = await store.expireDue(a.intent.expiresAt + 1)
    expect(expired).toHaveLength(2)
    expect(expired.every((i) => i.status === 'expired')).toBe(true)
    expect(await store.expireDue(a.intent.expiresAt + 1)).toHaveLength(0)
  })

  it('persists and reads back a receipt with every bigint intact', async () => {
    store = make()
    const { intent, fingerprint } = await makeIntent()
    await store.createIntent(intent, fingerprint)
    const receipt = await buildReceipt({
      intent,
      from: PAYER,
      nonce: authorization.nonce,
      validAfter: 0n,
      validBefore: BigInt(authorization.validBefore),
      txHash: '0xfe'.padEnd(66, '0') as Hex,
      blockNumber: 123n,
      settledAt: NOW + 5,
    })
    await store.saveReceipt(receipt)
    expect(await store.getReceipt(intent.id)).toEqual(receipt)
  })

  it('records webhook deliveries and updates them in place', async () => {
    store = make()
    const { intent, fingerprint } = await makeIntent()
    await store.createIntent(intent, fingerprint)
    const base = {
      id: 'whd_1',
      intentId: intent.id,
      eventType: 'payment_intent.succeeded' as const,
      url: 'https://shop.example.com/hooks',
      status: null,
      attempts: 0,
      error: null,
      createdAt: NOW,
      updatedAt: NOW,
      delivered: false,
    }
    await store.recordWebhookDelivery(base)
    await store.recordWebhookDelivery({ ...base, status: 200, attempts: 1, delivered: true })
    const deliveries = await store.listWebhookDeliveries(intent.id)
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({ status: 200, attempts: 1, delivered: true })
  })

  it('filters and limits when listing', async () => {
    store = make()
    for (const amount of ['1', '2', '3']) {
      const { intent, fingerprint } = await makeIntent({ amount, payTo: PAY_TO })
      await store.createIntent(intent, fingerprint)
    }
    expect(await store.listIntents()).toHaveLength(3)
    expect(await store.listIntents({ limit: 2 })).toHaveLength(2)
    expect(await store.listIntents({ status: 'succeeded' })).toHaveLength(0)
    expect(await store.listIntents({ merchantId: 'nobody' })).toHaveLength(0)
  })
})

describe('MemoryStore isolation', () => {
  it('returns copies, so a caller cannot mutate stored state by reference', async () => {
    const store = new MemoryStore()
    const { intent, fingerprint } = await makeIntent()
    await store.createIntent(intent, fingerprint)
    const read = (await store.getIntent(intent.id)) as PaymentIntent
    read.status = 'succeeded'
    read.metadata['injected'] = 'yes'
    const again = await store.getIntent(intent.id)
    expect(again?.status).toBe('requires_payment')
    expect(again?.metadata['injected']).toBeUndefined()
    await store.close()
  })
})
