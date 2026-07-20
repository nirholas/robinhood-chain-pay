/**
 * Canonical receipt encoding.
 *
 * A hood-pay receipt is not a claim the merchant makes. It is a pointer to
 * on-chain facts plus the intent those facts were supposed to satisfy. Anyone
 * holding a receipt and an RPC URL can re-derive every field and confirm the
 * payment without asking hood-pay, the merchant, or any indexer (see
 * `hood-pay/verify`).
 *
 * The canonical encoding exists so the receipt has one unambiguous byte form
 * to hash and quote. It is a field-ordered, length-prefixed string rather than
 * JSON, because JSON key order, whitespace, and number formatting are not
 * stable across languages and a receipt digest that changes when you
 * re-serialize it is worthless.
 */

import { formatUsdg } from './amount.js'
import { canonicalMetadata } from './intent.js'
import { sha256Hex } from './hash.js'
import type { Address, Hex } from './networks.js'
import type { PaymentIntent, PaymentReceipt, PaymentReceiptWire } from './types.js'

/** The receipt format this build produces and understands. */
export const RECEIPT_VERSION = 1 as const

/** Domain separator so a receipt digest can never collide with another hash. */
const RECEIPT_PREFIX = 'hood-pay/receipt/v1'

function field(value: string | number | bigint): string {
  const s = String(value)
  return `${s.length}:${s}`
}

/**
 * The canonical byte form of a receipt, as a UTF-8 string. Every field is
 * length-prefixed and lowercase-normalized where the value is an address or
 * hash, so two receipts describing the same payment always encode identically.
 */
export function canonicalReceipt(receipt: Omit<PaymentReceipt, 'digest' | 'object'>): string {
  return [
    RECEIPT_PREFIX,
    field(receipt.version),
    field(receipt.intentId),
    field(receipt.merchantId),
    field(receipt.network),
    field(receipt.chainId),
    field(receipt.asset.toLowerCase()),
    field(receipt.from.toLowerCase()),
    field(receipt.to.toLowerCase()),
    field(receipt.amount),
    field(receipt.nonce.toLowerCase()),
    field(receipt.validAfter),
    field(receipt.validBefore),
    field(receipt.txHash.toLowerCase()),
    field(receipt.blockNumber),
    field(receipt.settledAt),
    field(receipt.metadataHash.toLowerCase()),
  ].join('|')
}

/** SHA-256 over {@link canonicalReceipt}. */
export async function receiptDigest(
  receipt: Omit<PaymentReceipt, 'digest' | 'object'>,
): Promise<Hex> {
  return sha256Hex(canonicalReceipt(receipt))
}

/** SHA-256 over the canonical metadata encoding, binding metadata to a receipt. */
export async function metadataHash(metadata: Record<string, string>): Promise<Hex> {
  return sha256Hex(`hood-pay/metadata/v1|${canonicalMetadata(metadata)}`)
}

export interface BuildReceiptParams {
  intent: PaymentIntent
  from: Address
  nonce: Hex
  validAfter: bigint
  validBefore: bigint
  txHash: Hex
  blockNumber: bigint
  /** Unix seconds. */
  settledAt: number
}

/**
 * Build a receipt for a settled intent. The amount, recipient, and asset come
 * from the intent (not from the caller), so a receipt can never describe a
 * payment the intent did not ask for.
 */
export async function buildReceipt(params: BuildReceiptParams): Promise<PaymentReceipt> {
  const { intent } = params
  const base: Omit<PaymentReceipt, 'digest' | 'object'> = {
    version: RECEIPT_VERSION,
    intentId: intent.id,
    merchantId: intent.merchantId,
    network: intent.network,
    chainId: intent.chainId,
    asset: intent.asset,
    from: params.from,
    to: intent.payTo,
    amount: intent.amount,
    nonce: params.nonce,
    validAfter: params.validAfter,
    validBefore: params.validBefore,
    txHash: params.txHash,
    blockNumber: params.blockNumber,
    settledAt: params.settledAt,
    metadataHash: await metadataHash(intent.metadata),
  }
  return { object: 'payment_receipt', ...base, digest: await receiptDigest(base) }
}

/** Serialize a receipt for the wire. */
export function serializeReceipt(receipt: PaymentReceipt): PaymentReceiptWire {
  return {
    ...receipt,
    object: 'payment_receipt',
    amount: receipt.amount.toString(),
    amountFormatted: formatUsdg(receipt.amount),
    validAfter: receipt.validAfter.toString(),
    validBefore: receipt.validBefore.toString(),
    blockNumber: receipt.blockNumber.toString(),
  }
}

/** Parse a wire receipt back into bigint fields. */
export function deserializeReceipt(wire: PaymentReceiptWire): PaymentReceipt {
  const { amountFormatted: _amountFormatted, ...rest } = wire
  return {
    ...rest,
    object: 'payment_receipt',
    amount: BigInt(wire.amount),
    validAfter: BigInt(wire.validAfter),
    validBefore: BigInt(wire.validBefore),
    blockNumber: BigInt(wire.blockNumber),
  }
}

/**
 * Recompute a receipt's digest and compare it to the one it carries. This
 * catches tampering with any covered field, but note that it proves only
 * internal consistency: a forged receipt can carry a correct digest over
 * forged fields. The on-chain check in `hood-pay/verify` is what proves the
 * payment actually happened.
 */
export async function isDigestValid(receipt: PaymentReceipt): Promise<boolean> {
  const { digest: _digest, object: _object, ...base } = receipt
  return (await receiptDigest(base)) === receipt.digest
}
