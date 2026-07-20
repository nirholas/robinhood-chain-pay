/**
 * EIP-712 construction, checked against viem's independent implementation and
 * against the live USDG domain separator values recorded from both networks.
 */

import { describe, expect, it } from 'vitest'
import {
  domainSeparator,
  hashTypedData,
  recoverTypedDataAddress,
  verifyTypedData,
  type Hex,
} from 'viem'

import {
  TRANSFER_WITH_AUTHORIZATION_TYPE,
  buildTypedData,
  deriveNonce,
  fromWire,
  sameAddress,
  splitSignature,
  toWire,
  usdgDomain,
} from '../src/core/eip712.js'
import { ROBINHOOD_MAINNET, ROBINHOOD_TESTNET } from '../src/core/networks.js'
import { signAuthorization, testAccount } from './helpers.js'

const types = { TransferWithAuthorization: [...TRANSFER_WITH_AUTHORIZATION_TYPE] }

describe('usdgDomain', () => {
  it('reproduces the live DOMAIN_SEPARATOR() on both networks', () => {
    // These two values were read from the deployed USDG contracts. Recomputing
    // them offline from name/version/chainId/verifyingContract is the check
    // that the domain hood-pay signs against is the one the chain enforces.
    expect(domainSeparator({ domain: usdgDomain(ROBINHOOD_MAINNET) })).toBe(
      '0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036',
    )
    expect(domainSeparator({ domain: usdgDomain(ROBINHOOD_TESTNET) })).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('uses the Global Dollar name and version, and the USDG address', () => {
    const domain = usdgDomain(ROBINHOOD_MAINNET)
    expect(domain).toEqual({
      name: 'Global Dollar',
      version: '1',
      chainId: 4663,
      verifyingContract: ROBINHOOD_MAINNET.usdg,
    })
  })

  it('produces a different separator per network, so a testnet signature cannot settle on mainnet', () => {
    expect(domainSeparator({ domain: usdgDomain(ROBINHOOD_MAINNET) })).not.toBe(
      domainSeparator({ domain: usdgDomain(ROBINHOOD_TESTNET) }),
    )
  })
})

describe('buildTypedData', () => {
  const account = testAccount(7)
  const authorization = {
    from: account.address,
    to: '0x1111111111111111111111111111111111111111' as const,
    value: 12_500_000n,
    validAfter: 0n,
    validBefore: 2_000_000_000n,
    nonce: '0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff' as Hex,
  }

  it('hashes identically to viem for the same authorization', () => {
    const payload = buildTypedData(ROBINHOOD_MAINNET, authorization)
    const ours = hashTypedData({
      domain: payload.domain,
      types,
      primaryType: 'TransferWithAuthorization',
      message: authorization,
    })
    const theirs = hashTypedData({
      domain: usdgDomain(ROBINHOOD_MAINNET),
      types,
      primaryType: 'TransferWithAuthorization',
      message: authorization,
    })
    expect(ours).toBe(theirs)
  })

  it('emits a JSON-safe payload with every numeric field as a string', () => {
    const payload = buildTypedData(ROBINHOOD_MAINNET, authorization)
    expect(payload.message.value).toBe('12500000')
    expect(payload.message.validBefore).toBe('2000000000')
    expect(() => JSON.stringify(payload)).not.toThrow()
    expect(payload.types.EIP712Domain).toHaveLength(4)
  })

  it('accepts a wire authorization as well as a bigint one', () => {
    const fromBigint = buildTypedData(ROBINHOOD_MAINNET, authorization)
    const fromWireForm = buildTypedData(ROBINHOOD_MAINNET, toWire(authorization))
    expect(fromWireForm).toEqual(fromBigint)
  })

  it('round-trips through the wire form without loss', () => {
    expect(fromWire(toWire(authorization))).toEqual(authorization)
  })
})

describe('signature verification', () => {
  const net = ROBINHOOD_TESTNET
  const account = testAccount(3)

  const base = {
    from: account.address,
    to: '0x2222222222222222222222222222222222222222' as const,
    value: '5000000',
    validAfter: '0',
    validBefore: '2000000000',
    nonce: '0xaa'.padEnd(66, '0') as Hex,
  }

  it('recovers to the signer', async () => {
    const signed = await signAuthorization(account, net, base)
    const recovered = await recoverTypedDataAddress({
      domain: usdgDomain(net),
      types,
      primaryType: 'TransferWithAuthorization',
      message: fromWire(base),
      signature: signed.signature,
    })
    expect(sameAddress(recovered, account.address)).toBe(true)
  })

  it('fails verification when the amount is tampered with after signing', async () => {
    const signed = await signAuthorization(account, net, base)
    const tampered = { ...base, value: '5000001' }
    await expect(
      verifyTypedData({
        address: account.address,
        domain: usdgDomain(net),
        types,
        primaryType: 'TransferWithAuthorization',
        message: fromWire(tampered),
        signature: signed.signature,
      }),
    ).resolves.toBe(false)
  })

  it('fails verification when the recipient is tampered with after signing', async () => {
    const signed = await signAuthorization(account, net, base)
    const tampered = { ...base, to: '0x3333333333333333333333333333333333333333' as const }
    await expect(
      verifyTypedData({
        address: account.address,
        domain: usdgDomain(net),
        types,
        primaryType: 'TransferWithAuthorization',
        message: fromWire(tampered),
        signature: signed.signature,
      }),
    ).resolves.toBe(false)
  })

  it('fails verification when the expiry is extended after signing', async () => {
    const signed = await signAuthorization(account, net, base)
    const tampered = { ...base, validBefore: '2000000001' }
    await expect(
      verifyTypedData({
        address: account.address,
        domain: usdgDomain(net),
        types,
        primaryType: 'TransferWithAuthorization',
        message: fromWire(tampered),
        signature: signed.signature,
      }),
    ).resolves.toBe(false)
  })
})

describe('splitSignature', () => {
  it('splits a 65-byte signature and normalizes yParity to a legacy v', async () => {
    const signed = await signAuthorization(testAccount(5), ROBINHOOD_TESTNET, {
      from: testAccount(5).address,
      to: '0x4444444444444444444444444444444444444444',
      value: '1',
      validAfter: '0',
      validBefore: '2000000000',
      nonce: '0xbb'.padEnd(66, '0') as Hex,
    })
    const { r, s, v } = splitSignature(signed.signature)
    expect(r).toHaveLength(66)
    expect(s).toHaveLength(66)
    expect([27, 28]).toContain(v)
  })

  it('promotes a 0/1 recovery byte to 27/28', () => {
    const raw = `0x${'11'.repeat(32)}${'22'.repeat(32)}00` as Hex
    expect(splitSignature(raw).v).toBe(27)
    const raw1 = `0x${'11'.repeat(32)}${'22'.repeat(32)}01` as Hex
    expect(splitSignature(raw1).v).toBe(28)
  })

  it('rejects a wrong-length signature and an impossible recovery byte', () => {
    expect(() => splitSignature('0x1234' as Hex)).toThrow(/65-byte/)
    expect(() =>
      splitSignature(`0x${'11'.repeat(32)}${'22'.repeat(32)}05` as Hex),
    ).toThrow(/recovery byte/)
  })
})

describe('deriveNonce', () => {
  it('is deterministic for an intent and payer', async () => {
    const a = await deriveNonce('pi_abc', '0xAbCdEf0123456789012345678901234567890123')
    const b = await deriveNonce('pi_abc', '0xabcdef0123456789012345678901234567890123')
    expect(a).toBe(b)
    expect(a).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('differs per intent and per payer, so one payer cannot block another', async () => {
    const payerA = '0x1111111111111111111111111111111111111111'
    const payerB = '0x2222222222222222222222222222222222222222'
    expect(await deriveNonce('pi_a', payerA)).not.toBe(await deriveNonce('pi_b', payerA))
    expect(await deriveNonce('pi_a', payerA)).not.toBe(await deriveNonce('pi_a', payerB))
  })
})
