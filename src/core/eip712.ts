/**
 * EIP-712 typed-data construction for USDG's EIP-3009
 * `TransferWithAuthorization`.
 *
 * This is the heart of the product. USDG exposes EIP-3009 but **not**
 * EIP-2612, which means:
 *
 *  - There is no `permit` + `transferFrom` dance and no allowance to manage.
 *  - The customer signs a message, not a transaction. They need **zero gas**
 *    and hold **zero native ETH**.
 *  - The merchant (or any relayer) submits `transferWithAuthorization` and pays
 *    the gas, and cannot alter the amount, the recipient, or the deadline,
 *    because all three are bound inside the signature.
 *
 * That combination is what makes a Stripe-grade checkout possible here: the
 * customer experience is "approve a popup", not "fund a wallet with gas, wait
 * for a transaction, hope it does not get stuck".
 *
 * Deliberately free of `viem`: the browser bundle constructs this payload and
 * hands it straight to `eth_signTypedData_v4` on an EIP-1193 provider.
 */

import type { Address, Hex, HoodPayNetwork } from './networks.js'
import { sha256Hex } from './hash.js'
import type { Authorization, AuthorizationWire } from './types.js'

/** The EIP-712 struct the payer signs. Field order is part of the type hash. */
export const TRANSFER_WITH_AUTHORIZATION_TYPE = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
] as const

/** The EIP-712 domain struct, as required by `eth_signTypedData_v4`. */
export const EIP712_DOMAIN_TYPE = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const

export interface Eip712Domain {
  name: string
  version: string
  chainId: number
  verifyingContract: Address
}

/** A complete `eth_signTypedData_v4` payload. Every value is JSON-safe. */
export interface TypedDataPayload {
  types: {
    EIP712Domain: typeof EIP712_DOMAIN_TYPE
    TransferWithAuthorization: typeof TRANSFER_WITH_AUTHORIZATION_TYPE
  }
  primaryType: 'TransferWithAuthorization'
  domain: Eip712Domain
  message: AuthorizationWire
}

/**
 * USDG's EIP-712 domain for a network. Reconstructed offline and confirmed
 * equal to the live `DOMAIN_SEPARATOR()` on both chains.
 */
export function usdgDomain(net: HoodPayNetwork): Eip712Domain {
  return {
    name: net.usdgDomain.name,
    version: net.usdgDomain.version,
    chainId: net.chainId,
    verifyingContract: net.usdg,
  }
}

/** Convert an {@link Authorization} to its JSON-safe wire form. */
export function toWire(auth: Authorization): AuthorizationWire {
  return {
    from: auth.from,
    to: auth.to,
    value: auth.value.toString(),
    validAfter: auth.validAfter.toString(),
    validBefore: auth.validBefore.toString(),
    nonce: auth.nonce,
  }
}

/** Convert a wire authorization back to bigint fields. Throws on malformed numerics. */
export function fromWire(wire: AuthorizationWire): Authorization {
  return {
    from: wire.from,
    to: wire.to,
    value: BigInt(wire.value),
    validAfter: BigInt(wire.validAfter),
    validBefore: BigInt(wire.validBefore),
    nonce: wire.nonce,
  }
}

/** Build the exact payload to pass to `eth_signTypedData_v4`. */
export function buildTypedData(
  net: HoodPayNetwork,
  auth: Authorization | AuthorizationWire,
): TypedDataPayload {
  const message = 'value' in auth && typeof auth.value === 'bigint' ? toWire(auth as Authorization) : (auth as AuthorizationWire)
  return {
    types: {
      EIP712Domain: EIP712_DOMAIN_TYPE,
      TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPE,
    },
    primaryType: 'TransferWithAuthorization',
    domain: usdgDomain(net),
    message,
  }
}

/**
 * Derive the EIP-3009 nonce for an (intent, payer) pair.
 *
 * hood-pay does not use a random nonce. It derives one deterministically, so
 * that USDG's own `authorizationState` mapping becomes the double-charge
 * guard: `authorizationState(payer, nonce)` flips to `true` the moment the
 * transfer lands, and every subsequent submission for the same intent and the
 * same payer reverts on-chain. Idempotency is then enforced by the token
 * contract itself, not only by the merchant's database.
 *
 * A reverted transfer does not consume the nonce, so a payment that fails for
 * insufficient funds can be retried with the same derived nonce once the payer
 * tops up.
 */
export async function deriveNonce(intentId: string, payer: Address): Promise<Hex> {
  return sha256Hex(`hood-pay/eip3009-nonce/v1|${intentId}|${payer.toLowerCase()}`)
}

/** Normalize an address to lowercase for comparison. Never used for display. */
export function sameAddress(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return a.toLowerCase() === b.toLowerCase()
}

/** Split a 65-byte signature into the `(v, r, s)` form USDG's facet expects. */
export function splitSignature(signature: Hex): { r: Hex; s: Hex; v: number } {
  const body = signature.startsWith('0x') ? signature.slice(2) : signature
  if (body.length !== 130) {
    throw new Error(
      `hood-pay: expected a 65-byte (130 hex character) signature, got ${body.length} characters`,
    )
  }
  const r = `0x${body.slice(0, 64)}` as Hex
  const s = `0x${body.slice(64, 128)}` as Hex
  const raw = Number.parseInt(body.slice(128, 130), 16)
  // Wallets return either the yParity (0/1) or the legacy v (27/28).
  const v = raw < 27 ? raw + 27 : raw
  if (v !== 27 && v !== 28) {
    throw new Error(`hood-pay: signature has an invalid recovery byte (v=${raw})`)
  }
  return { r, s, v }
}
