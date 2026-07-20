import { describe, expect, it } from 'vitest'

import { ConfigError } from '../src/core/errors.js'
import {
  DEFAULT_EXPIRY_SECONDS,
  assertTransition,
  canTransition,
  canonicalMetadata,
  createIntent,
  deriveIntentId,
  deserializeIntent,
  effectiveStatus,
  intentFingerprint,
  isPayable,
  serializeIntent,
} from '../src/core/intent.js'
import type { IntentStatus } from '../src/core/types.js'

const PAY_TO = '0x1111111111111111111111111111111111111111'
const NOW = 1_800_000_000

describe('createIntent', () => {
  it('builds a payable intent with atomic amount and derived expiry', async () => {
    const intent = await createIntent(
      { amount: '12.50', payTo: PAY_TO, description: 'One coffee' },
      { now: NOW },
    )
    expect(intent.object).toBe('payment_intent')
    expect(intent.id).toMatch(/^pi_[0-9a-f]{32}$/)
    expect(intent.amount).toBe(12_500_000n)
    expect(intent.status).toBe('requires_payment')
    expect(intent.network).toBe('robinhood')
    expect(intent.chainId).toBe(4663)
    expect(intent.asset).toBe('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168')
    expect(intent.createdAt).toBe(NOW)
    expect(intent.expiresAt).toBe(NOW + DEFAULT_EXPIRY_SECONDS)
  })

  it('honours the testnet alias', async () => {
    const intent = await createIntent({ amount: '1', payTo: PAY_TO, network: 'testnet' }, { now: NOW })
    expect(intent.chainId).toBe(46630)
    expect(intent.network).toBe('robinhood-testnet')
  })

  it('rejects a zero amount, a bad address, and an out-of-range expiry', async () => {
    await expect(createIntent({ amount: '0', payTo: PAY_TO })).rejects.toThrow(/greater than zero/)
    await expect(createIntent({ amount: '1', payTo: '0xnope' })).rejects.toThrow(ConfigError)
    await expect(
      createIntent({ amount: '1', payTo: PAY_TO, expiresInSeconds: 5 }),
    ).rejects.toThrow(/expiresInSeconds/)
    await expect(
      createIntent({ amount: '1', payTo: PAY_TO, expiresInSeconds: 90_000 }),
    ).rejects.toThrow(/expiresInSeconds/)
  })

  it('refuses a redirect URL that is not http or https', async () => {
    await expect(
      createIntent({
        amount: '1',
        payTo: PAY_TO,
        successUrl: 'javascript:alert(1)',
      }),
    ).rejects.toThrow(/http or https/)
  })

  it('rejects oversized metadata rather than silently trimming it', async () => {
    await expect(
      createIntent({ amount: '1', payTo: PAY_TO, metadata: { note: 'x'.repeat(501) } }),
    ).rejects.toThrow(/maximum is 500/)
    const tooMany = Object.fromEntries(
      Array.from({ length: 31 }, (_, i) => [`k${i}`, 'v']),
    ) as Record<string, string>
    await expect(
      createIntent({ amount: '1', payTo: PAY_TO, metadata: tooMany }),
    ).rejects.toThrow(/maximum is 30/)
  })
})

describe('idempotency', () => {
  it('derives the same id for the same merchant and key', async () => {
    const a = await deriveIntentId('shop', 'order-42')
    const b = await deriveIntentId('shop', 'order-42')
    expect(a).toBe(b)
  })

  it('derives different ids across merchants and across keys', async () => {
    expect(await deriveIntentId('shop', 'order-42')).not.toBe(
      await deriveIntentId('other', 'order-42'),
    )
    expect(await deriveIntentId('shop', 'order-42')).not.toBe(
      await deriveIntentId('shop', 'order-43'),
    )
  })

  it('produces a random id when no key is given', async () => {
    expect(await deriveIntentId('shop')).not.toBe(await deriveIntentId('shop'))
  })

  it('fingerprints the economically meaningful parameters only', async () => {
    const base = {
      merchantId: 'shop',
      amount: 1_000_000n,
      payTo: PAY_TO,
      network: 'robinhood',
      description: 'thing',
      metadata: { a: '1' },
    }
    expect(await intentFingerprint(base)).toBe(
      await intentFingerprint({ ...base, payTo: PAY_TO.toUpperCase().replace('0X', '0x') }),
    )
    expect(await intentFingerprint(base)).not.toBe(
      await intentFingerprint({ ...base, amount: 1_000_001n }),
    )
    expect(await intentFingerprint(base)).not.toBe(
      await intentFingerprint({ ...base, metadata: { a: '2' } }),
    )
  })

  it('encodes metadata unambiguously so key and value cannot collide', () => {
    expect(canonicalMetadata({ a: 'b|c' })).not.toBe(canonicalMetadata({ 'a|b': 'c' }))
    // Key order does not change the encoding.
    expect(canonicalMetadata({ b: '2', a: '1' })).toBe(canonicalMetadata({ a: '1', b: '2' }))
  })
})

