/**
 * The relay: turn a customer's signed EIP-3009 authorization into a settled
 * USDG transfer, paying the gas on their behalf.
 *
 * This is where hood-pay's one genuinely load-bearing borrowing from the
 * sibling `hood402` package happens. `eip3009Abi` (the exact `(v, r, s)` ABI
 * fragment for USDG's facet) and `verifyAuthorizationSignature` (EIP-712
 * recovery against the "Global Dollar" domain, with ERC-1271 support for smart
 * accounts) are protocol-level and product-neutral, so they are imported
 * rather than re-derived.
 *
 * The surrounding logic is hood-pay's own. `hood402`'s `settlePayment` takes an
 * x402 `PaymentPayload` plus `PaymentRequirements` and answers in x402's
 * `invalidReason` vocabulary, all of which describes a machine paying for an
 * HTTP resource. A human checkout has different invariants: the amount must
 * match the intent **exactly** rather than merely cover a price, the nonce is
 * derived from the intent rather than random, failures map to states a
 * customer sees in a widget, and settlement has to be idempotent against a
 * merchant's intent row. Bending the intent model into an x402 envelope to
 * reuse one function would have made both sides worse.
 */

import { getAddress } from 'viem'
import { eip3009Abi, erc20Abi, requireNetwork as requireHood402Network, verifyAuthorizationSignature } from 'hood402'

import type { HoodPayErrorCode } from '../core/errors.js'
import { deriveNonce, fromWire, sameAddress, splitSignature } from '../core/eip712.js'
import type { Address, Hex, HoodPayNetwork } from '../core/networks.js'
import type { PaymentIntent, SignedAuthorization } from '../core/types.js'

/** The slice of a viem `PublicClient` the relay reads through. */
export interface ChainReader {
  readContract(args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args?: readonly unknown[]
  }): Promise<unknown>
  waitForTransactionReceipt(args: { hash: Hex }): Promise<{
    status: 'success' | 'reverted'
    transactionHash: Hex
    blockNumber: bigint
  }>
}

/** The slice of a viem `WalletClient` the relay broadcasts through. */
export interface ChainWriter {
  writeContract(args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
    chain?: unknown
    account: Address
  }): Promise<Hex>
}

/** A preflight rejection, with the code the widget renders a state for. */
export interface PreflightRejection {
  ok: false
  code: HoodPayErrorCode
  message: string
}

export interface PreflightAcceptance {
  ok: true
  payer: Address
}

export type PreflightResult = PreflightAcceptance | PreflightRejection

function reject(code: HoodPayErrorCode, message: string): PreflightRejection {
  return { ok: false, code, message }
}

export interface PreflightOptions {
  intent: PaymentIntent
  signed: SignedAuthorization
  network: HoodPayNetwork
  /** Omit to run the offline checks only (structure, signature, amounts). */
  reader?: ChainReader
  /** Unix seconds. Injectable for deterministic tests. */
  now?: number
}

/**
 * Validate an authorization against its intent, offline first and then against
 * chain state. Runs in cost order so the cheap rejections happen before any
 * RPC round trip:
 *
 *  1. recipient, asset, and **exact** amount match the intent
 *  2. the nonce is the one derived from (intent, payer)
 *  3. the validity window covers now, and does not outlive the intent
 *  4. the EIP-712 signature recovers to the payer
 *  5. the nonce is unused on-chain (`authorizationState`)
 *  6. the payer holds enough USDG
 */
