import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { HoodPayError } from '../src/core/errors.js'
import {
  DEFAULT_TOLERANCE_SECONDS,
  SIGNATURE_HEADER,
  buildEvent,
  constructWebhookEvent,
  dispatchWebhook,
  parseSignatureHeader,
  signWebhook,
  verifyWebhookSignature,
} from '../src/server/webhooks.js'
import type { WebhookEvent } from '../src/core/types.js'

const SECRET = 'whsec_test_9f2c4a'
const BODY = '{"object":"event","id":"evt_1","type":"payment_intent.succeeded"}'
const T = 1_800_000_000

const event: WebhookEvent = {
  object: 'event',
  id: 'evt_test',
  type: 'payment_intent.succeeded',
  created: T,
  data: {
    intent: {
      object: 'payment_intent',
      id: 'pi_test',
      merchantId: 'shop',
      status: 'succeeded',
      amount: '12500000',
      amountFormatted: '12.500000',
      network: 'robinhood',
      chainId: 4663,
      asset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      payTo: '0x1111111111111111111111111111111111111111',
      description: '',
      metadata: {},
      createdAt: T,
      expiresAt: T + 900,
    },
  },
}

describe('signWebhook', () => {
  it('produces the documented header format', async () => {
    const header = await signWebhook(SECRET, BODY, T)
    expect(header).toMatch(/^t=1800000000,v1=0x[0-9a-f]{64}$/)
  })

  it('matches an independent HMAC over `${t}.${body}`', async () => {
    const header = await signWebhook(SECRET, BODY, T)
    const mac = parseSignatureHeader(header)?.mac
    const expected = `0x${createHmac('sha256', SECRET).update(`${T}.${BODY}`).digest('hex')}`
    expect(mac).toBe(expected)
  })

  it('is the exact snippet a merchant can paste into Node', async () => {
    // This is the verification snippet documented in the README. If it stops
    // working, the docs are wrong and this test fails.
    const header = await signWebhook(SECRET, BODY, T)
    const [tPart, vPart] = header.split(',')
    const timestamp = (tPart as string).slice(2)
    const signature = (vPart as string).slice(3)
    const expected = createHmac('sha256', SECRET).update(`${timestamp}.${BODY}`).digest('hex')
    expect(signature).toBe(`0x${expected}`)
  })

  it('refuses to sign without a secret', async () => {
    await expect(signWebhook('', BODY, T)).rejects.toThrow(/secret is required/)
  })
})

describe('parseSignatureHeader', () => {
  it('parses a well-formed header', () => {
    expect(parseSignatureHeader('t=123,v1=0xabc')).toEqual({ timestamp: 123, mac: '0xabc' })
  })

  it('tolerates whitespace and unknown scheme versions', () => {
    expect(parseSignatureHeader('t=123, v1=0xabc, v2=0xdef')).toEqual({
      timestamp: 123,
      mac: '0xabc',
    })
  })

  it('returns null when a part is missing or malformed', () => {
    expect(parseSignatureHeader('v1=0xabc')).toBeNull()
    expect(parseSignatureHeader('t=123')).toBeNull()
    expect(parseSignatureHeader('t=notanumber,v1=0xabc')).toBeNull()
    expect(parseSignatureHeader('garbage')).toBeNull()
  })
})

describe('verifyWebhookSignature', () => {
  it('accepts a signature it just produced', async () => {
    const signature = await signWebhook(SECRET, BODY, T)
    expect(
      await verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature, now: T }),
    ).toBe(true)
  })

  it('rejects a body that changed by one byte', async () => {
    const signature = await signWebhook(SECRET, BODY, T)
    expect(
      await verifyWebhookSignature({
        secret: SECRET,
        rawBody: `${BODY} `,
        signature,
        now: T,
      }),
    ).toBe(false)
  })

  it('rejects the wrong secret', async () => {
    const signature = await signWebhook(SECRET, BODY, T)
    expect(
      await verifyWebhookSignature({ secret: 'whsec_other', rawBody: BODY, signature, now: T }),
    ).toBe(false)
  })

  it('rejects a replay outside the tolerance window', async () => {
    const signature = await signWebhook(SECRET, BODY, T)
    expect(
      await verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        signature,
        now: T + DEFAULT_TOLERANCE_SECONDS + 1,
      }),
    ).toBe(false)
    expect(
      await verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        signature,
        now: T + DEFAULT_TOLERANCE_SECONDS,
      }),
    ).toBe(true)
  })

  it('rejects a timestamp from the future as firmly as an old one', async () => {
    const signature = await signWebhook(SECRET, BODY, T + 10_000)
    expect(
      await verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature, now: T }),
    ).toBe(false)
  })

  it('rejects a signature whose timestamp was swapped for a fresh one', async () => {
    const signature = await signWebhook(SECRET, BODY, T)
    const mac = parseSignatureHeader(signature)?.mac
    const forged = `t=${T + 60},v1=${mac}`
    expect(
      await verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature: forged, now: T + 60 }),
    ).toBe(false)
  })

  it('rejects a malformed header', async () => {
    expect(
      await verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature: 'nope', now: T }),
    ).toBe(false)
  })
})

