import { describe, expect, it } from 'vitest'

import { createIntent } from '../src/core/intent.js'
import {
  buildReceipt,
  canonicalReceipt,
  deserializeReceipt,
  isDigestValid,
  metadataHash,
  receiptDigest,
  serializeReceipt,
} from '../src/core/receipt.js'
import type { Hex } from '../src/core/networks.js'
import type { PaymentReceipt } from '../src/core/types.js'

const PAY_TO = '0x1111111111111111111111111111111111111111'
const PAYER = '0x2222222222222222222222222222222222222222'
const TX = '0xabc0000000000000000000000000000000000000000000000000000000000001' as Hex
const NONCE = '0xdef0000000000000000000000000000000000000000000000000000000000002' as Hex

async function makeReceipt(): Promise<PaymentReceipt> {
  const intent = await createIntent(
    { amount: '9.99', payTo: PAY_TO, description: 'Widget', metadata: { orderId: '7' } },
    { now: 1_800_000_000 },
  )
  return buildReceipt({
    intent,
    from: PAYER,
    nonce: NONCE,
    validAfter: 0n,
    validBefore: 1_800_000_900n,
    txHash: TX,
    blockNumber: 42n,
    settledAt: 1_800_000_100,
  })
}

describe('buildReceipt', () => {
  it('takes the amount, recipient, and asset from the intent, never the caller', async () => {
    const receipt = await makeReceipt()
    expect(receipt.amount).toBe(9_990_000n)
    expect(receipt.to).toBe(PAY_TO)
    expect(receipt.asset).toBe('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168')
    expect(receipt.from).toBe(PAYER)
    expect(receipt.version).toBe(1)
    expect(receipt.digest).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('binds metadata into the receipt through a hash', async () => {
    const receipt = await makeReceipt()
    expect(receipt.metadataHash).toBe(await metadataHash({ orderId: '7' }))
    expect(receipt.metadataHash).not.toBe(await metadataHash({ orderId: '8' }))
  })
})

describe('canonicalReceipt', () => {
  it('is stable across address and hash casing', async () => {
    const receipt = await makeReceipt()
    const upper = {
      ...receipt,
      from: receipt.from.toUpperCase().replace('0X', '0x') as typeof receipt.from,
      txHash: receipt.txHash.toUpperCase().replace('0X', '0x') as Hex,
    }
    const { digest: _d, object: _o, ...base } = receipt
    const { digest: _d2, object: _o2, ...upperBase } = upper
    expect(canonicalReceipt(upperBase)).toBe(canonicalReceipt(base))
  })

  it('length-prefixes fields so adjacent values cannot be confused', async () => {
    const receipt = await makeReceipt()
    const { digest: _d, object: _o, ...base } = receipt
    const a = canonicalReceipt({ ...base, intentId: 'pi_ab', merchantId: 'c' })
    const b = canonicalReceipt({ ...base, intentId: 'pi_a', merchantId: 'bc' })
    expect(a).not.toBe(b)
  })

  it('changes the digest when any covered field changes', async () => {
    const receipt = await makeReceipt()
    const { digest: _d, object: _o, ...base } = receipt
    const original = await receiptDigest(base)
    expect(original).toBe(receipt.digest)

    for (const mutation of [
      { amount: base.amount + 1n },
      { to: '0x3333333333333333333333333333333333333333' as const },
      { from: '0x4444444444444444444444444444444444444444' as const },
      { txHash: '0x99'.padEnd(66, '0') as Hex },
      { blockNumber: base.blockNumber + 1n },
      { settledAt: base.settledAt + 1 },
      { nonce: '0x88'.padEnd(66, '0') as Hex },
      { chainId: 46630 },
    ]) {
      expect(await receiptDigest({ ...base, ...mutation })).not.toBe(original)
    }
  })
})

describe('isDigestValid', () => {
  it('accepts an untouched receipt', async () => {
    expect(await isDigestValid(await makeReceipt())).toBe(true)
  })

  it('rejects a receipt whose amount was raised after issuance', async () => {
    const receipt = await makeReceipt()
    expect(await isDigestValid({ ...receipt, amount: receipt.amount * 2n })).toBe(false)
  })

  it('rejects a receipt whose recipient was swapped after issuance', async () => {
    const receipt = await makeReceipt()
    expect(
      await isDigestValid({ ...receipt, to: '0x5555555555555555555555555555555555555555' }),
    ).toBe(false)
  })
})

describe('serialization', () => {
  it('round-trips through the wire form with every bigint preserved', async () => {
    const receipt = await makeReceipt()
    const wire = serializeReceipt(receipt)
    expect(wire.amount).toBe('9990000')
    expect(wire.amountFormatted).toBe('9.990000')
    expect(wire.blockNumber).toBe('42')
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire)
    expect(deserializeReceipt(wire)).toEqual(receipt)
  })
})
