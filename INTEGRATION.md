# Integrating hood-pay

A checklist for wiring hood-pay into a real store, in the order the work
actually happens. Every snippet here runs against the shipped code.

- [Before you start](#before-you-start)
- [1. Stand up the merchant server](#1-stand-up-the-merchant-server)
- [2. Charge someone](#2-charge-someone)
- [3. Put checkout in front of the customer](#3-put-checkout-in-front-of-the-customer)
- [4. Fulfil on the webhook](#4-fulfil-on-the-webhook)
- [5. Reconcile independently](#5-reconcile-independently)
- [Going to production](#going-to-production)
- [Bringing your own database](#bringing-your-own-database)
- [Troubleshooting](#troubleshooting)

## Before you start

You need three things:

| Thing | Why | How to get it |
|---|---|---|
| A receiving address | Where USDG lands. Bound into every signature. | Any address you control. |
| A relayer key with native gas | Pays gas so the customer does not have to. | A separate hot wallet. Fund it with a small float. |
| A webhook secret and an API key | Signing events, and gating the merchant routes. | `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` |

Confirm the chain is what you think it is before writing any code:

```bash
npm run verify:usdg
```

Start on testnet (`robinhood-testnet`, chain 46630). Nothing about the
integration changes when you switch except the network id.

## 1. Stand up the merchant server

```ts
import express from 'express'
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { robinhoodTestnet } from 'viem/chains'
import { HoodPayMerchant, SqliteStore, expressHoodPay } from 'hood-pay/server'

const account = privateKeyToAccount(process.env.HOOD_PAY_RELAYER_KEY as `0x${string}`)
const transport = http('https://rpc.testnet.chain.robinhood.com')

export const merchant = new HoodPayMerchant({
  payTo: process.env.HOOD_PAY_PAY_TO as `0x${string}`,
  network: 'robinhood-testnet',
  merchantId: 'example-shop',
  baseUrl: process.env.HOOD_PAY_BASE_URL,
  store: new SqliteStore('./data/hood-pay.sqlite'),
  relayer: {
    reader: createPublicClient({ chain: robinhoodTestnet, transport }),
    writer: createWalletClient({ account, chain: robinhoodTestnet, transport }),
    address: account.address,
    chain: robinhoodTestnet,
    maxAmountPerPayment: 1_000_000_000n,
  },
  webhook: {
    url: `${process.env.HOOD_PAY_BASE_URL}/hooks/hood-pay`,
    secret: process.env.HOOD_PAY_WEBHOOK_SECRET!,
  },
})

const app = express()
app.use(express.json())
app.use(expressHoodPay({ merchant, apiKey: process.env.HOOD_PAY_API_KEY, merchantName: 'Example Shop' }))
app.listen(3000)
```

Check it:

```bash
curl -s localhost:3000/healthz
# {"ok":true,"merchantId":"example-shop","network":"robinhood-testnet","chainId":46630}
```

Requests that are not hood-pay routes fall through to `next()`, so this composes
with an existing app rather than taking over its router. To keep hood-pay in its
own namespace, pass `basePath: '/hood-pay'`.

### Hono

```ts
import { Hono } from 'hono'
import { honoHoodPay } from 'hood-pay/server'

const app = new Hono()
app.use('*', honoHoodPay({ merchant, apiKey: process.env.HOOD_PAY_API_KEY }))
```

Both adapters are thin translations of the same `createRouter` handler, so they
cannot drift. For a runtime with neither, call `createRouter` directly: it takes
`{ method, path, headers, body }` and returns `{ status, headers, body }`.

## 2. Charge someone

In-process:

```ts
const { intent, url } = await merchant.createPaymentLink({
  amount: '12.50',
  description: 'One large widget',
  metadata: { orderId: 'A-1043' },
  idempotencyKey: 'order-A-1043',
  expiresInSeconds: 900,
  successUrl: 'https://shop.example.com/orders/A-1043',
})
```

Over HTTP, from another service:

```bash
curl -s -X POST https://shop.example.com/api/intents \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $HOOD_PAY_API_KEY" \
  -d '{"amount":"12.50","description":"One large widget",
       "metadata":{"orderId":"A-1043"},
       "idempotencyKey":"order-A-1043","link":true}'
```

**Always pass `idempotencyKey`.** The intent id is derived from it, so a retried
create lands on the same row instead of billing the customer twice for one
order. Reusing a key with different parameters is a 409, not a silent overwrite.
Your order id is usually the right key.

`amount` is a decimal USDG string. Anything with more than six decimal places is
rejected rather than rounded, because silently truncating money is how you end
up off by a cent forever.

## 3. Put checkout in front of the customer

Pick one. They speak the same HTTP API, so you can switch later.

### Payment link (hosted page)

Send `url`. Nothing to build. Good for invoices, email, QR codes, support
workflows, and anywhere you do not control the page.

### Widget (embedded)

```html
<script src="https://unpkg.com/hood-pay/dist/browser/hood-pay.iife.js"></script>
<hood-pay-button intent-id="pi_2f1c..." api-base="https://shop.example.com"></hood-pay-button>
```

Good for a cart on your own site. Runs in the top-level window because a
cross-origin iframe cannot reach the customer's wallet.

Serve the intent id to the page from your own backend. Do not put the API key in
the browser: it mints payment links in your name.

### Neither

Drive it yourself with `hood-pay/client`:

```ts
import { HoodPayCheckout } from 'hood-pay/client'

const checkout = new HoodPayCheckout({
  intentId,
  apiBase: 'https://shop.example.com',
  onChange: (snapshot) => render(snapshot),   // one designed state per snapshot
})

await checkout.load()
await checkout.pay()
```

## 4. Fulfil on the webhook

**The webhook is the authoritative signal.** The browser event is for the UI: a
browser can be lied to, and a customer can close the tab between settlement and
the callback.

```ts
import express from 'express'
import { constructWebhookEvent } from 'hood-pay/server'

// Mount BEFORE express.json(). The signature covers the exact bytes received.
app.post('/hooks/hood-pay', express.raw({ type: 'application/json' }), async (req, res) => {
  let event
  try {
    event = await constructWebhookEvent({
      secret: process.env.HOOD_PAY_WEBHOOK_SECRET!,
      rawBody: (req.body as Buffer).toString('utf8'),
      signature: req.header('Hood-Pay-Signature') ?? '',
      toleranceSeconds: 300,
    })
  } catch {
    return res.sendStatus(400)
  }

  // Retries are expected. Deduplicate before doing anything with a side effect.
  if (await alreadyHandled(event.id)) return res.sendStatus(200)

  switch (event.type) {
    case 'payment_intent.succeeded':
      await markPaid(event.data.intent.metadata.orderId, event.data.receipt)
      break
    case 'payment_intent.failed':
      await notifyCustomerToRetry(event.data.intent.id)
      break
    case 'payment_intent.expired':
      await releaseInventory(event.data.intent.metadata.orderId)
      break
  }

  await recordHandled(event.id)
  res.sendStatus(200)
})
```

Events: `payment_intent.created`, `.processing`, `.succeeded`, `.failed`,
`.expired`, `.canceled`. Only `.succeeded` carries a receipt.

Answer 2xx quickly and do slow work afterwards. A 5xx, 429, or 408 is retried
with exponential backoff; any other 4xx is treated as a permanent rejection and
is not retried.

## 5. Reconcile independently

Never rely solely on your own database for a fact the chain already knows.

```ts
import { verifyReceipt } from 'hood-pay/verify'

const result = await verifyReceipt({ receipt, intent })
if (!result.valid) {
  await flagForReview(intent.id, result.checks.filter((c) => !c.ok))
}
```

Worth running:

- before shipping anything expensive
- on any receipt that reached you from outside your own database
- as a nightly sweep over the day's settled intents
- whenever a customer disputes a charge

It needs only an RPC URL, so it works from a machine that cannot reach your
merchant server at all, which is exactly what you want during an incident.

## Going to production

- [ ] Switch `network` to `robinhood` and the RPC to a mainnet endpoint.
- [ ] Move off `SqliteStore` if more than one process serves traffic. SQLite gives
      you the atomicity guarantees on one machine only.
- [ ] Fund the relayer and alarm on its native balance. When it runs dry, every
      payment fails at the last step, after the customer has already signed.
- [ ] Set `maxAmountPerPayment` to a real ceiling.
- [ ] Serve everything over HTTPS. Web Crypto, which the browser half uses to
      derive the nonce, is unavailable in an insecure context.
- [ ] Schedule `merchant.expireDue()` (every few minutes is plenty) so stored rows
      and emitted events keep up with deadlines on their own.
- [ ] Point `successUrl` and `cancelUrl` at your own origins.
- [ ] Keep the API key and webhook secret in a secret manager, not in the image.
- [ ] Decide your expiry. The 15-minute default is a reasonable checkout window;
      shorter is safer, longer is friendlier to a customer who wanders off.

## Bringing your own database

Implement `PaymentStore`. Two methods carry every safety property, and both must
be genuinely atomic:

```ts
import type { PaymentStore } from 'hood-pay/server'

class PostgresStore implements PaymentStore {
  // Must be a single INSERT ... ON CONFLICT. The id is derived from the
  // idempotency key, so a concurrent duplicate create must hit the conflict
  // path and return the existing row, or raise IdempotencyConflictError when
  // the stored fingerprint differs.
  async createIntent(intent, fingerprint) { /* ... */ }

  // Must be a single conditional UPDATE:
  //   UPDATE intents SET status = 'processing', payer = $1, authorization = $2
  //    WHERE id = $3 AND status IN ('requires_payment','failed') AND expires_at > $4
  // Exactly one concurrent caller may see one updated row.
  async claimRelay(id, payer, authorization, now) { /* ... */ }

  // ... the rest are ordinary reads and writes
}
```

`tests/store.test.ts` runs the same suite against both shipped implementations,
including the concurrent-claim case. Point it at yours before trusting it.

Even if you get `claimRelay` wrong, the token contract still refuses a second
charge: the nonce is derived from `(intent id, payer)` and
`authorizationState(payer, nonce)` flips on settlement. Database atomicity is
the first line of defence, not the only one.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Webhook signatures always fail | The raw body was consumed by a JSON parser | Mount `express.raw` before `express.json()`, verify the original bytes |
| `invalid_signature` on every payment | Signed against the other network's domain | The chain id is inside the EIP-712 domain: check `network` on both sides |
| `config_invalid` mentioning the nonce | The client generated its own nonce | Use `deriveNonce(intentId, payer)`, or the shipped client, which does |
| `amount_mismatch` on a correct-looking amount | Overpayment, or a decimal rounding difference | The amount must equal the intent exactly, to the atomic unit |
| `intent_expired` right after creating one | Server clocks disagree | Expiry is unix seconds on the server; check NTP |
| `relay_failed` with an RPC error | Relayer out of gas, or the RPC is down | Fund the relayer, alarm on its balance, use your own node |
| `settlement_reverted` | Payer spent the USDG between preflight and broadcast | Retryable: the nonce is not consumed by a revert, so the customer can pay again |
| Widget shows `wallet-missing` with a wallet installed | Page is not in a secure context | Serve over HTTPS or localhost |
| Widget never leaves `awaiting-signature` | Wallet popup was suppressed | The customer must open the wallet manually; the flow resumes on their action |
| `409` from `POST /api/intents` | Idempotency key reused with different parameters | Use a new key, or send the original parameters |
| Merchant routes return `401` with a correct key | No `apiKey` configured on the router | Merchant routes are disabled, not open, when unconfigured |

Anything not covered: every error carries a stable `code` and a `details` object
that is safe to log. Log both.
