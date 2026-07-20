/**
 * The browser SDK, driven against a real merchant server (the router) over an
 * injected fetch, and a real wallet double that produces genuine signatures.
 *
 * This is the closest thing to an end-to-end test the suite has: a customer's
 * wallet signs, the SDK posts, the merchant relays, and the chain settles.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { HoodPayCheckout, type CheckoutSnapshot, type CheckoutState } from '../src/client/index.js'
import { ROBINHOOD_TESTNET } from '../src/core/networks.js'
import { HoodPayMerchant } from '../src/server/merchant.js'
import { MemoryStore } from '../src/server/store.js'
import { createRouter } from '../src/server/router.js'
import { FakeUsdgChain, FakeWalletProvider, testAccount } from './helpers.js'

const NET = ROBINHOOD_TESTNET
const PAY_TO = '0x1111111111111111111111111111111111111111'
const ORIGIN = 'https://shop.example.com'
const NOW = 1_800_000_000

const payer = testAccount(51)

let chain: FakeUsdgChain
let merchant: HoodPayMerchant
let fetchImpl: typeof fetch

beforeEach(() => {
  chain = new FakeUsdgChain(NET)
  chain.credit(payer.address, 100_000_000n)
  merchant = new HoodPayMerchant({
    payTo: PAY_TO,
    network: 'robinhood-testnet',
    merchantId: 'client-shop',
    store: new MemoryStore(),
    now: () => NOW,
    relayer: { reader: chain.reader, writer: chain.writer, address: '0x9999999999999999999999999999999999999999' },
  })
  const handle = createRouter({ merchant })

  // Route the SDK's fetch straight into the router: no socket, same code path.
  fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url))
    const response = await handle({
      method: init?.method ?? 'GET',
      path: parsed.pathname,
      headers: (init?.headers as Record<string, string>) ?? {},
      ...(init?.body ? { body: JSON.parse(init.body as string) } : {}),
    })
    return new Response(response.body, { status: response.status, headers: response.headers })
  }) as unknown as typeof fetch
})

function makeCheckout(
  intentId: string,
  provider: FakeWalletProvider,
  onChange?: (s: CheckoutSnapshot) => void,
): HoodPayCheckout {
  return new HoodPayCheckout({
    intentId,
    apiBase: ORIGIN,
    fetchImpl,
    now: () => NOW,
    provider: provider as unknown as import('../src/client/provider.js').Eip1193Provider,
    ...(onChange ? { onChange } : {}),
  })
}

describe('load', () => {
  it('loads a session and reaches the idle state', async () => {
    const intent = await merchant.createIntent({ amount: '12.50', description: 'Widget' })
    const checkout = makeCheckout(intent.id, new FakeWalletProvider(payer, NET.chainId))
    const snapshot = await checkout.load()

    expect(snapshot.state).toBe('idle')
    expect(snapshot.session?.intent.amountFormatted).toBe('12.500000')
    expect(snapshot.session?.network.chainId).toBe(46630)
  })

  it('reports an unknown intent without throwing', async () => {
    const checkout = makeCheckout('pi_missing', new FakeWalletProvider(payer, NET.chainId))
    const snapshot = await checkout.load()
    expect(snapshot.state).toBe('failed')
    expect(snapshot.error?.code).toBe('intent_not_found')
  })

  it('opens directly in the settled state for an already-paid intent', async () => {
    const intent = await merchant.createIntent({ amount: '1.00' })
    const first = makeCheckout(intent.id, new FakeWalletProvider(payer, NET.chainId))
    await first.load()
    await first.pay()

    const second = makeCheckout(intent.id, new FakeWalletProvider(payer, NET.chainId))
    const snapshot = await second.load()
    expect(snapshot.state).toBe('settled')
    expect(snapshot.result?.receipt?.amountFormatted).toBe('1.000000')
  })

  it('opens in the expired state past the deadline', async () => {
    const intent = await merchant.createIntent({ amount: '1.00', expiresInSeconds: 60 })
    const expiredMerchant = merchant
    // Advance the merchant's clock by rebuilding it around a later time.
    Object.defineProperty(expiredMerchant, 'clock', { value: () => NOW + 61 })
    const checkout = makeCheckout(intent.id, new FakeWalletProvider(payer, NET.chainId))
    const snapshot = await checkout.load()
    expect(snapshot.state).toBe('expired')
  })

  it('opens in the canceled state for a canceled intent', async () => {
    const intent = await merchant.createIntent({ amount: '1.00' })
    await merchant.cancel(intent.id)
    const checkout = makeCheckout(intent.id, new FakeWalletProvider(payer, NET.chainId))
    expect((await checkout.load()).state).toBe('canceled')
  })
})

describe('pay', () => {
  it('signs, relays, and settles, passing through every designed state in order', async () => {
    const intent = await merchant.createIntent({ amount: '12.50' })
    const states: CheckoutState[] = []
    const checkout = makeCheckout(intent.id, new FakeWalletProvider(payer, NET.chainId), (s) =>
      states.push(s.state),
    )

    await checkout.load()
    const result = await checkout.pay()

    expect(states).toEqual(['loading', 'idle', 'awaiting-signature', 'relaying', 'settled'])
    expect(result.intent.status).toBe('succeeded')
    expect(result.receipt?.amount).toBe('12500000')
    expect(chain.balanceOf(PAY_TO)).toBe(12_500_000n)
  })

  it('derives the nonce the server expects, so the payment is accepted', async () => {
    const intent = await merchant.createIntent({ amount: '5.00' })
    const checkout = makeCheckout(intent.id, new FakeWalletProvider(payer, NET.chainId))
    await checkout.load()
    await checkout.pay()
    expect(chain.calls).toHaveLength(1)
    expect(chain.calls[0]?.value).toBe(5_000_000n)
  })

  it('switches the wallet to the right chain first', async () => {
    const intent = await merchant.createIntent({ amount: '1.00' })
    const wallet = new FakeWalletProvider(payer, 1)
    const checkout = makeCheckout(intent.id, wallet)
    await checkout.load()
    await checkout.pay()
    expect(wallet.switchCalls).toEqual([NET.chainId])
    expect(wallet.chainId).toBe(NET.chainId)
  })

  it('adds the chain when the wallet does not know it', async () => {
    const intent = await merchant.createIntent({ amount: '1.00' })
    const wallet = new FakeWalletProvider(payer, 1, false)
    const checkout = makeCheckout(intent.id, wallet)
    await checkout.load()
    const result = await checkout.pay()
    expect(result.intent.status).toBe('succeeded')
    expect(wallet.chainId).toBe(NET.chainId)
  })

  it('returns to idle when the customer dismisses the wallet prompt', async () => {
    const intent = await merchant.createIntent({ amount: '1.00' })
    const wallet = new FakeWalletProvider(payer, NET.chainId)
    wallet.rejectNextSignature = true
    const checkout = makeCheckout(intent.id, wallet)
    await checkout.load()

    await expect(checkout.pay()).rejects.toMatchObject({ code: 'wallet_rejected' })
    expect(checkout.current.state).toBe('idle')
    expect(checkout.current.message).toContain('Nothing was charged')
    expect(chain.calls).toHaveLength(0)
  })

  it('lands in insufficient-usdg when the payer cannot cover the amount', async () => {
    const poor = testAccount(52)
    const intent = await merchant.createIntent({ amount: '1.00' })
    const checkout = makeCheckout(intent.id, new FakeWalletProvider(poor, NET.chainId))
    await checkout.load()

    await expect(checkout.pay()).rejects.toMatchObject({ code: 'insufficient_funds' })
    expect(checkout.current.state).toBe('insufficient-usdg')
  })

  it('lands in expired when the link has lapsed', async () => {
    const intent = await merchant.createIntent({ amount: '1.00', expiresInSeconds: 60 })
    const checkout = makeCheckout(intent.id, new FakeWalletProvider(payer, NET.chainId))
    await checkout.load()
    Object.defineProperty(merchant, 'clock', { value: () => NOW + 61 })

    await expect(checkout.pay()).rejects.toMatchObject({ code: 'intent_expired' })
    expect(checkout.current.state).toBe('expired')
  })

  it('recovers after a failed attempt and settles on retry', async () => {
    const intent = await merchant.createIntent({ amount: '1.00' })
    const checkout = makeCheckout(intent.id, new FakeWalletProvider(payer, NET.chainId))
    await checkout.load()
    chain.revertNext = true

    await expect(checkout.pay()).rejects.toMatchObject({ code: 'settlement_reverted' })
    expect(checkout.current.state).toBe('failed')

    const result = await checkout.pay()
    expect(result.intent.status).toBe('succeeded')
    expect(checkout.current.state).toBe('settled')
  })

  it('surfaces a transport failure as a network error rather than hanging', async () => {
    const intent = await merchant.createIntent({ amount: '1.00' })
    const checkout = new HoodPayCheckout({
      intentId: intent.id,
      apiBase: ORIGIN,
      now: () => NOW,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
      provider: new FakeWalletProvider(payer, NET.chainId) as unknown as import('../src/client/provider.js').Eip1193Provider,
    })
    const snapshot = await checkout.load()
    expect(snapshot.state).toBe('failed')
    expect(snapshot.error?.code).toBe('network_error')
    expect(snapshot.error?.message).toContain('could not reach the merchant server')
  })
})

describe('construction', () => {
  it('requires an intent id', () => {
    expect(() => new HoodPayCheckout({ intentId: '', fetchImpl })).toThrow(/intentId/)
  })

  it('requires an apiBase outside a browser', async () => {
    const intent = await merchant.createIntent({ amount: '1.00' })
    const checkout = new HoodPayCheckout({ intentId: intent.id, fetchImpl })
    const snapshot = await checkout.load()
    expect(snapshot.state).toBe('failed')
    expect(snapshot.error?.message).toContain('apiBase')
  })
})
