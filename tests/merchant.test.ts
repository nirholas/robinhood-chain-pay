/**
 * The full merchant lifecycle, end to end, against a chain double: create an
 * intent, sign it with a real key, relay it, and get a receipt that verifies.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { deriveNonce } from '../src/core/eip712.js'
import { HoodPayError } from '../src/core/errors.js'
import { ROBINHOOD_TESTNET } from '../src/core/networks.js'
import type { AuthorizationWire } from '../src/core/types.js'
import { HoodPayMerchant } from '../src/server/merchant.js'
import { MemoryStore } from '../src/server/store.js'
import { verifyWebhookSignature, SIGNATURE_HEADER } from '../src/server/webhooks.js'
import { verifyReceipt } from '../src/verify/index.js'
import { FakeUsdgChain, signAuthorization, testAccount } from './helpers.js'

const NET = ROBINHOOD_TESTNET
const PAY_TO = '0x1111111111111111111111111111111111111111'
const RELAYER = '0x9999999999999999999999999999999999999999'
const WEBHOOK_SECRET = 'whsec_merchant_test'
let NOW = 1_800_000_000

const payer = testAccount(21)

let chain: FakeUsdgChain
let merchant: HoodPayMerchant
let deliveries: Array<{ body: string; signature: string }>

type MerchantOptions = ConstructorParameters<typeof HoodPayMerchant>[0]

function makeMerchant(options: Partial<MerchantOptions> = {}, drop: Array<keyof MerchantOptions> = []) {
  const merged: MerchantOptions = {
    payTo: PAY_TO,
    network: 'robinhood-testnet',
    merchantId: 'test-shop',
    baseUrl: 'https://shop.example.com',
    store: new MemoryStore(),
    now: () => NOW,
    relayer: {
      reader: chain.reader,
      writer: chain.writer,
      address: RELAYER,
    },
    webhook: { url: 'https://shop.example.com/hooks', secret: WEBHOOK_SECRET },
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      deliveries.push({
        body: init?.body as string,
        signature: (init?.headers as Record<string, string>)[SIGNATURE_HEADER] as string,
      })
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch,
    ...options,
  }
  for (const key of drop) delete merged[key]
  return new HoodPayMerchant(merged)
}

async function authorizationFor(
  intentId: string,
  amount: bigint,
  overrides: Partial<AuthorizationWire> = {},
): Promise<AuthorizationWire> {
  return {
    from: payer.address,
    to: PAY_TO,
    value: amount.toString(),
    validAfter: '0',
    validBefore: String(NOW + 900),
    nonce: await deriveNonce(intentId, payer.address),
    ...overrides,
  }
}

beforeEach(() => {
  NOW = 1_800_000_000
  chain = new FakeUsdgChain(NET)
  chain.credit(payer.address, 100_000_000n)
  deliveries = []
  merchant = makeMerchant()
})

describe('payment links', () => {
  it('creates an intent and a hosted checkout URL', async () => {
    const link = await merchant.createPaymentLink({ amount: '12.50', description: 'One widget' })
    expect(link.url).toBe(`https://shop.example.com/pay/${link.intent.id}`)
    expect(link.intent.amount).toBe(12_500_000n)
    expect(link.intent.payTo).toBe(PAY_TO)
    expect(link.intent.status).toBe('requires_payment')
  })

  it('refuses to build a link without a baseUrl', async () => {
    const noBase = makeMerchant({}, ['baseUrl'])
    await expect(noBase.createPaymentLink({ amount: '1' })).rejects.toThrow(/baseUrl/)
  })

  it('emits a created webhook signed with the shared secret', async () => {
    await merchant.createIntent({ amount: '1' })
    expect(deliveries).toHaveLength(1)
    const delivery = deliveries[0] as { body: string; signature: string }
    expect(JSON.parse(delivery.body).type).toBe('payment_intent.created')
    expect(
      await verifyWebhookSignature({
        secret: WEBHOOK_SECRET,
        rawBody: delivery.body,
        signature: delivery.signature,
        now: NOW,
      }),
    ).toBe(true)
  })

  it('is idempotent across repeated creates with the same key', async () => {
    const first = await merchant.createIntent({ amount: '5', idempotencyKey: 'order-9' })
    const second = await merchant.createIntent({ amount: '5', idempotencyKey: 'order-9' })
    expect(second.id).toBe(first.id)
    expect(deliveries.filter((d) => JSON.parse(d.body).type === 'payment_intent.created')).toHaveLength(1)
  })

  it('rejects a reused key with a different amount', async () => {
    await merchant.createIntent({ amount: '5', idempotencyKey: 'order-9' })
    await expect(
      merchant.createIntent({ amount: '50', idempotencyKey: 'order-9' }),
    ).rejects.toThrow(/idempotency key/)
  })
})

describe('paying an intent', () => {
  it('settles, writes a receipt, and moves the money', async () => {
    const intent = await merchant.createIntent({ amount: '12.50', metadata: { orderId: '7' } })
    const signed = await signAuthorization(payer, NET, await authorizationFor(intent.id, intent.amount))

    const result = await merchant.pay(intent.id, signed)

    expect(result.intent.status).toBe('succeeded')
    expect(result.intent.txHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(result.receipt?.amount).toBe(12_500_000n)
    expect(result.receipt?.from).toBe(payer.address)
    expect(result.receipt?.to).toBe(PAY_TO)
    expect(chain.balanceOf(PAY_TO)).toBe(12_500_000n)
  })

  it('produces a receipt that verifies independently on-chain', async () => {
    const intent = await merchant.createIntent({ amount: '3.75' })
    const signed = await signAuthorization(payer, NET, await authorizationFor(intent.id, intent.amount))
    const { receipt } = await merchant.pay(intent.id, signed)
    expect(receipt).toBeDefined()

    const verification = await verifyReceipt({
      receipt: receipt!,
      client: chain.reader,
      intent: await merchant.getIntent(intent.id),
    })
    expect(verification.valid).toBe(true)
    expect(verification.checks.every((c) => c.ok)).toBe(true)
    expect(verification.observedAmount).toBe(3_750_000n)
  })

  it('emits processing then succeeded webhooks, the last carrying the receipt', async () => {
    const intent = await merchant.createIntent({ amount: '1' })
    const signed = await signAuthorization(payer, NET, await authorizationFor(intent.id, intent.amount))
    await merchant.pay(intent.id, signed)

    const types = deliveries.map((d) => JSON.parse(d.body).type)
    expect(types).toEqual([
      'payment_intent.created',
      'payment_intent.processing',
      'payment_intent.succeeded',
    ])
    const last = JSON.parse((deliveries.at(-1) as { body: string }).body)
    expect(last.data.receipt.amount).toBe('1000000')
    expect(last.data.receipt.digest).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('never charges twice under a concurrent double submit', async () => {
    const intent = await merchant.createIntent({ amount: '2.00' })
    const signed = await signAuthorization(payer, NET, await authorizationFor(intent.id, intent.amount))

    const results = await Promise.allSettled([
      merchant.pay(intent.id, signed),
      merchant.pay(intent.id, signed),
      merchant.pay(intent.id, signed),
    ])

    const settled = results.filter((r) => r.status === 'fulfilled')
    expect(settled.length).toBeGreaterThanOrEqual(1)
    // Exactly one transaction reached the chain, and the balance moved once.
    expect(chain.calls).toHaveLength(1)
    expect(chain.balanceOf(PAY_TO)).toBe(2_000_000n)
    expect((await merchant.getIntent(intent.id)).status).toBe('succeeded')
  })

  it('returns the original receipt for a retry after settlement', async () => {
    const intent = await merchant.createIntent({ amount: '2.00' })
    const signed = await signAuthorization(payer, NET, await authorizationFor(intent.id, intent.amount))
    const first = await merchant.pay(intent.id, signed)
    const retry = await merchant.pay(intent.id, signed)

    expect(retry.receipt?.digest).toBe(first.receipt?.digest)
    expect(retry.intent.txHash).toBe(first.intent.txHash)
    expect(chain.calls).toHaveLength(1)
  })

  it('rejects an authorization for the wrong amount before touching the chain', async () => {
    const intent = await merchant.createIntent({ amount: '12.50' })
    const signed = await signAuthorization(payer, NET, await authorizationFor(intent.id, 1_000_000n))
    await expect(merchant.pay(intent.id, signed)).rejects.toMatchObject({
      code: 'amount_mismatch',
    })
    expect(chain.calls).toHaveLength(0)
    // A rejected attempt must not park the intent in `processing`.
    expect((await merchant.getIntent(intent.id)).status).toBe('requires_payment')
  })

  it('leaves the intent retryable after an on-chain failure', async () => {
    const intent = await merchant.createIntent({ amount: '1.00' })
    const signed = await signAuthorization(payer, NET, await authorizationFor(intent.id, intent.amount))
    chain.revertNext = true

    await expect(merchant.pay(intent.id, signed)).rejects.toMatchObject({
      code: 'settlement_reverted',
    })
    expect((await merchant.getIntent(intent.id)).status).toBe('failed')
    expect(deliveries.map((d) => JSON.parse(d.body).type)).toContain('payment_intent.failed')

    // The nonce was not consumed by the revert, so the same intent can be paid.
    const retry = await merchant.pay(intent.id, signed)
    expect(retry.intent.status).toBe('succeeded')
    expect(chain.balanceOf(PAY_TO)).toBe(1_000_000n)
  })

  it('refuses to pay an expired intent', async () => {
    const intent = await merchant.createIntent({ amount: '1.00', expiresInSeconds: 60 })
    const signed = await signAuthorization(payer, NET, await authorizationFor(intent.id, intent.amount))
    NOW += 61
    await expect(merchant.pay(intent.id, signed)).rejects.toMatchObject({ code: 'intent_expired' })
    expect(chain.calls).toHaveLength(0)
  })

  it('refuses to pay a canceled intent', async () => {
    const intent = await merchant.createIntent({ amount: '1.00' })
    await merchant.cancel(intent.id)
    const signed = await signAuthorization(payer, NET, await authorizationFor(intent.id, intent.amount))
    await expect(merchant.pay(intent.id, signed)).rejects.toBeInstanceOf(HoodPayError)
    expect(chain.calls).toHaveLength(0)
  })

  it('honours a relayer spend limit', async () => {
    const limited = makeMerchant({
      relayer: {
        reader: chain.reader,
        writer: chain.writer,
        address: RELAYER,
        maxAmountPerPayment: 1_000_000n,
      },
    })
    const intent = await limited.createIntent({ amount: '5.00' })
    const signed = await signAuthorization(payer, NET, await authorizationFor(intent.id, intent.amount))
    await expect(limited.pay(intent.id, signed)).rejects.toThrow(/relayer limit/)
    expect(chain.calls).toHaveLength(0)
  })

  it('refuses to settle at all without a relayer configured', async () => {
    const readOnly = makeMerchant({}, ['relayer'])
    const intent = await readOnly.createIntent({ amount: '1.00' })
    const signed = await signAuthorization(payer, NET, await authorizationFor(intent.id, intent.amount))
    await expect(readOnly.pay(intent.id, signed)).rejects.toThrow(/without a `relayer`/)
  })
})

describe('lifecycle management', () => {
  it('expires an intent on read once its deadline passes', async () => {
    const intent = await merchant.createIntent({ amount: '1.00', expiresInSeconds: 60 })
    NOW += 61
    expect((await merchant.getIntent(intent.id)).status).toBe('expired')
    expect(deliveries.map((d) => JSON.parse(d.body).type)).toContain('payment_intent.expired')
  })

  it('sweeps every due intent at once', async () => {
    await merchant.createIntent({ amount: '1.00', expiresInSeconds: 60 })
    await merchant.createIntent({ amount: '2.00', expiresInSeconds: 60 })
    NOW += 61
    const expired = await merchant.expireDue()
    expect(expired).toHaveLength(2)
  })

  it('cancels an unpaid intent but not a settled one', async () => {
    const intent = await merchant.createIntent({ amount: '1.00' })
    const canceled = await merchant.cancel(intent.id)
    expect(canceled.status).toBe('canceled')

    const paid = await merchant.createIntent({ amount: '1.00' })
    const signed = await signAuthorization(payer, NET, await authorizationFor(paid.id, paid.amount))
    await merchant.pay(paid.id, signed)
    await expect(merchant.cancel(paid.id)).rejects.toMatchObject({ code: 'intent_already_paid' })
  })

  it('reports an unknown intent as not found', async () => {
    await expect(merchant.getIntent('pi_nope')).rejects.toMatchObject({ code: 'intent_not_found' })
  })
})

describe('checkout session', () => {
  it('carries everything the browser needs and nothing secret', async () => {
    const intent = await merchant.createIntent({ amount: '12.50', description: 'Widget' })
    const session = await merchant.getCheckoutSession(intent.id)

    expect(session.intent.amount).toBe('12500000')
    expect(session.intent.amountFormatted).toBe('12.500000')
    expect(session.network).toMatchObject({
      chainId: 46630,
      chainIdHex: '0xb626',
      usdg: NET.usdg,
      usdgDomain: { name: 'Global Dollar', version: '1' },
      testnet: true,
    })
    expect(session.authorizationValiditySeconds).toBeGreaterThan(0)
    expect(JSON.stringify(session)).not.toContain(WEBHOOK_SECRET)
  })

  it('never offers a validity window that outlives the intent', async () => {
    const intent = await merchant.createIntent({ amount: '1.00', expiresInSeconds: 120 })
    NOW += 100
    const session = await merchant.getCheckoutSession(intent.id)
    expect(session.authorizationValiditySeconds).toBe(20)
  })

  it('includes the receipt and explorer link once settled', async () => {
    const intent = await merchant.createIntent({ amount: '1.00' })
    const signed = await signAuthorization(payer, NET, await authorizationFor(intent.id, intent.amount))
    await merchant.pay(intent.id, signed)
    const session = await merchant.getCheckoutSession(intent.id)
    expect(session.receipt?.amountFormatted).toBe('1.000000')
    expect(session.explorerTxUrl).toContain(NET.explorerUrl)
  })
})

describe('webhook resilience', () => {
  it('does not fail a settled payment when the merchant endpoint is down', async () => {
    const failing = makeMerchant({
      webhook: {
        url: 'https://shop.example.com/hooks',
        secret: WEBHOOK_SECRET,
        maxAttempts: 1,
      },
      fetchImpl: vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
    })
    const intent = await failing.createIntent({ amount: '1.00' })
    const signed = await signAuthorization(payer, NET, await authorizationFor(intent.id, intent.amount))
    const result = await failing.pay(intent.id, signed)
    expect(result.intent.status).toBe('succeeded')

    const attempts = await failing.store.listWebhookDeliveries(intent.id)
    expect(attempts.some((a) => !a.delivered && a.error)).toBe(true)
  })
})