describe('lifecycle state machine', () => {
  const legal: Array<[IntentStatus, IntentStatus]> = [
    ['requires_payment', 'processing'],
    ['requires_payment', 'canceled'],
    ['requires_payment', 'expired'],
    ['processing', 'succeeded'],
    ['processing', 'failed'],
    ['failed', 'processing'],
    ['failed', 'canceled'],
  ]

  const illegal: Array<[IntentStatus, IntentStatus]> = [
    ['succeeded', 'processing'],
    ['succeeded', 'failed'],
    ['succeeded', 'canceled'],
    ['canceled', 'processing'],
    ['expired', 'processing'],
    ['requires_payment', 'succeeded'],
    ['processing', 'canceled'],
  ]

  it.each(legal)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true)
    expect(() => assertTransition('pi_x', from, to)).not.toThrow()
  })

  it.each(illegal)('forbids %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false)
    expect(() => assertTransition('pi_x', from, to)).toThrow(/cannot move to/)
  })

  it('reports a settled intent as already paid when a transition is attempted', () => {
    try {
      assertTransition('pi_x', 'succeeded', 'processing')
      throw new Error('should have thrown')
    } catch (err) {
      expect((err as { code: string }).code).toBe('intent_already_paid')
    }
  })
})

describe('expiry', () => {
  it('folds expiry into the effective status without mutating the record', async () => {
    const intent = await createIntent({ amount: '1', payTo: PAY_TO }, { now: NOW })
    expect(effectiveStatus(intent, NOW + 10)).toBe('requires_payment')
    expect(effectiveStatus(intent, intent.expiresAt)).toBe('expired')
    expect(intent.status).toBe('requires_payment')
  })

  it('never resurrects a terminal status', async () => {
    const intent = await createIntent({ amount: '1', payTo: PAY_TO }, { now: NOW })
    const settled = { ...intent, status: 'succeeded' as const }
    expect(effectiveStatus(settled, intent.expiresAt + 1000)).toBe('succeeded')
  })

  it('is payable only before the deadline', async () => {
    const intent = await createIntent({ amount: '1', payTo: PAY_TO }, { now: NOW })
    expect(isPayable(intent, NOW)).toBe(true)
    expect(isPayable(intent, intent.expiresAt - 1)).toBe(true)
    expect(isPayable(intent, intent.expiresAt)).toBe(false)
    expect(isPayable({ ...intent, status: 'succeeded' }, NOW)).toBe(false)
    expect(isPayable({ ...intent, status: 'failed' }, NOW)).toBe(true)
  })
})

describe('serialization', () => {
  it('round-trips an intent through the wire form', async () => {
    const intent = await createIntent(
      { amount: '3.25', payTo: PAY_TO, metadata: { orderId: '42' }, idempotencyKey: 'k' },
      { now: NOW },
    )
    const withChainData = { ...intent, blockNumber: 12_345n }
    const wire = serializeIntent(withChainData)
    expect(wire.amount).toBe('3250000')
    expect(wire.amountFormatted).toBe('3.250000')
    expect(wire.blockNumber).toBe('12345')
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire)
    expect(deserializeIntent(wire)).toEqual(withChainData)
  })

  it('reports the expiry-adjusted status when given a clock', async () => {
    const intent = await createIntent({ amount: '1', payTo: PAY_TO }, { now: NOW })
    expect(serializeIntent(intent, intent.expiresAt).status).toBe('expired')
  })
})