export async function preflight(options: PreflightOptions): Promise<PreflightResult> {
  const { intent, signed, network } = options
  const now = options.now ?? Math.floor(Date.now() / 1000)

  let auth
  try {
    auth = fromWire(signed.authorization)
  } catch {
    return reject('config_invalid', 'hood-pay: the authorization contains a malformed numeric field')
  }

  let payer: Address
  try {
    payer = getAddress(auth.from) as Address
    getAddress(auth.to)
  } catch {
    return reject('config_invalid', 'hood-pay: the authorization contains a malformed address')
  }

  if (!sameAddress(auth.to, intent.payTo)) {
    return reject(
      'recipient_mismatch',
      `hood-pay: the authorization pays ${auth.to} but this intent is payable to ${intent.payTo}`,
    )
  }

  // Human checkout is exact. An overpayment is a customer losing money to a
  // mistake, not a tip, so it is refused rather than pocketed.
  if (auth.value !== intent.amount) {
    return reject(
      'amount_mismatch',
      `hood-pay: the authorization is for ${auth.value} atomic USDG but this intent is for exactly ${intent.amount}`,
    )
  }

  const expectedNonce = await deriveNonce(intent.id, payer)
  if (auth.nonce.toLowerCase() !== expectedNonce.toLowerCase()) {
    return reject(
      'config_invalid',
      'hood-pay: the authorization nonce is not the one derived from this intent and payer',
    )
  }

  const nowBig = BigInt(now)
  if (auth.validAfter > nowBig) {
    return reject('authorization_not_yet_valid', 'hood-pay: the authorization is not valid yet')
  }
  if (auth.validBefore <= nowBig) {
    return reject('authorization_expired', 'hood-pay: the authorization has expired')
  }

  const hoodNet = requireHood402Network(network.chainId)
  const signatureOk = await verifyAuthorizationSignature(
    hoodNet,
    {
      from: auth.from,
      to: auth.to,
      value: auth.value.toString(),
      validAfter: auth.validAfter.toString(),
      validBefore: auth.validBefore.toString(),
      nonce: auth.nonce,
    },
    signed.signature,
  )
  if (!signatureOk) {
    return reject(
      'invalid_signature',
      'hood-pay: the EIP-712 signature does not recover to the stated payer',
    )
  }

  if (!options.reader) return { ok: true, payer }

  const used = (await options.reader.readContract({
    address: network.usdg,
    abi: eip3009Abi,
    functionName: 'authorizationState',
    args: [payer, auth.nonce],
  })) as boolean
  if (used) {
    return reject(
      'authorization_already_used',
      'hood-pay: this authorization has already been settled on-chain',
    )
  }

  const balance = (await options.reader.readContract({
    address: network.usdg,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [payer],
  })) as bigint
  if (balance < auth.value) {
    return reject(
      'insufficient_funds',
      `hood-pay: the payer holds ${balance} atomic USDG but this payment needs ${auth.value}`,
    )
  }

  return { ok: true, payer }
}

export interface RelayOptions extends PreflightOptions {
  reader: ChainReader
  writer: ChainWriter
  /** The gas-paying account bound to `writer`. */
  relayerAddress: Address
  /** viem chain object passed through to `writeContract`. */
  chain?: unknown
  /** Skip preflight when the caller has already run it. Defaults to `false`. */
  skipPreflight?: boolean
}

export type RelayOutcome =
  | { ok: true; txHash: Hex; blockNumber: bigint; payer: Address }
  | { ok: false; code: HoodPayErrorCode; message: string; txHash?: Hex }

/**
 * Broadcast `transferWithAuthorization` and wait for the receipt.
 *
 * The relayer pays gas and can choose only whether to submit. It cannot change
 * the amount, the recipient, or the deadline: all three are inside the signed
 * message, and USDG's facet checks the signature against them.
 */
export async function relayAuthorization(options: RelayOptions): Promise<RelayOutcome> {
  const { intent, signed, network, reader, writer } = options

  if (!options.skipPreflight) {
    const pre = await preflight(options)
    if (!pre.ok) return { ok: false, code: pre.code, message: pre.message }
  }

  const auth = fromWire(signed.authorization)
  const payer = getAddress(auth.from) as Address

  let r: Hex
  let s: Hex
  let v: number
  try {
    ;({ r, s, v } = splitSignature(signed.signature))
  } catch (err) {
    return {
      ok: false,
      code: 'invalid_signature',
      message: err instanceof Error ? err.message : 'hood-pay: malformed signature',
    }
  }

  let hash: Hex
  try {
    hash = await writer.writeContract({
      address: network.usdg,
      abi: eip3009Abi,
      functionName: 'transferWithAuthorization',
      args: [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, v, r, s],
      ...(options.chain !== undefined ? { chain: options.chain } : {}),
      account: options.relayerAddress,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      code: 'relay_failed',
      message: `hood-pay: could not broadcast the settlement transaction. ${message}`,
    }
  }

  let receipt: { status: 'success' | 'reverted'; transactionHash: Hex; blockNumber: bigint }
  try {
    receipt = await reader.waitForTransactionReceipt({ hash })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      code: 'relay_failed',
      message: `hood-pay: broadcast succeeded but the receipt could not be fetched. ${message}`,
      txHash: hash,
    }
  }

  if (receipt.status !== 'success') {
    return {
      ok: false,
      code: 'settlement_reverted',
      message: 'hood-pay: the settlement transaction reverted on-chain',
      txHash: receipt.transactionHash,
    }
  }

  return {
    ok: true,
    txHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    payer,
  }
}