describe('constructWebhookEvent', () => {
  it('verifies and parses in one step', async () => {
    const rawBody = JSON.stringify(event)
    const signature = await signWebhook(SECRET, rawBody, T)
    const parsed = await constructWebhookEvent({ secret: SECRET, rawBody, signature, now: T })
    expect(parsed.id).toBe('evt_test')
    expect(parsed.data.intent.amount).toBe('12500000')
  })

  it('throws a typed error on a bad signature rather than returning the body', async () => {
    const rawBody = JSON.stringify(event)
    await expect(
      constructWebhookEvent({ secret: SECRET, rawBody, signature: 't=1,v1=0xdead', now: T }),
    ).rejects.toThrow(HoodPayError)
  })
})

describe('dispatchWebhook', () => {
  const noSleep = async (): Promise<void> => undefined

  it('delivers on a 2xx and signs the exact body it sends', async () => {
    let seenBody = ''
    let seenSignature = ''
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seenBody = init?.body as string
      seenSignature = (init?.headers as Record<string, string>)[SIGNATURE_HEADER] as string
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch

    const result = await dispatchWebhook({
      url: 'https://shop.example.com/hooks',
      secret: SECRET,
      event,
      fetchImpl,
      sleep: noSleep,
      now: () => T,
    })
    expect(result).toMatchObject({ delivered: true, status: 200, attempts: 1 })
    expect(
      await verifyWebhookSignature({
        secret: SECRET,
        rawBody: seenBody,
        signature: seenSignature,
        now: T,
      }),
    ).toBe(true)
  })

  it('retries a 500 up to the attempt limit', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const result = await dispatchWebhook({
      url: 'https://shop.example.com/hooks',
      secret: SECRET,
      event,
      maxAttempts: 3,
      fetchImpl,
      sleep: noSleep,
      now: () => T,
    })
    expect(result).toMatchObject({ delivered: false, status: 500, attempts: 3 })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('does not retry a permanent 4xx', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 400 })) as unknown as typeof fetch
    const result = await dispatchWebhook({
      url: 'https://shop.example.com/hooks',
      secret: SECRET,
      event,
      maxAttempts: 5,
      fetchImpl,
      sleep: noSleep,
      now: () => T,
    })
    expect(result).toMatchObject({ delivered: false, status: 400, attempts: 1 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does retry a 429 and a 408', async () => {
    for (const status of [429, 408]) {
      const fetchImpl = vi.fn(async () => new Response('', { status })) as unknown as typeof fetch
      await dispatchWebhook({
        url: 'https://shop.example.com/hooks',
        secret: SECRET,
        event,
        maxAttempts: 2,
        fetchImpl,
        sleep: noSleep,
        now: () => T,
      })
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    }
  })

  it('recovers when a transport error is followed by a success', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('ECONNRESET')
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch

    const result = await dispatchWebhook({
      url: 'https://shop.example.com/hooks',
      secret: SECRET,
      event,
      fetchImpl,
      sleep: noSleep,
      now: () => T,
    })
    expect(result).toMatchObject({ delivered: true, attempts: 2 })
  })
})

describe('buildEvent', () => {
  it('stamps a unique prefixed id and the supplied clock', () => {
    const a = buildEvent('payment_intent.created', event.data, T)
    const b = buildEvent('payment_intent.created', event.data, T)
    expect(a.id).toMatch(/^evt_[0-9a-f]{32}$/)
    expect(a.id).not.toBe(b.id)
    expect(a.created).toBe(T)
  })
})
