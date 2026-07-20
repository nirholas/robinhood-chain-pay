/**
 * `hood-pay/verify`: independent, standalone receipt verification.
 *
 * This is the point of issuing a receipt at all. A merchant, an auditor, a
 * customer disputing a charge, or a third party settling an invoice can
 * confirm a hood-pay payment with nothing but an RPC URL. It does not call the
 * merchant's API, it does not trust the receipt's own claims, and it does not
 * need an indexer, a subgraph, or an API key.
 *
 * Six independent checks run against chain state:
 *
 *  1. the transaction exists and did not revert
 *  2. it was sent to the USDG contract for the stated network
 *  3. a USDG `Transfer` log moves **exactly** the stated amount from the payer
 *     to the merchant in that transaction
 *  4. an `AuthorizationUsed` log names the same payer and nonce
 *  5. `authorizationState(payer, nonce)` is now `true`, so the authorization is
 *     spent and cannot be replayed
 *  6. the receipt's own digest recomputes (tamper-evidence on the fields that
 *     are not independently observable, such as the intent id and metadata)
 *
 * Checks 3 and 5 are the load-bearing ones. Together they say: this exact
 * amount moved to this exact address, and the signature that authorized it is
 * now permanently consumed.
 */

import { createPublicClient, decodeEventLog, http, parseAbi, type Address, type Hex } from 'viem'
import { eip3009Abi } from 'hood402'

import { formatUsdg } from '../core/amount.js'
import { isDigestValid } from '../core/receipt.js'
import { requireNetwork, txUrl, type HoodPayNetwork } from '../core/networks.js'
import type { PaymentIntent, PaymentReceipt } from '../core/types.js'

/** The two events EIP-3009 settlement emits on USDG. */
export const usdgEventsAbi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
])

/** One named assertion about the payment. */
export interface VerificationCheck {
  id:
    | 'transaction_succeeded'
    | 'target_is_usdg'
    | 'transfer_matches'
    | 'authorization_used_event'
    | 'authorization_consumed'
    | 'receipt_digest'
    | 'matches_intent'
  /** `true` when the assertion holds. */
  ok: boolean
  /** Human explanation, always populated, including on success. */
  detail: string
}

export interface VerificationResult {
  /** `true` only when every check passed. */
  valid: boolean
  checks: VerificationCheck[]
  /** The payer the chain reports, when it could be read. */
  payer?: Address
  /** Amount observed on-chain, in atomic units. */
  observedAmount?: bigint
  /** Same amount, formatted. */
  observedAmountFormatted?: string
  txUrl: string
  network: string
  chainId: number
}

/** The minimal chain surface verification needs. */
export interface VerifierClient {
  getTransactionReceipt(args: { hash: Hex }): Promise<{
    status: 'success' | 'reverted'
    to: Address | null
    blockNumber: bigint
    logs: Array<{ address: Address; topics: string[]; data: Hex }>
  }>
  readContract(args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args?: readonly unknown[]
  }): Promise<unknown>
}

export interface VerifyReceiptOptions {
  receipt: PaymentReceipt
  /**
   * RPC endpoint. Defaults to the public endpoint for the receipt's network.
   * Supply your own for rate limits or for a private node.
   */
  rpcUrl?: string
  /** A pre-built client, if you already have one. */
  client?: VerifierClient
  /**
   * The intent the payment was supposed to satisfy. When supplied, the amount,
   * recipient, network, and id are cross-checked against it. Without it,
   * verification confirms the on-chain facts but cannot know what was owed.
   */
  intent?: PaymentIntent
}

function check(
  id: VerificationCheck['id'],
  ok: boolean,
  detail: string,
): VerificationCheck {
  return { id, ok, detail }
}

/** Build a read-only viem client for a network. */
export function createVerifierClient(net: HoodPayNetwork, rpcUrl?: string): VerifierClient {
  return createPublicClient({
    transport: http(rpcUrl ?? net.rpcUrl),
  }) as unknown as VerifierClient
}

