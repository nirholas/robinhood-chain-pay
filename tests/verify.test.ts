/**
 * The standalone verifier. Each check is made to fail on its own so that a
 * check silently passing everything would be caught.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { deriveNonce } from '../src/core/eip712.js'
import { createIntent } from '../src/core/intent.js'
import { ROBINHOOD_TESTNET } from '../src/core/networks.js'
import type { Hex } from '../src/core/networks.js'
import type { PaymentIntent, PaymentReceipt } from '../src/core/types.js'
import { HoodPayMerchant } from '../src/server/merchant.js'
import { MemoryStore } from '../src/server/store.js'
import {
  formatVerification,
  verifyPaymentByHash,
  verifyReceipt,
  type VerificationResult,
} from '../src/verify/index.js'
import { FakeUsdgChain, signAuthorization, testAccount } from './helpers.js'

const NET = ROBINHOOD_TESTNET
const PAY_TO = '0x1111111111111111111111111111111111111111'
const NOW = 1_800_000_000
const payer = testAccount(41)

let chain: FakeUsdgChain
let merchant: HoodPayMerchant
let receipt: PaymentReceipt
let intent: PaymentIntent

function failed(result: VerificationResult): string[] {
  return result.checks.filter((c) => !c.ok).map((c) => c.id)
}

beforeEach(async () => {
  chain = new FakeUsdgChain(NET)
  chain.credit(payer.address, 100_000_000n)
  merchant = new HoodPayMerchant({
    payTo: PAY_TO,
    network: 'robinhood-testnet',
    merchantId: 'verify-shop',
    store: new MemoryStore(),
    now: () => NOW,
    relayer: { reader: chain.reader, writer: chain.writer, address: '0x9999999999999999999999999999999999999999' },
  })
  const created = await merchant.createIntent({ amount: '7.25', metadata: { orderId: '99' } })
  const signed = await signAuthorization(payer, NET, {
    from: payer.address,
    to: PAY_TO,
    value: created.amount.toString(),
    validAfter: '0',
    validBefore: String(NOW + 900),
    nonce: await deriveNonce(created.id, payer.address),
  })
  const result = await merchant.pay(created.id, signed)
  receipt = result.receipt as PaymentReceipt
  intent = result.intent
})

describe('verifyReceipt', () => {
  it('passes every check for a genuine payment', async () => {
    const result = await verifyReceipt({ receipt, client: chain.reader, intent })
    expect(result.valid).toBe(true)
    expect(result.checks.map((c) => c.id).sort()).toEqual([
      'authorization_consumed',
      'authorization_used_event',
      'matches_intent',
      'receipt_digest',
      'target_is_usdg',
      'transaction_succeeded',
      'transfer_matches',
    ])
    expect(result.observedAmount).toBe(7_250_000n)
    expect(result.observedAmountFormatted).toBe('7.250000')
    expect(result.payer).toBe(payer.address)
    expect(result.txUrl).toContain(NET.explorerUrl)
  })

  it('works with no intent supplied, confirming the on-chain facts alone', async () => {
    const result = await verifyReceipt({ receipt, client: chain.reader })
    expect(result.valid).toBe(true)
    expect(result.checks.some((c) => c.id === 'matches_intent')).toBe(false)
  })

  it('fails when the receipt amount was raised after issuance', async () => {
    const tampered = { ...receipt, amount: receipt.amount * 2n }
    const result = await verifyReceipt({ receipt: tampered, client: chain.reader })
    expect(result.valid).toBe(false)
    expect(failed(result)).toContain('receipt_digest')
    expect(failed(result)).toContain('transfer_matches')
  })

  it('fails when the receipt recipient was swapped after issuance', async () => {
    const tampered = { ...receipt, to: '0x2222222222222222222222222222222222222222' as const }
    const result = await verifyReceipt({ receipt: tampered, client: chain.reader })
    expect(result.valid).toBe(false)
    expect(failed(result)).toContain('transfer_matches')
  })

  it('fails when the payer was swapped after issuance', async () => {
    const tampered = { ...receipt, from: '0x3333333333333333333333333333333333333333' as const }
    const result = await verifyReceipt({ receipt: tampered, client: chain.reader })
    expect(result.valid).toBe(false)
    expect(failed(result)).toEqual(
      expect.arrayContaining(['transfer_matches', 'authorization_used_event', 'authorization_consumed']),
    )
  })

  it('fails when the transaction hash points at nothing', async () => {
    const tampered = { ...receipt, txHash: '0xdead'.padEnd(66, '0') as Hex }
    const result = await verifyReceipt({ receipt: tampered, client: chain.reader })
    expect(result.valid).toBe(false)
    expect(failed(result)).toContain('transaction_succeeded')
  })

  it('fails when the receipt does not satisfy the intent it names', async () => {
    const otherIntent = await createIntent(
      { amount: '999', payTo: PAY_TO, network: 'robinhood-testnet' },
      { now: NOW },
    )
    const result = await verifyReceipt({ receipt, client: chain.reader, intent: otherIntent })
    expect(result.valid).toBe(false)
    expect(failed(result)).toContain('matches_intent')
  })

  it('fails when the nonce is not consumed on-chain', async () => {
    chain.used.clear()
    const result = await verifyReceipt({ receipt, client: chain.reader })
    expect(result.valid).toBe(false)
    expect(failed(result)).toContain('authorization_consumed')
  })

  it('renders a readable summary', async () => {
    const result = await verifyReceipt({ receipt, client: chain.reader, intent })
    const text = formatVerification(result)
    expect(text).toContain('PASS')
    expect(text).toContain('robinhood-testnet')
    expect(text.split('\n').length).toBeGreaterThan(5)
  })
})

describe('verifyPaymentByHash', () => {
  it('confirms a payment from nothing but a hash, recipient, and amount', async () => {
    const result = await verifyPaymentByHash({
      txHash: receipt.txHash,
      network: 'robinhood-testnet',
      payTo: PAY_TO,
      amount: 7_250_000n,
      client: chain.reader,
    })
    expect(result.valid).toBe(true)
    expect(result.payer).toBe(payer.address)
  })

  it('rejects a different expected amount', async () => {
    const result = await verifyPaymentByHash({
      txHash: receipt.txHash,
      network: 'robinhood-testnet',
      payTo: PAY_TO,
      amount: 7_250_001n,
      client: chain.reader,
    })
    expect(result.valid).toBe(false)
    expect(failed(result)).toContain('transfer_matches')
    expect(result.observedAmountFormatted).toBe('7.250000')
  })

  it('rejects a different expected recipient', async () => {
    const result = await verifyPaymentByHash({
      txHash: receipt.txHash,
      network: 'robinhood-testnet',
      payTo: '0x4444444444444444444444444444444444444444',
      amount: 7_250_000n,
      client: chain.reader,
    })
    expect(result.valid).toBe(false)
    expect(failed(result)).toContain('transfer_matches')
  })

  it('reports an unreadable transaction rather than throwing', async () => {
    const result = await verifyPaymentByHash({
      txHash: '0xbeef'.padEnd(66, '0') as Hex,
      network: 'robinhood-testnet',
      payTo: PAY_TO,
      amount: 1n,
      client: chain.reader,
    })
    expect(result.valid).toBe(false)
    expect(failed(result)).toContain('transaction_succeeded')
  })
})
