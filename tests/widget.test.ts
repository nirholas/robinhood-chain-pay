/**
 * The widget's designed states.
 *
 * `describeState` is the whole presentation layer, so testing it covers every
 * state the modal can render without needing a DOM. The exhaustiveness test is
 * the important one: it fails if a state is ever added without a design.
 */

import { describe, expect, it } from 'vitest'

import type { CheckoutSnapshot, CheckoutState } from '../src/client/index.js'
import { stateForErrorCode } from '../src/client/index.js'
import { describeState, explorerLink, payLabel, receiptFingerprint } from '../src/widget/view-model.js'

const ALL_STATES: CheckoutState[] = [
  'loading',
  'idle',
  'wallet-missing',
  'wrong-chain',
  'insufficient-usdg',
  'awaiting-signature',
  'relaying',
  'settled',
  'failed',
  'expired',
  'canceled',
]

const session = {
  intent: {
    object: 'payment_intent' as const,
    id: 'pi_test',
    merchantId: 'shop',
    status: 'requires_payment' as const,
    amount: '12500000',
    amountFormatted: '12.500000',
    network: 'robinhood',
    chainId: 4663,
    asset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const,
    payTo: '0x1111111111111111111111111111111111111111' as const,
    description: 'Widget',
    metadata: {},
    createdAt: 1_800_000_000,
    expiresAt: 1_800_000_900,
  },
  network: {
    id: 'robinhood',
    chainId: 4663,
    chainIdHex: '0x1237',
    label: 'Robinhood Chain',
    rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
    explorerUrl: 'https://robinhoodchain.blockscout.com',
    usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const,
    usdgDecimals: 6,
    usdgDomain: { name: 'Global Dollar', version: '1' },
    testnet: false,
  },
  authorizationValiditySeconds: 900,
}

function snapshotFor(state: CheckoutState, extra: Partial<CheckoutSnapshot> = {}): CheckoutSnapshot {
  return { state, message: `message for ${state}`, wallets: [], session, ...extra }
}

describe('describeState', () => {
  it.each(ALL_STATES)('designs the %s state completely', (state) => {
    const view = describeState(snapshotFor(state))
    expect(view.state).toBe(state)
    expect(view.label.length).toBeGreaterThan(0)
    expect(view.message.length).toBeGreaterThan(0)
    expect(view.actionLabel.length).toBeGreaterThan(0)
    expect(['neutral', 'progress', 'success', 'warning', 'danger']).toContain(view.tone)
    expect(['pay', 'retry', 'close', 'none']).toContain(view.action)
    expect(typeof view.actionEnabled).toBe('boolean')
    expect(typeof view.busy).toBe('boolean')
  })

  it('never leaves the button enabled with nothing to do', () => {
    for (const state of ALL_STATES) {
      const view = describeState(snapshotFor(state))
      if (view.action === 'none') expect(view.actionEnabled).toBe(false)
      if (view.actionEnabled) expect(view.action).not.toBe('none')
    }
  })

  it('shows a busy indicator exactly while the payment is in flight', () => {
    const busy = ALL_STATES.filter((s) => describeState(snapshotFor(s)).busy)
    expect(busy.sort()).toEqual(['awaiting-signature', 'loading', 'relaying'])
  })

  it('disables the button while awaiting a signature and while relaying', () => {
    for (const state of ['awaiting-signature', 'relaying'] as const) {
      expect(describeState(snapshotFor(state)).actionEnabled).toBe(false)
    }
  })

  it('prices the button from the intent in the idle state', () => {
    expect(describeState(snapshotFor('idle')).actionLabel).toBe('Pay 12.50 USDG')
  })

  it('falls back to a generic label when the session has not loaded', () => {
    expect(payLabel({ state: 'loading', message: '', wallets: [] })).toBe('Pay with USDG')
  })

  it('offers a retry only from recoverable states', () => {
    const retryable = ALL_STATES.filter((s) => describeState(snapshotFor(s)).action === 'retry')
    expect(retryable.sort()).toEqual(['failed', 'insufficient-usdg', 'wrong-chain'])
  })

  it('offers a close from terminal states', () => {
    const closable = ALL_STATES.filter((s) => describeState(snapshotFor(s)).action === 'close')
    expect(closable.sort()).toEqual(['canceled', 'expired', 'settled'])
  })

  it('colours failure states as danger and wallet problems as warning', () => {
    expect(describeState(snapshotFor('failed')).tone).toBe('danger')
    expect(describeState(snapshotFor('insufficient-usdg')).tone).toBe('danger')
    expect(describeState(snapshotFor('wallet-missing')).tone).toBe('warning')
    expect(describeState(snapshotFor('wrong-chain')).tone).toBe('warning')
    expect(describeState(snapshotFor('settled')).tone).toBe('success')
  })

  it('carries the snapshot message through to the customer', () => {
    const view = describeState(snapshotFor('failed', { message: 'Your wallet is out of USDG.' }))
    expect(view.message).toBe('Your wallet is out of USDG.')
  })
})

describe('settled state extras', () => {
  const settled = snapshotFor('settled', {
    result: {
      intent: { ...session.intent, status: 'succeeded' as const },
      receipt: {
        object: 'payment_receipt' as const,
        version: 1 as const,
        intentId: 'pi_test',
        merchantId: 'shop',
        network: 'robinhood',
        chainId: 4663,
        asset: session.network.usdg,
        from: '0x2222222222222222222222222222222222222222' as const,
        to: session.intent.payTo,
        amount: '12500000',
        amountFormatted: '12.500000',
        nonce: '0xab'.padEnd(66, '0') as `0x${string}`,
        validAfter: '0',
        validBefore: '1800000900',
        txHash: '0xcd'.padEnd(66, '0') as `0x${string}`,
        blockNumber: '42',
        settledAt: 1_800_000_100,
        metadataHash: '0xef'.padEnd(66, '0') as `0x${string}`,
        digest: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' as `0x${string}`,
      },
      explorerTxUrl: 'https://robinhoodchain.blockscout.com/tx/0xcd',
    },
  })

  it('exposes a short receipt fingerprint and the explorer link', () => {
    expect(receiptFingerprint(settled)).toBe('0x0123456789abcdef...')
    expect(explorerLink(settled)).toBe('https://robinhoodchain.blockscout.com/tx/0xcd')
  })

  it('has neither before settlement', () => {
    expect(receiptFingerprint(snapshotFor('idle'))).toBeUndefined()
    expect(explorerLink(snapshotFor('idle'))).toBeUndefined()
  })
})

describe('stateForErrorCode', () => {
  it.each([
    ['insufficient_funds', 'insufficient-usdg'],
    ['intent_expired', 'expired'],
    ['authorization_expired', 'expired'],
    ['intent_canceled', 'canceled'],
    ['intent_already_paid', 'settled'],
    ['wallet_not_found', 'wallet-missing'],
    ['wrong_chain', 'wrong-chain'],
    ['wallet_rejected', 'idle'],
    ['relay_failed', 'failed'],
    ['something_unknown', 'failed'],
  ] as const)('maps %s to the %s state', (code, expected) => {
    expect(stateForErrorCode(code)).toBe(expected)
  })

  it('always lands on a state the widget has a design for', () => {
    for (const code of [
      'config_invalid',
      'intent_not_found',
      'amount_mismatch',
      'recipient_mismatch',
      'invalid_signature',
      'settlement_reverted',
      'network_error',
    ]) {
      expect(ALL_STATES).toContain(stateForErrorCode(code))
    }
  })
})