function same(a: string | undefined | null, b: string | undefined | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

/**
 * Verify a receipt against chain state.
 *
 * ```ts
 * import { verifyReceipt } from '@three-ws/hood-pay/verify'
 *
 * const result = await verifyReceipt({ receipt })
 * if (!result.valid) {
 *   for (const failed of result.checks.filter((c) => !c.ok)) console.error(failed.detail)
 * }
 * ```
 */
export async function verifyReceipt(options: VerifyReceiptOptions): Promise<VerificationResult> {
  const { receipt } = options
  const net = requireNetwork(receipt.chainId)
  const client = options.client ?? createVerifierClient(net, options.rpcUrl)

  const checks: VerificationCheck[] = []
  const result: VerificationResult = {
    valid: false,
    checks,
    txUrl: txUrl(net, receipt.txHash),
    network: net.id,
    chainId: net.chainId,
  }

  const digestOk = await isDigestValid(receipt)
  checks.push(
    check(
      'receipt_digest',
      digestOk,
      digestOk
        ? 'The receipt digest matches its contents.'
        : 'The receipt digest does not match its contents, so at least one field was altered after issuance.',
    ),
  )

  let txReceipt: Awaited<ReturnType<VerifierClient['getTransactionReceipt']>>
  try {
    txReceipt = await client.getTransactionReceipt({ hash: receipt.txHash })
  } catch (err) {
    checks.push(
      check(
        'transaction_succeeded',
        false,
        `Transaction ${receipt.txHash} could not be read from the chain. ${err instanceof Error ? err.message : String(err)}`,
      ),
    )
    return result
  }

  checks.push(
    check(
      'transaction_succeeded',
      txReceipt.status === 'success',
      txReceipt.status === 'success'
        ? `Transaction ${receipt.txHash} succeeded in block ${txReceipt.blockNumber}.`
        : `Transaction ${receipt.txHash} reverted, so no payment was made.`,
    ),
  )

  checks.push(
    check(
      'target_is_usdg',
      same(txReceipt.to, net.usdg),
      same(txReceipt.to, net.usdg)
        ? `The transaction targets USDG at ${net.usdg}.`
        : `The transaction targets ${txReceipt.to ?? 'a contract creation'}, not USDG at ${net.usdg}.`,
    ),
  )

  // Decode the USDG logs this transaction emitted.
  let transferOk = false
  let observedAmount: bigint | undefined
  let authorizationEventOk = false

  for (const log of txReceipt.logs) {
    if (!same(log.address, net.usdg)) continue
    let decoded
    try {
      decoded = decodeEventLog({
        abi: usdgEventsAbi,
        data: log.data,
        topics: log.topics as [signature: Hex, ...args: Hex[]],
      })
    } catch {
      // Not one of the two events we care about.
      continue
    }
    if (decoded.eventName === 'Transfer') {
      const args = decoded.args as unknown as { from: Address; to: Address; value: bigint }
      if (same(args.from, receipt.from) && same(args.to, receipt.to)) {
        observedAmount = args.value
        if (args.value === receipt.amount) transferOk = true
      }
    } else if (decoded.eventName === 'AuthorizationUsed') {
      const args = decoded.args as unknown as { authorizer: Address; nonce: Hex }
      if (same(args.authorizer, receipt.from) && same(args.nonce, receipt.nonce)) {
        authorizationEventOk = true
      }
    }
  }

  checks.push(
    check(
      'transfer_matches',
      transferOk,
      transferOk
        ? `USDG Transfer of exactly ${formatUsdg(receipt.amount)} from ${receipt.from} to ${receipt.to} is present in the transaction.`
        : observedAmount !== undefined
          ? `A USDG Transfer between those addresses moved ${formatUsdg(observedAmount)}, not the ${formatUsdg(receipt.amount)} the receipt claims.`
          : `No USDG Transfer from ${receipt.from} to ${receipt.to} was found in this transaction.`,
    ),
  )

  checks.push(
    check(
      'authorization_used_event',
      authorizationEventOk,
      authorizationEventOk
        ? `AuthorizationUsed names payer ${receipt.from} and nonce ${receipt.nonce}.`
        : 'No AuthorizationUsed event for this payer and nonce was found in the transaction.',
    ),
  )

  try {
    const consumed = (await client.readContract({
      address: net.usdg,
      abi: eip3009Abi,
      functionName: 'authorizationState',
      args: [receipt.from, receipt.nonce],
    })) as boolean
    checks.push(
      check(
        'authorization_consumed',
        consumed,
        consumed
          ? 'The authorization nonce is marked used on-chain, so it can never be replayed.'
          : 'The authorization nonce is still unused on-chain, which contradicts a settled payment.',
      ),
    )
  } catch (err) {
    checks.push(
      check(
        'authorization_consumed',
        false,
        `authorizationState could not be read. ${err instanceof Error ? err.message : String(err)}`,
      ),
    )
  }

  if (options.intent) {
    const intent = options.intent
    const matches =
      intent.id === receipt.intentId &&
      intent.amount === receipt.amount &&
      same(intent.payTo, receipt.to) &&
      intent.chainId === receipt.chainId
    checks.push(
      check(
        'matches_intent',
        matches,
        matches
          ? `The receipt satisfies intent ${intent.id}: ${formatUsdg(intent.amount)} USDG to ${intent.payTo}.`
          : `The receipt does not match intent ${intent.id}. Expected ${formatUsdg(intent.amount)} USDG to ${intent.payTo} on chain ${intent.chainId}.`,
      ),
    )
  }

  result.valid = checks.every((c) => c.ok)
  if (observedAmount !== undefined) {
    result.observedAmount = observedAmount
    result.observedAmountFormatted = formatUsdg(observedAmount)
  }
  result.payer = receipt.from
  return result
}

export interface VerifyPaymentByHashOptions {
  /** Settlement transaction hash. */
  txHash: Hex
  /** Network id, alias, or chain id. */
  network: string | number
  /** The address that should have been paid. */
  payTo: Address
  /** The exact amount owed, in atomic USDG units. */
  amount: bigint
  rpcUrl?: string
  client?: VerifierClient
}

/**
 * Verify a payment when all you have is a transaction hash and what you were
 * owed, with no receipt at all. This is the fallback path for a merchant
 * reconciling a payment out of band, or for anyone handed a hash by a
 * customer.
 */
export async function verifyPaymentByHash(
  options: VerifyPaymentByHashOptions,
): Promise<VerificationResult> {
  const net = requireNetwork(options.network)
  const client = options.client ?? createVerifierClient(net, options.rpcUrl)
  const checks: VerificationCheck[] = []
  const result: VerificationResult = {
    valid: false,
    checks,
    txUrl: txUrl(net, options.txHash),
    network: net.id,
    chainId: net.chainId,
  }

  let txReceipt: Awaited<ReturnType<VerifierClient['getTransactionReceipt']>>
  try {
    txReceipt = await client.getTransactionReceipt({ hash: options.txHash })
  } catch (err) {
    checks.push(
      check(
        'transaction_succeeded',
        false,
        `Transaction ${options.txHash} could not be read. ${err instanceof Error ? err.message : String(err)}`,
      ),
    )
    return result
  }

  checks.push(
    check(
      'transaction_succeeded',
      txReceipt.status === 'success',
      txReceipt.status === 'success'
        ? `Transaction succeeded in block ${txReceipt.blockNumber}.`
        : 'Transaction reverted.',
    ),
  )
  checks.push(
    check(
      'target_is_usdg',
      same(txReceipt.to, net.usdg),
      same(txReceipt.to, net.usdg)
        ? `The transaction targets USDG at ${net.usdg}.`
        : `The transaction targets ${txReceipt.to ?? 'a contract creation'}, not USDG.`,
    ),
  )

  let payer: Address | undefined
  let observedAmount: bigint | undefined
  let nonce: Hex | undefined

  for (const log of txReceipt.logs) {
    if (!same(log.address, net.usdg)) continue
    let decoded
    try {
      decoded = decodeEventLog({
        abi: usdgEventsAbi,
        data: log.data,
        topics: log.topics as [signature: Hex, ...args: Hex[]],
      })
    } catch {
      continue
    }
    if (decoded.eventName === 'Transfer') {
      const args = decoded.args as unknown as { from: Address; to: Address; value: bigint }
      if (same(args.to, options.payTo) && args.value === options.amount) {
        payer = args.from
        observedAmount = args.value
      } else if (same(args.to, options.payTo)) {
        observedAmount = args.value
      }
    } else if (decoded.eventName === 'AuthorizationUsed') {
      nonce = (decoded.args as unknown as { nonce: Hex }).nonce
    }
  }

  const transferOk = payer !== undefined && observedAmount === options.amount
  checks.push(
    check(
      'transfer_matches',
      transferOk,
      transferOk
        ? `USDG Transfer of exactly ${formatUsdg(options.amount)} to ${options.payTo} is present, from ${payer}.`
        : observedAmount !== undefined
          ? `A USDG Transfer to ${options.payTo} moved ${formatUsdg(observedAmount)}, not the ${formatUsdg(options.amount)} expected.`
          : `No USDG Transfer to ${options.payTo} was found in this transaction.`,
    ),
  )

  checks.push(
    check(
      'authorization_used_event',
      nonce !== undefined,
      nonce !== undefined
        ? `AuthorizationUsed emitted with nonce ${nonce}.`
        : 'No AuthorizationUsed event was emitted, so this was not an EIP-3009 settlement.',
    ),
  )

  if (payer && nonce) {
    let consumed = false
    try {
      consumed = (await client.readContract({
        address: net.usdg,
        abi: eip3009Abi,
        functionName: 'authorizationState',
        args: [payer, nonce],
      })) as boolean
    } catch {
      consumed = false
    }
    checks.push(
      check(
        'authorization_consumed',
        consumed,
        consumed
          ? 'The authorization nonce is marked used on-chain.'
          : 'The authorization nonce is not marked used on-chain.',
      ),
    )
  } else {
    checks.push(
      check(
        'authorization_consumed',
        false,
        'The payer or nonce could not be determined, so the authorization state could not be checked.',
      ),
    )
  }

  result.valid = checks.every((c) => c.ok)
  if (payer) result.payer = payer
  if (observedAmount !== undefined) {
    result.observedAmount = observedAmount
    result.observedAmountFormatted = formatUsdg(observedAmount)
  }
  return result
}

/** Render a verification result as human-readable lines, for CLIs and logs. */
export function formatVerification(result: VerificationResult): string {
  const lines = [
    `${result.valid ? 'PASS' : 'FAIL'}  ${result.network} (chain ${result.chainId})`,
    ...result.checks.map((c) => `  [${c.ok ? 'ok' : '!!'}] ${c.id}: ${c.detail}`),
    `  ${result.txUrl}`,
  ]
  return lines.join('\n')
}
