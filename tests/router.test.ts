/**
 * The HTTP surface, exercised through the framework-agnostic router (which is
 * what both the Express and Hono adapters call).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { deriveNonce } from '../src/core/eip712.js'
import { ROBINHOOD_TESTNET } from '../src/core/networks.js'
import { HoodPayMerchant } from '../src/server/merchant.js'
import { MemoryStore } from '../src/server/store.js'
import { createRouter, type HoodPayRequest, type HoodPayResponse } from '../src/server/router.js'
import { FakeUsdgChain, signAuthorization, testAccount } from './helpers.js'

const NET = ROBINHOOD_TESTNET
const PAY_TO = '0x1111111111111111111111111111111111111111' as const
const API_KEY = 'sk_test_hoodpay_router'
const NOW = 1_800_000_000

const payer = testAccount(31)

let chain: FakeUsdgChain
let merchant: HoodPayMerchant
let handle: ReturnType<typeof createRouter>

function req(
  method: string,
  path: string,
  options: { body?: unknown; auth?: string } = {},
): HoodPayRequest {
  return {
    method,
    path,
    headers: options.auth ? { authorization: `Bearer ${options.auth}` } : {},
    ...(options.body !== undefined ? { body: options.body } : {}),
  }
}

function body<T>(response: HoodPayResponse): T {
  return JSON.parse(response.body) as T
}

beforeEach(() => {
  chain = new FakeUsdgChain(NET)
  chain.credit(payer.address, 100_000_000n)
  merchant = new HoodPayMerchant({
    payTo: PAY_TO,
    network: 'robinhood-testnet',
    merchantId: 'router-shop',
    baseUrl: 'https://shop.example.com',
    store: new MemoryStore(),
    now: () => NOW,
    relayer: { reader: chain.reader, writer: chain.writer, address: '0x9999999999999999999999999999999999999999' },
  })
  handle = createRouter({ merchant, apiKey: API_KEY, merchantName: 'Example Shop' })
})

describe('healthz', () => {
  it('reports the merchant and network', async () => {
    const res = await handle(req('GET', '/healthz'))
    expect(res.status).toBe(200)
    expect(body<{ ok: boolean; chainId: number }>(res)).toMatchObject({ ok: true, chainId: 46630 })
  })
})

describe('merchant routes', () => {
  it('creates an intent with a valid key', async () => {
    const res = await handle(
      req('POST', '/api/intents', { auth: API_KEY, body: { amount: '12.50', description: 'Widget' } }),
    )
    expect(res.status).toBe(201)
    expect(body<{ intent: { amount: string } }>(res).intent.amount).toBe('12500000')
  })

  it('creates a payment link when asked', async () => {
    const res = await handle(
      req('POST', '/api/intents', { auth: API_KEY, body: { amount: '1', link: true } }),
    )
    expect(res.status).toBe(201)
    expect(body<{ url: string }>(res).url).toMatch(/^https:\/\/shop\.example\.com\/pay\/pi_/)
  })

  it('rejects creation without a key, with a wrong key, and with a malformed header', async () => {
    for (const options of [{}, { auth: 'sk_wrong' }, { auth: '' }]) {
      const res = await handle(req('POST', '/api/intents', { ...options, body: { amount: '1' } }))
      expect(res.status).toBe(401)
      expect(res.headers['www-authenticate']).toContain('Bearer')
    }
  })

  it('disables merchant routes entirely when no key is configured', async () => {
    const open = createRouter({ merchant })
    const res = await open(req('POST', '/api/intents', { auth: 'anything', body: { amount: '1' } }))
    expect(res.status).toBe(401)
    expect(res.body).toContain('intent creation over HTTP is disabled')
  })

  it('surfaces an idempotency conflict as 409', async () => {
    await handle(req('POST', '/api/intents', { auth: API_KEY, body: { amount: '1', idempotencyKey: 'k1' } }))
    const res = await handle(
      req('POST', '/api/intents', { auth: API_KEY, body: { amount: '9', idempotencyKey: 'k1' } }),
    )
    expect(res.status).toBe(409)
    expect(body<{ error: { code: string } }>(res).error.code).toBe('idempotency_conflict')
  })

  it('validates the amount and reports a 400', async () => {
    const res = await handle(req('POST', '/api/intents', { auth: API_KEY, body: { amount: '0' } }))
    expect(res.status).toBe(400)
    expect(body<{ error: { code: string } }>(res).error.code).toBe('config_invalid')
  })

  it('lists and cancels only with a key', async () => {
    const created = body<{ intent: { id: string } }>(
      await handle(req('POST', '/api/intents', { auth: API_KEY, body: { amount: '1' } })),
    )
    expect((await handle(req('GET', '/api/intents'))).status).toBe(401)
    const list = await handle(req('GET', '/api/intents', { auth: API_KEY }))
    expect(body<{ intents: unknown[] }>(list).intents).toHaveLength(1)

    expect((await handle(req('POST', `/api/intents/${created.intent.id}/cancel`))).status).toBe(401)
    const canceled = await handle(
      req('POST', `/api/intents/${created.intent.id}/cancel`, { auth: API_KEY }),
    )
    expect(body<{ intent: { status: string } }>(canceled).intent.status).toBe('canceled')
  })
})

describe('public routes', () => {
  it('serves a checkout session without credentials and without secrets', async () => {
    const intent = await merchant.createIntent({ amount: '12.50' })
    const res = await handle(req('GET', `/api/intents/${intent.id}`))
    expect(res.status).toBe(200)
    const session = body<{ network: { chainId: number }; intent: { amount: string } }>(res)
    expect(session.network.chainId).toBe(46630)
    expect(session.intent.amount).toBe('12500000')
    expect(res.body).not.toContain(API_KEY)
  })

  it('returns 404 for an unknown intent', async () => {
    const res = await handle(req('GET', '/api/intents/pi_missing'))
    expect(res.status).toBe(404)
    expect(body<{ error: { code: string } }>(res).error.code).toBe('intent_not_found')
  })

  it('accepts a signed authorization and settles it', async () => {
    const intent = await merchant.createIntent({ amount: '4.00' })
    const authorization = {
      from: payer.address,
      to: PAY_TO,
      value: intent.amount.toString(),
      validAfter: '0',
      validBefore: String(NOW + 900),
      nonce: await deriveNonce(intent.id, payer.address),
    }
    const signed = await signAuthorization(payer, NET, authorization)

    const res = await handle(req('POST', `/api/intents/${intent.id}/pay`, { body: signed }))
    expect(res.status).toBe(200)
    const paid = body<{ intent: { status: string }; receipt: { amount: string }; explorerTxUrl: string }>(res)
    expect(paid.intent.status).toBe('succeeded')
    expect(paid.receipt.amount).toBe('4000000')
    expect(paid.explorerTxUrl).toContain(NET.explorerUrl)
  })

  it('rejects a pay request with a missing or malformed body', async () => {
    const intent = await merchant.createIntent({ amount: '1.00' })
    for (const bad of [{}, { signature: '0xdead' }, { authorization: {} }]) {
      const res = await handle(req('POST', `/api/intents/${intent.id}/pay`, { body: bad }))
      expect(res.status).toBe(400)
    }
  })

  it('maps a tampered amount to a 400 with a specific code', async () => {
    const intent = await merchant.createIntent({ amount: '4.00' })
    const signed = await signAuthorization(payer, NET, {
      from: payer.address,
      to: PAY_TO,
      value: '1',
      validAfter: '0',
      validBefore: String(NOW + 900),
      nonce: await deriveNonce(intent.id, payer.address),
    })
    const res = await handle(req('POST', `/api/intents/${intent.id}/pay`, { body: signed }))
    expect(res.status).toBe(400)
    expect(body<{ error: { code: string } }>(res).error.code).toBe('amount_mismatch')
  })

  it('serves a receipt only after settlement', async () => {
    const intent = await merchant.createIntent({ amount: '1.00' })
    const early = await handle(req('GET', `/api/intents/${intent.id}/receipt`))
    expect(early.status).toBe(404)

    const signed = await signAuthorization(payer, NET, {
      from: payer.address,
      to: PAY_TO,
      value: intent.amount.toString(),
      validAfter: '0',
      validBefore: String(NOW + 900),
      nonce: await deriveNonce(intent.id, payer.address),
    })
    await handle(req('POST', `/api/intents/${intent.id}/pay`, { body: signed }))
    const late = await handle(req('GET', `/api/intents/${intent.id}/receipt`))
    expect(late.status).toBe(200)
    expect(body<{ receipt: { digest: string } }>(late).receipt.digest).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('hosted checkout page', () => {
  it('renders a complete document with the amount visible without JavaScript', async () => {
    const intent = await merchant.createIntent({
      amount: '12.50',
      description: 'One large widget',
    })
    const res = await handle(req('GET', `/pay/${intent.id}`))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body.startsWith('<!doctype html>')).toBe(true)
    expect(res.body).toContain('12.50')
    expect(res.body).toContain('One large widget')
    expect(res.body).toContain('Example Shop')
    expect(res.body).toContain('<noscript>')
    // Self-contained: no external stylesheet, script, font, or image.
    expect(res.body).not.toMatch(/<script[^>]+src=/)
    expect(res.body).not.toMatch(/<link[^>]+stylesheet/)
  })

  it('sets a content security policy that forbids remote code', async () => {
    const intent = await merchant.createIntent({ amount: '1.00' })
    const res = await handle(req('GET', `/pay/${intent.id}`))
    const csp = res.headers['content-security-policy'] as string
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('escapes a description that contains markup', async () => {
    const intent = await merchant.createIntent({
      amount: '1.00',
      description: '<img src=x onerror=alert(1)>',
    })
    const res = await handle(req('GET', `/pay/${intent.id}`))
    expect(res.body).not.toContain('<img src=x')
    expect(res.body).toContain('&lt;img src=x')
  })

  it('escapes metadata inside the embedded JSON so it cannot close the script tag', async () => {
    const intent = await merchant.createIntent({
      amount: '1.00',
      metadata: { evil: '</script><script>alert(1)</script>' },
    })
    const res = await handle(req('GET', `/pay/${intent.id}`))
    expect(res.body).not.toContain('</script><script>alert(1)')
    expect(res.body).toContain('\\u003c/script')
  })

  it('reports 404 for an unknown payment link', async () => {
    const res = await handle(req('GET', '/pay/pi_missing'))
    expect(res.status).toBe(404)
  })
})

describe('mounting under a base path', () => {
  it('serves routes under the prefix and rejects unprefixed paths', async () => {
    const mounted = createRouter({ merchant, apiKey: API_KEY, basePath: '/hood-pay' })
    expect((await mounted(req('GET', '/hood-pay/healthz'))).status).toBe(200)
    expect((await mounted(req('GET', '/healthz'))).status).toBe(404)
  })
})

describe('unknown routes', () => {
  it('answers 404 rather than throwing', async () => {
    for (const path of ['/', '/nope', '/api', '/api/other', '/api/intents/a/b/c']) {
      const res = await handle(req('GET', path))
      expect(res.status).toBe(404)
    }
  })
})
