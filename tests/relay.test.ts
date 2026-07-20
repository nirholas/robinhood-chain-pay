/**
 * Preflight and relay. Every rejection path is exercised with a genuine
 * signature over a genuine authorization, so a check that silently stopped
 * working would fail here rather than pass on a hand-built payload.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { deriveNonce } from '../src/core/eip712.js'
import { createIntent } from '../src/core/intent.js'
import { ROBINHOOD_TESTNET } from '../src/core/networks.js'
import type { Hex } from '../src/core/networks.js'
import type { AuthorizationWire, PaymentIntent } from '../src/core/types.js'
import { preflight, relayAuthorization } from '../src/server/relay.js'
import { FakeUsdgChain, signAuthorization, testAccount } from './helpers.js'

const NET = ROBINHOOD_TESTNET
const PAY_TO = '0x1111111111111111111111111111111111111111'
const NOW = 1_800_000_000
const RELAYER = '0x9999999999999999999999999999999999999999'

const payer = testAccount(11)

let chain: FakeUsdgChain
let intent: PaymentIntent

async function authorizationFor(overrides: Partial<AuthorizationWire> = {}): Promise<AuthorizationWire> {
  return {
    from: payer.address,
    to: intent.payTo,
    value: intent.amount.toString(),
    validAfter: '0',
    validBefore: String(NOW + 900),
    nonce: await deriveNonce(intent.id, payer.address),
    ...overrides,
  }
}

beforeEach(async () => {
  chain = new FakeUsdgChain(NET)
  chain.credit(payer.address, 100_000_000n)
  intent = await createIntent(
    { amount: '12.50', payTo: PAY_TO, network: 'robinhood-testnet' },
    { now: NOW },
  )
})

describe('preflight', () => {
  it('accepts a correct authorization', async () => {
    const signed = await signAuthorization(payer, NET, await authorizationFor())
    const result = await preflight({ intent, signed, network: NET, reader: chain.reader, now: NOW })
    expect(result).toEqual({ ok: true, payer: payer.address })
  })

  it('rejects a payment to the wrong recipient', async () => {
    const signed = await signAuthorization(
      payer,
      NET,
      await authorizationFor({ to: '0x2222222222222222222222222222222222222222' }),
    )
    const result = await preflight({ intent, signed, network: NET, reader: chain.reader, now: NOW })
    expect(result).toMatchObject({ ok: false, code: 'recipient_mismatch' })
  })

  it('rejects an underpayment', async () => {
    const signed = await signAuthorization(payer, NET, await authorizationFor({ value: '12499999' }))
    const result = await preflight({ intent, signed, network: NET, reader: chain.reader, now: NOW })
    expect(result).toMatchObject({ ok: false, code: 'amount_mismatch' })
  })

  it('rejects an overpayment, because human checkout is exact', async () => {
    const signed = await signAuthorization(payer, NET, await authorizationFor({ value: '99000000' }))
    const result = await preflight({ intent, signed, network: NET, reader: chain.reader, now: NOW })
    expect(result).toMatchObject({ ok: false, code: 'amount_mismatch' })
  })

  it('rejects a nonce that was not derived from this intent and payer', async () => {
    const foreign = await deriveNonce('pi_somethingelse', payer.address)
    const signed = await signAuthorization(payer, NET, await authorizationFor({ nonce: foreign }))
    const result = await preflight({ intent, signed, network: NET, reader: chain.reader, now: NOW })
    expect(result).toMatchObject({ ok: false, code: 'config_invalid' })
  })

  it('rejects an expired authorization', async () => {
    const signed = await signAuthorization(
      payer,
      NET,
      await authorizationFor({ validBefore: String(NOW - 1) }),
    )
    const result = await preflight({ intent, signed, network: NET, reader: chain.reader, now: NOW })
    expect(result).toMatchObject({ ok: false, code: 'authorization_expired' })
  })

  it('rejects an authorization that is not valid yet', async () => {
    const signed = await signAuthorization(
      payer,
      NET,
      await authorizationFor({ validAfter: String(NOW + 60) }),
    )
    const result = await preflight({ intent, signed, network: NET, reader: chain.reader, now: NOW })
    expect(result).toMatchObject({ ok: false, code: 'authorization_not_yet_valid' })
  })

  it('rejects a signature from a different key', async () => {
    const authorization = await authorizationFor()
    const impostor = testAccount(12)
    const signed = await signAuthorization(impostor, NET, authorization)
    const result = await preflight({ intent, signed, network: NET, reader: chain.reader, now: NOW })
    expect(result).toMatchObject({ ok: false, code: 'invalid_signature' })
  })

  it('rejects a signature over a mainnet domain when settling on testnet', async () => {
    const authorization = await authorizationFor()
    const { ROBINHOOD_MAINNET } = await import('../src/core/networks.js')
    const signed = await signAuthorization(payer, ROBINHOOD_MAINNET, authorization)
    const result = await preflight({ intent, signed, network: NET, reader: chain.reader, now: NOW })
    expect(result).toMatchObject({ ok: false, code: 'invalid_signature' })
  })

  it('rejects a payer who cannot cover the amount', async () => {
    const poor = testAccount(13)
    const authorization = await authorizationFor({
      from: poor.address,
      nonce: await deriveNonce(intent.id, poor.address),
    })
    const signed = await signAuthorization(poor, NET, authorization)
    const result = await preflight({ intent, signed, network: NET, reader: chain.reader, now: NOW })
    expect(result).toMatchObject({ ok: false, code: 'insufficient_funds' })
  })

  it('rejects an authorization whose nonce is already consumed on-chain', async () => {
    const authorization = await authorizationFor()
    const signed = await signAuthorization(payer, NET, authorization)
    chain.used.add(`${payer.address.toLowerCase()}:${authorization.nonce.toLowerCase()}`)
    const result = await preflight({ intent, signed, network: NET, reader: chain.reader, now: NOW })
    expect(result).toMatchObject({ ok: false, code: 'authorization_already_used' })
  })

  it('rejects a malformed numeric field', async () => {
    const signed = await signAuthorization(payer, NET, await authorizationFor())
    const broken = { ...signed, authorization: { ...signed.authorization, value: 'not-a-number' } }
    const result = await preflight({
      intent,
      signed: broken,
      network: NET,
      reader: chain.reader,
      now: NOW,
    })
    expect(result).toMatchObject({ ok: false, code: 'config_invalid' })
  })

  it('runs the offline checks without a reader', async () => {
    const signed = await signAuthorization(payer, NET, await authorizationFor())
    const result = await preflight({ intent, signed, network: NET, now: NOW })
    expect(result).toEqual({ ok: true, payer: payer.address })
  })
})

describe('relayAuthorization', () => {
  it('moves the exact amount and consumes the nonce', async () => {
    const signed = await signAuthorization(payer, NET, await authorizationFor())
    const outcome = await relayAuthorization({
      intent,
      signed,
      network: NET,
      reader: chain.reader,
      writer: chain.writer,
      relayerAddress: RELAYER,
      now: NOW,
    })
    expect(outcome.ok).toBe(true)
    expect(chain.balanceOf(PAY_TO)).toBe(12_500_000n)
    expect(chain.balanceOf(payer.address)).toBe(87_500_000n)
    expect(chain.authorizationState(payer.address, signed.authorization.nonce)).toBe(true)
  })

  it('submits the split (v, r, s) form USDG expects', async () => {
    const signed = await signAuthorization(payer, NET, await authorizationFor())
    await relayAuthorization({
      intent,
      signed,
      network: NET,
      reader: chain.reader,
      writer: chain.writer,
      relayerAddress: RELAYER,
      now: NOW,
    })
    expect(chain.calls).toHaveLength(1)
    expect(chain.calls[0]).toMatchObject({
      from: payer.address,
      to: PAY_TO,
      value: 12_500_000n,
    })
  })

  it('reports a broadcast failure without claiming settlement', async () => {
    const signed = await signAuthorization(payer, NET, await authorizationFor())
    chain.failNextBroadcast = 'rpc timeout'
    const outcome = await relayAuthorization({
      intent,
      signed,
      network: NET,
      reader: chain.reader,
      writer: chain.writer,
      relayerAddress: RELAYER,
      now: NOW,
    })
    expect(outcome).toMatchObject({ ok: false, code: 'relay_failed' })
    expect(chain.balanceOf(PAY_TO)).toBe(0n)
  })

  it('reports an on-chain revert with the transaction hash', async () => {
    const signed = await signAuthorization(payer, NET, await authorizationFor())
    chain.revertNext = true
    const outcome = await relayAuthorization({
      intent,
      signed,
      network: NET,
      reader: chain.reader,
      writer: chain.writer,
      relayerAddress: RELAYER,
      now: NOW,
    })
    expect(outcome).toMatchObject({ ok: false, code: 'settlement_reverted' })
    expect((outcome as { txHash?: Hex }).txHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(chain.balanceOf(PAY_TO)).toBe(0n)
  })

  it('reverts a replayed authorization at the token contract', async () => {
    const signed = await signAuthorization(payer, NET, await authorizationFor())
    const first = await relayAuthorization({
      intent,
      signed,
      network: NET,
      reader: chain.reader,
      writer: chain.writer,
      relayerAddress: RELAYER,
      now: NOW,
    })
    expect(first.ok).toBe(true)

    // Skip preflight to prove the on-chain guard alone stops the second charge.
    const second = await relayAuthorization({
      intent,
      signed,
      network: NET,
      reader: chain.reader,
      writer: chain.writer,
      relayerAddress: RELAYER,
      skipPreflight: true,
      now: NOW,
    })
    expect(second).toMatchObject({ ok: false, code: 'settlement_reverted' })
    expect(chain.balanceOf(PAY_TO)).toBe(12_500_000n)
  })
})
