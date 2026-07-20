/**
 * A runnable hood-pay merchant server.
 *
 *   npm run example:server
 *
 * It boots with no configuration at all (SQLite in a local file, testnet, an
 * ephemeral API key printed at startup) and creates a payment link you can
 * open immediately. Set `HOOD_PAY_RELAYER_KEY` to a funded key to actually
 * settle payments; without it the server still serves checkout, the widget,
 * and the API, and refuses settlement with a clear message rather than
 * pretending to succeed.
 *
 * Environment (all optional, see `.env.example`):
 *   PORT, HOOD_PAY_NETWORK, HOOD_PAY_PAY_TO, HOOD_PAY_RELAYER_KEY,
 *   HOOD_PAY_API_KEY, HOOD_PAY_WEBHOOK_URL, HOOD_PAY_WEBHOOK_SECRET,
 *   HOOD_PAY_RPC_URL, HOOD_PAY_BASE_URL
 */

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import express from 'express'
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { robinhood, robinhoodTestnet } from 'viem/chains'

import { requireNetwork } from '../src/core/networks.js'
import { displayUsdg } from '../src/core/amount.js'
import { HoodPayMerchant, type RelayerConfig } from '../src/server/merchant.js'
import { SqliteStore } from '../src/server/sqlite-store.js'
import { expressHoodPay } from '../src/server/adapters.js'
import {
  SIGNATURE_HEADER,
  constructWebhookEvent,
} from '../src/server/webhooks.js'

const PORT = Number(process.env['PORT'] ?? 4030)
const net = requireNetwork(process.env['HOOD_PAY_NETWORK'] ?? 'robinhood-testnet')
const baseUrl = process.env['HOOD_PAY_BASE_URL'] ?? `http://localhost:${PORT}`
const apiKey = process.env['HOOD_PAY_API_KEY'] ?? `sk_dev_${randomBytes(12).toString('hex')}`
const webhookSecret = process.env['HOOD_PAY_WEBHOOK_SECRET'] ?? `whsec_dev_${randomBytes(12).toString('hex')}`
const payTo =
  (process.env['HOOD_PAY_PAY_TO'] as `0x${string}` | undefined) ??
  '0x000000000000000000000000000000000000dEaD'

const rpcUrl = process.env['HOOD_PAY_RPC_URL'] ?? net.rpcUrl
const chain = net.testnet ? robinhoodTestnet : robinhood

/**
 * Build the relayer only when a key is present. hood-pay never fabricates a
 * settlement path: without a key the merchant is honest about being unable to
 * settle.
 */
function buildRelayer(): RelayerConfig | undefined {
  const key = process.env['HOOD_PAY_RELAYER_KEY']
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return undefined
  const account = privateKeyToAccount(key as `0x${string}`)
  const transport = http(rpcUrl)
  return {
    reader: createPublicClient({ chain, transport }) as unknown as RelayerConfig['reader'],
    writer: createWalletClient({ account, chain, transport }) as unknown as RelayerConfig['writer'],
    address: account.address,
    chain,
    // A hard ceiling on any single relayed payment. Keep one in production.
    maxAmountPerPayment: 1_000_000_000n, // 1,000 USDG
  }
}

const relayer = buildRelayer()

const merchant = new HoodPayMerchant({
  payTo,
  network: net.id,
  merchantId: 'example-shop',
  baseUrl,
  store: new SqliteStore('./examples/data/hood-pay-example.sqlite'),
  ...(relayer ? { relayer } : {}),
  webhook: { url: `${baseUrl}/demo-webhook`, secret: webhookSecret },
})

const app = express()

/**
 * A webhook receiver, so the example demonstrates both halves.
 *
 * This route is mounted BEFORE `express.json()`, and that ordering is
 * load-bearing. A webhook signature covers the exact bytes that arrived; once
 * `express.json()` has consumed the stream, the original bytes are gone and
 * `JSON.stringify(req.body)` will not reproduce them (key order and number
 * formatting are not guaranteed to round-trip). Verify against the raw buffer
 * or the signature will fail for valid deliveries.
 */
app.post('/demo-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const rawBody = (req.body as Buffer).toString('utf8')
  const signature = req.header(SIGNATURE_HEADER) ?? ''
  try {
    const event = await constructWebhookEvent({ secret: webhookSecret, rawBody, signature })
    console.log(`  webhook  ${event.type}  ${event.data.intent.id}  ${event.data.intent.status}`)
    res.status(200).json({ received: true })
  } catch (err) {
    console.error(`  webhook  REJECTED: ${err instanceof Error ? err.message : String(err)}`)
    res.status(400).json({ error: 'invalid signature' })
  }
})

app.use(express.json())

// Serve the static widget example and the browser bundle next to it.
app.use('/static', express.static('examples'))
app.use('/dist', express.static('dist'))

// The whole hood-pay surface: /pay/:id, /api/intents..., /healthz.
app.use(expressHoodPay({ merchant, apiKey, merchantName: 'Example Shop' }))

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<meta charset="utf-8">
<title>hood-pay example merchant</title>
<style>body{font:15px/1.6 system-ui;margin:40px auto;max-width:640px;padding:0 20px}code{background:#f4f4f6;padding:2px 6px;border-radius:4px}</style>
<h1>hood-pay example merchant</h1>
<p>Network: <code>${net.label}</code> (chain ${net.chainId})</p>
<p>Settlement: <code>${relayer ? `enabled, relayer ${relayer.address}` : 'disabled (set HOOD_PAY_RELAYER_KEY)'}</code></p>
<ul>
  <li><a href="/static/checkout.html">Widget example</a></li>
  <li><a href="/healthz">/healthz</a></li>
</ul>`)
})

const server = createServer(app)

server.listen(PORT, async () => {
  const link = await merchant.createPaymentLink({
    amount: '12.50',
    description: 'One large widget',
    metadata: { orderId: `demo-${Date.now()}` },
  })

  console.log('')
  console.log(`hood-pay example merchant on ${baseUrl}`)
  console.log(`  network      ${net.label} (chain ${net.chainId})`)
  console.log(`  pay to       ${payTo}`)
  console.log(`  settlement   ${relayer ? `enabled, relayer ${relayer.address}` : 'DISABLED, set HOOD_PAY_RELAYER_KEY to settle'}`)
  console.log(`  api key      ${apiKey}`)
  console.log('')
  console.log(`  payment link ${link.url}`)
  console.log(`  amount       ${displayUsdg(link.intent.amount)} USDG`)
  console.log(`  widget demo  ${baseUrl}/static/checkout.html?intent=${link.intent.id}`)
  console.log('')
  console.log('  create another:')
  console.log(
    `    curl -s -X POST ${baseUrl}/api/intents -H 'content-type: application/json' \\\n      -H 'authorization: Bearer ${apiKey}' \\\n      -d '{"amount":"1.00","description":"A smaller widget","link":true}'`,
  )
  console.log('')
})

function shutdown(signal: string): void {
  console.log(`\nreceived ${signal}, shutting down`)
  server.close(() => {
    void merchant.close().then(() => process.exit(0))
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
