/**
 * Verify a hood-pay payment from the command line, against a live RPC.
 *
 *   npm run verify:receipt -- --receipt ./receipt.json
 *   npm run verify:receipt -- --tx 0xabc... --to 0xMerchant --amount 12.50
 *
 * The second form needs no receipt at all: a transaction hash, the address
 * that should have been paid, and the amount owed are enough to confirm a
 * payment independently. That is the whole point of settling on-chain.
 */

import { readFile } from 'node:fs/promises'

import { parseUsdg } from '../src/core/amount.js'
import { deserializeReceipt } from '../src/core/receipt.js'
import type { Address, Hex } from '../src/core/networks.js'
import type { PaymentReceiptWire } from '../src/core/types.js'
import { formatVerification, verifyPaymentByHash, verifyReceipt } from '../src/verify/index.js'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function usage(message: string): never {
  console.error(`hood-pay verify: ${message}

Usage:
  verify-receipt --receipt <path-to-receipt.json> [--rpc <url>]
  verify-receipt --tx <hash> --to <address> --amount <usdg> [--network <id>] [--rpc <url>]
`)
  process.exit(2)
}

async function main(): Promise<void> {
  const rpcUrl = arg('rpc')
  const receiptPath = arg('receipt')

  if (receiptPath) {
    const raw = await readFile(receiptPath, 'utf8')
    const receipt = deserializeReceipt(JSON.parse(raw) as PaymentReceiptWire)
    const result = await verifyReceipt({
      receipt,
      ...(rpcUrl ? { rpcUrl } : {}),
    })
    console.log(formatVerification(result))
    process.exit(result.valid ? 0 : 1)
  }

  const txHash = arg('tx')
  const payTo = arg('to')
  const amount = arg('amount')
  if (!txHash || !payTo || !amount) {
    usage('provide either --receipt, or all of --tx, --to, and --amount')
  }

  const result = await verifyPaymentByHash({
    txHash: txHash as Hex,
    network: arg('network') ?? 'robinhood',
    payTo: payTo as Address,
    amount: parseUsdg(amount),
    ...(rpcUrl ? { rpcUrl } : {}),
  })
  console.log(formatVerification(result))
  process.exit(result.valid ? 0 : 1)
}

main().catch((err: unknown) => {
  console.error(`hood-pay verify failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
