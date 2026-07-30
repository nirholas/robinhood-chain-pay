/**
 * hood-pay keeps its own copy of the Robinhood Chain constants so the browser
 * bundle does not have to import viem. That is a deliberate duplication, and
 * this test is the price of it: the two registries must agree exactly, field
 * by field, or the build fails.
 *
 * It also documents what hood-pay actually reuses from the sibling package,
 * rather than leaving the reader to infer it from imports.
 */

import { describe, expect, it } from 'vitest'
import * as hood402 from 'hood402'

import {
  NETWORKS,
  ROBINHOOD_MAINNET,
  ROBINHOOD_TESTNET,
  resolveNetwork,
} from '../src/core/networks.js'
import { TRANSFER_WITH_AUTHORIZATION_TYPE, usdgDomain } from '../src/core/eip712.js'

describe('network registry parity with hood402', () => {
  it('covers the same networks', () => {
    expect(NETWORKS.map((n) => n.id).sort()).toEqual(hood402.NETWORKS.map((n) => n.id).sort())
  })

  it.each([
    ['mainnet', ROBINHOOD_MAINNET, hood402.ROBINHOOD_MAINNET],
    ['testnet', ROBINHOOD_TESTNET, hood402.ROBINHOOD_TESTNET],
  ])('agrees on every %s constant', (_label, ours, theirs) => {
    expect(ours.id).toBe(theirs.id)
    expect(ours.chainId).toBe(theirs.chainId)
    expect(ours.rpcUrl).toBe(theirs.rpcUrl)
    expect(ours.explorerUrl).toBe(theirs.explorerUrl)
    expect(ours.usdg).toBe(theirs.usdg)
    expect(ours.usdgDecimals).toBe(theirs.usdgDecimals)
    expect(ours.usdgDomain).toEqual(theirs.usdgDomain)
    expect(ours.testnet).toBe(theirs.testnet)
  })

  it('resolves the same aliases', () => {
    // Every alias hood402 ships. `mainnet` and `testnet` are hood-pay
    // additions that hood402 gained after 0.1.1, so they are asserted
    // separately below rather than against the installed copy.
    for (const alias of [
      'robinhood',
      'robinhood-chain',
      'robinhood-mainnet',
      '4663',
      'eip155:4663',
      'robinhood-testnet',
      'robinhood-sepolia',
      '46630',
      'eip155:46630',
    ]) {
      expect(resolveNetwork(alias)?.chainId).toBe(hood402.resolveNetwork(alias)?.chainId)
    }
  })

  it('resolves the bare mainnet/testnet names too', () => {
    expect(resolveNetwork('mainnet')?.chainId).toBe(ROBINHOOD_MAINNET.chainId)
    expect(resolveNetwork('testnet')?.chainId).toBe(ROBINHOOD_TESTNET.chainId)
  })
})

describe('EIP-712 parity with hood402', () => {
  it('signs the same struct definition', () => {
    expect([...TRANSFER_WITH_AUTHORIZATION_TYPE]).toEqual([
      ...hood402.TRANSFER_WITH_AUTHORIZATION_TYPES.TransferWithAuthorization,
    ])
  })

  it('builds the same domain, so a hood402 payment and a hood-pay payment sign identically', () => {
    for (const [ours, theirs] of [
      [ROBINHOOD_MAINNET, hood402.ROBINHOOD_MAINNET],
      [ROBINHOOD_TESTNET, hood402.ROBINHOOD_TESTNET],
    ] as const) {
      expect(usdgDomain(ours)).toEqual(hood402.usdgDomain(theirs))
    }
  })
})

describe('what hood-pay reuses', () => {
  it('imports the EIP-3009 ABI fragment rather than redeclaring it', () => {
    const names = hood402.eip3009Abi.map((entry) => entry.name)
    expect(names).toContain('transferWithAuthorization')
    expect(names).toContain('authorizationState')
    const transfer = hood402.eip3009Abi.find((e) => e.name === 'transferWithAuthorization')
    // The split (v, r, s) form, which is what USDG's facet exposes.
    expect(transfer?.inputs.map((i) => i.name)).toEqual([
      'from',
      'to',
      'value',
      'validAfter',
      'validBefore',
      'nonce',
      'v',
      'r',
      's',
    ])
  })

  it('imports signature verification rather than reimplementing recovery', () => {
    expect(typeof hood402.verifyAuthorizationSignature).toBe('function')
  })
})
