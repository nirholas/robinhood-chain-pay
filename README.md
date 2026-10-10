# hood-pay

<!-- three.ws:badges -->
[![GitHub stars](https://img.shields.io/github/stars/nirholas/robinhood-chain-pay?style=flat&logo=github)](https://github.com/nirholas/robinhood-chain-pay/stargazers) [![Last commit](https://img.shields.io/github/last-commit/nirholas/robinhood-chain-pay?style=flat)](https://github.com/nirholas/robinhood-chain-pay/commits) [![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat)](https://github.com/nirholas/robinhood-chain-pay/pulls) [![AI agent friendly](https://img.shields.io/badge/AI%20agents-AGENTS.md%20%2B%20llms.txt-6d5dfc?style=flat)](https://github.com/nirholas/robinhood-chain-pay/blob/HEAD/AGENTS.md)
<!-- /three.ws:badges -->


**Stripe-Checkout-grade USDG payments for [Robinhood Chain](https://docs.robinhood.com/chain/) (chain ID 4663): an embeddable widget, hosted payment links, and a merchant verification library.**

The customer signs one message and pays. They never send a transaction, never
hold a native token, and never see the word "gas". The merchant relays the
signed authorization, pays the gas, and gets a receipt that anyone can verify
on-chain with nothing but an RPC URL.

Docs: **https://github.com/nirholas/robinhood-chain-pay** (the reference pages under
[`docs/`](./docs/index.html) render from the repo; the hosted docs site is not published
right now, so the repo is the canonical source).

> hood-pay is human checkout. Its sibling [`hood402`](https://github.com/nirholas/robinhood-chain-x402)
> is the machine-to-machine HTTP 402 rail on the same chain and the same
> settlement mechanism. If your payer is an agent hitting an API, use hood402.
> If your payer is a person with a wallet and a cart, use hood-pay.

## Why gasless checkout is possible here, and how we know

USDG implements **EIP-3009** (`transferWithAuthorization`). That single fact is
what makes a Stripe-grade checkout possible on this chain, because it means the
customer's signature *is* the payment:

- The signed message binds the **amount**, the **recipient**, a **validity
  window**, and a **nonce**. A relayer can submit it or not; it cannot alter it.
- The customer needs **no native token**. They sign, they are done. No gas
  estimation, no stuck transaction, no "add ETH to continue".
- The token contract itself consumes the nonce, so the same authorization can
  never be settled twice, no matter how many times it is submitted.

Reproduce the whole claim against the live chain:

```bash
npm run verify:usdg
```

```
robinhood (chain 4663)  USDG 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
  getFacet(0xe3ee160e)  transferWithAuthorization      0x780d30b6a89BC9Eef953a543aA288c3B05b01309  [OK]
  getFacet(0xef55bec6)  receiveWithAuthorization       0x780d30b6a89BC9Eef953a543aA288c3B05b01309  [OK]
  getFacet(0xe94a0102)  authorizationState             0x780d30b6a89BC9Eef953a543aA288c3B05b01309  [OK]
  getFacet(0xd505accf)  permit (EIP-2612)              0x780d30b6a89BC9Eef953a543aA288c3B05b01309  [present]
  getFacet(0x7ecebe00)  nonces (EIP-2612)              0x780d30b6a89BC9Eef953a543aA288c3B05b01309  [present]
  getFacet(0xdeadbeef)  CONTROL: not a real function   not registered  [OK: control is unregistered]
  DOMAIN_SEPARATOR() live       0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036
  reconstructed offline         0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036
  name="Global Dollar" version="1"  [OK: match]
  decimals()                    6  [OK]

PASS: USDG exposes EIP-3009 and the EIP-712 domain reconstructs on every network.
```

Three things in that output are load-bearing.

**USDG is a facet/diamond contract**, so the honest way to ask whether it
implements a function is `getFacet(bytes4)`: a registered selector resolves to
a facet address, an unregistered one resolves to zero. The script probes
`0xdeadbeef` as a negative control, so a run that reports everything as
supported is visibly broken rather than quietly wrong.

**The EIP-712 domain reconstructs exactly.** `name="Global Dollar"`,
`version="1"`, the chain id, and the USDG address hash to precisely the
`DOMAIN_SEPARATOR()` the contract returns, on both networks. The message
hood-pay asks a customer to sign is the message the token will verify.
`tests/eip712.test.ts` asserts the mainnet value as a fixed vector, so a
regression in domain construction fails the test suite rather than a customer's
payment.

**EIP-2612 `permit` is also registered**, which some earlier write-ups of this
chain state otherwise. hood-pay still uses EIP-3009, and would even if permit
were available as the only alternative, because permit is the wrong primitive
for checkout:

| | EIP-2612 `permit` | EIP-3009 `transferWithAuthorization` |
|---|---|---|
| What the signature authorizes | an **allowance** to a spender | one **exact transfer** |
| Steps to get paid | 2 (`permit`, then `transferFrom`) | 1 |
| Residual risk after payment | a live allowance remains | none, the nonce is spent |
| Recipient bound in the signature | no | yes |
| Amount bound in the signature | ceiling only | exactly |
| Replay protection | sequential nonce (ordering-sensitive) | arbitrary nonce, consumed on use |

A checkout built on permit hands the merchant a standing allowance and still
needs a second call to collect. EIP-3009 signs the payment itself, and hood-pay
derives the nonce from `(intent id, payer)` so the token contract becomes the
double-charge guard rather than the merchant's database.

## Install

```bash
npm install @three-ws/hood-pay viem
```

Node >= 20. `viem` is a peer dependency, needed on the server and in the
verifier. The browser bundle has zero dependencies.

## Merchant quickstart

```ts
import express from 'express'
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { robinhood } from 'viem/chains'
import { HoodPayMerchant, SqliteStore, expressHoodPay } from '@three-ws/hood-pay/server'

const account = privateKeyToAccount(process.env.HOOD_PAY_RELAYER_KEY as `0x${string}`)
const transport = http('https://rpc.mainnet.chain.robinhood.com')

const merchant = new HoodPayMerchant({
  payTo: '0xYourReceivingAddress',
  network: 'robinhood',
  baseUrl: 'https://shop.example.com',
  store: new SqliteStore('./data/hood-pay.sqlite'),
  relayer: {
    reader: createPublicClient({ chain: robinhood, transport }),
    writer: createWalletClient({ account, chain: robinhood, transport }),
    address: account.address,
    chain: robinhood,
    maxAmountPerPayment: 1_000_000_000n, // 1,000 USDG ceiling
  },
  webhook: {
    url: 'https://shop.example.com/hooks/hood-pay',
    secret: process.env.HOOD_PAY_WEBHOOK_SECRET!,
  },
})

const app = express()
app.use(express.json())
app.use(expressHoodPay({ merchant, apiKey: process.env.HOOD_PAY_API_KEY }))
app.listen(3000)
```

That mounts the full surface: the hosted checkout page at `/pay/:id`, the
checkout API, and `/healthz`. Hono works the same way with `honoHoodPay`.

Create a payment link and send it to a customer:

```ts
const { intent, url } = await merchant.createPaymentLink({
  amount: '12.50',                 // USDG, exact
  description: 'One large widget',
  metadata: { orderId: 'A-1043' },
  idempotencyKey: 'order-A-1043',  // repeat-safe
  expiresInSeconds: 900,
})

console.log(url)  // https://shop.example.com/pay/pi_2f1c...
```

The hosted page is a single self-contained document: inline styles, inline
script, no CDN, no fonts, no external requests. It renders the amount,
description, recipient, and deadline on the server, so the customer sees the
terms before any JavaScript runs, and a `<noscript>` block explains exactly what
is missing when scripting is off.

## Widget quickstart

One script tag and one element:

```html
<script src="https://unpkg.com/@three-ws/hood-pay/dist/browser/hood-pay.iife.js"></script>

<hood-pay-button
  intent-id="pi_2f1c..."
  api-base="https://shop.example.com"
  merchant-name="Example Shop"
  label="Pay 12.50 USDG"
  theme="auto"></hood-pay-button>

<script>
  document.querySelector('hood-pay-button')
    .addEventListener('hood-pay:settled', (event) => {
      console.log(event.detail.receipt.digest)
    })
</script>
```

The bundle is 27 kB minified with no dependencies, because the browser half of
hood-pay never imports `viem`: it builds the EIP-712 payload itself and hands it
to the wallet's `eth_signTypedData_v4`.

If you are pinned to `@three-ws/hood-pay@0.1.1`, that one tarball published the
browser build a directory deeper, at
`https://unpkg.com/@three-ws/hood-pay@0.1.1/dist/browser/@three-ws/hood-pay.iife.js`.
The path above is the one the `exports` map has always declared and is correct
from the next release on.

Everything lives inside a shadow root, so the merchant's CSS cannot break the
widget and the widget cannot leak a rule onto the merchant's page. Branding
crosses that boundary through four custom properties:

```css
hood-pay-button {
  --hood-pay-accent: #6d28d9;
  --hood-pay-accent-text: #ffffff;
  --hood-pay-radius: 8px;
  --hood-pay-font: 'Inter', sans-serif;
}
```

React:

```tsx
import { HoodPayButton } from '@three-ws/hood-pay/widget/react'

<HoodPayButton
  intentId={intentId}
  apiBase="https://shop.example.com"
  onSettled={({ receipt }) => confirmOrder(receipt)}
  onError={({ code, message }) => reportProblem(code, message)}
/>
```

Every state is designed and reachable: `idle`, `wallet-missing`, `wrong-chain`,
`insufficient-usdg`, `awaiting-signature`, `relaying`, `settled`, `failed`,
`expired`, `canceled`. There is no fake progress anywhere; each state reflects a
real await.

Events: `hood-pay:state`, `hood-pay:settled`, `hood-pay:error`, `hood-pay:close`.

## Receipt verification

This is the part that makes a hood-pay receipt worth having. Given a receipt,
anyone can confirm the payment without asking the merchant, hood-pay, or an
indexer:

```ts
import { verifyReceipt, formatVerification } from '@three-ws/hood-pay/verify'

const result = await verifyReceipt({ receipt })   // uses the public RPC by default
console.log(formatVerification(result))

if (!result.valid) {
  for (const failure of result.checks.filter((c) => !c.ok)) {
    console.error(`${failure.id}: ${failure.detail}`)
  }
}
```

Six independent checks run against chain state:

1. the transaction exists and did not revert
2. it was sent to the USDG contract for the stated network
3. a USDG `Transfer` log moves **exactly** the stated amount from payer to merchant
4. an `AuthorizationUsed` log names the same payer and nonce
5. `authorizationState(payer, nonce)` is now `true`, so the authorization is spent
6. the receipt's own digest recomputes, catching tampering with the fields that
   are not independently observable (the intent id, the metadata hash)

Checks 3 and 5 carry the weight: this exact amount moved to this exact address,
and the signature that authorized it is permanently consumed.

No receipt? A transaction hash and what you were owed is enough:

```ts
import { verifyPaymentByHash } from '@three-ws/hood-pay/verify'

const result = await verifyPaymentByHash({
  txHash: '0xabc...',
  network: 'robinhood',
  payTo: '0xYourReceivingAddress',
  amount: 12_500_000n,   // atomic USDG, 6 decimals
})
```

From the command line:

```bash
npm run verify:receipt -- --receipt ./receipt.json
npm run verify:receipt -- --tx 0xabc... --to 0xYourAddress --amount 12.50
```

## Webhooks

Events are signed with HMAC-SHA-256 over a timestamp **and** the exact request
body:

```
Hood-Pay-Signature: t=1763558400,v1=0x9f2c...
```

The signed string is `${t}.${rawBody}`. Verify with the shipped helper:

```ts
import { constructWebhookEvent } from '@three-ws/hood-pay/server'

app.post('/hooks/hood-pay', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = await constructWebhookEvent({
      secret: process.env.HOOD_PAY_WEBHOOK_SECRET!,
      rawBody: req.body.toString('utf8'),
      signature: req.header('Hood-Pay-Signature') ?? '',
      toleranceSeconds: 300,
    })
    if (event.type === 'payment_intent.succeeded') {
      await fulfil(event.data.intent.metadata.orderId, event.data.receipt)
    }
    res.sendStatus(200)
  } catch {
    res.sendStatus(400)   // signature invalid, expired, or malformed
  }
})
```

Or with no hood-pay import at all, in any language:

```js
const crypto = require('node:crypto')
const [t, v1] = signatureHeader.split(',')
const timestamp = t.slice(2)
const expected = '0x' + crypto.createHmac('sha256', secret)
  .update(`${timestamp}.${rawBody}`).digest('hex')
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1.slice(3)))
```

Three rules, each of which has burned somebody:

- **Verify the raw bytes.** Mount your raw body parser *before* `express.json()`.
  Once the JSON parser has consumed the stream the original bytes are gone, and
  `JSON.stringify(req.body)` is not guaranteed to reproduce them.
- **Enforce the replay window.** `toleranceSeconds` defaults to 300. A captured
  delivery replayed a week later must be rejected, and a timestamp from the
  future is as suspicious as an ancient one.
- **Deduplicate on `Hood-Pay-Event-Id`.** Retries are expected: a 5xx, a 429, a
  408, or a transport error is retried with exponential backoff. A permanent 4xx
  is not retried.

Delivery failures never fail a payment. The money has already moved on-chain and
cannot be un-moved because a merchant's endpoint was down; failed attempts are
recorded and readable via `store.listWebhookDeliveries(intentId)`.

## API

### `hood-pay` (root)

| Export | Purpose |
|---|---|
| `createIntent(params, ctx)` | Build a payment intent (pure, no I/O) |
| `deriveIntentId(merchantId, key?)` | Deterministic id from an idempotency key |
| `intentFingerprint(params)` | Hash of the economically meaningful parameters |
| `canTransition` / `assertTransition` | The lifecycle state machine |
| `effectiveStatus(intent, now)` | Status with expiry folded in |
| `parseUsdg` / `formatUsdg` / `displayUsdg` | Amounts, bigint end to end |
| `buildTypedData(net, auth)` | The `eth_signTypedData_v4` payload |
| `deriveNonce(intentId, payer)` | The EIP-3009 nonce hood-pay binds to an intent |
| `splitSignature(sig)` | 65-byte signature to the `(v, r, s)` USDG expects |
| `buildReceipt` / `canonicalReceipt` / `receiptDigest` | Receipts |
| `NETWORKS`, `requireNetwork`, `txUrl` | Chain registry |
| `HoodPayError` and subclasses | Every failure, with a stable `code` |

### `@three-ws/hood-pay/server`

| Export | Purpose |
|---|---|
| `HoodPayMerchant` | Create intents and links, accept payment, relay, emit webhooks |
| `SqliteStore` / `MemoryStore` | Persistence (`node:sqlite`, no native module) |
| `PaymentStore` | The storage contract, for Postgres and friends |
| `expressHoodPay` / `honoHoodPay` | Framework adapters |
| `createRouter` | The framework-agnostic handler both adapters call |
| `renderCheckoutPage` | The hosted page, if you want to serve it yourself |
| `preflight` / `relayAuthorization` | The settlement path on its own |
| `signWebhook` / `verifyWebhookSignature` / `constructWebhookEvent` | Webhooks |

### `@three-ws/hood-pay/client`

| Export | Purpose |
|---|---|
| `HoodPayCheckout` | Drives one payment, with a snapshot per state |
| `discoverWallets` / `requireWallet` | EIP-6963 discovery, EIP-1193 fallback |
| `connect` / `ensureChain` / `signTypedData` | The wallet steps individually |
| `stateForErrorCode` | Map any error code onto a designed state |

### `@three-ws/hood-pay/widget` and `@three-ws/hood-pay/widget/react`

| Export | Purpose |
|---|---|
| `<hood-pay-button>` | The custom element (registered on import) |
| `HoodPayButton` | The React wrapper |
| `describeState(snapshot)` | The view model, one row per state |

### `@three-ws/hood-pay/verify`

| Export | Purpose |
|---|---|
| `verifyReceipt({ receipt, rpcUrl?, intent? })` | Full independent verification |
| `verifyPaymentByHash({ txHash, network, payTo, amount })` | Verify without a receipt |
| `formatVerification(result)` | Human-readable output for a CLI or log |

### HTTP routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/pay/:id` | public | Hosted checkout page |
| `GET` | `/api/intents/:id` | public | Checkout session JSON |
| `POST` | `/api/intents/:id/pay` | public | Submit a signed authorization |
| `GET` | `/api/intents/:id/receipt` | public | The verifiable receipt |
| `POST` | `/api/intents` | merchant | Create an intent or payment link |
| `GET` | `/api/intents` | merchant | List intents |
| `POST` | `/api/intents/:id/cancel` | merchant | Cancel an unpaid intent |
| `GET` | `/healthz` | public | Liveness |

Merchant routes require `Authorization: Bearer <apiKey>`. If you do not pass an
`apiKey` they are disabled outright rather than left open.

## Examples

```bash
npm run example:server
```

Boots a real merchant server with zero configuration: SQLite in a local file,
testnet, an ephemeral API key, a working webhook receiver, and a payment link
printed at startup. Set `HOOD_PAY_RELAYER_KEY` to a funded key to actually
settle; without one the server still serves checkout and the API, and refuses
settlement with a clear message instead of pretending to succeed.

`examples/checkout.html` is the widget on a static page, served at
`/static/checkout.html`.

## Relationship to hood402

hood-pay depends on [`hood402`](https://www.npmjs.com/package/hood402) and reuses
its protocol-level pieces rather than re-deriving them:

- `eip3009Abi`, the exact `(v, r, s)` ABI fragment for USDG's facet
- `verifyAuthorizationSignature`, EIP-712 recovery with ERC-1271 support for
  smart accounts
- its network registry, which `tests/hood402-parity.test.ts` asserts hood-pay's
  own constants match field by field

Everything above that layer is hood-pay's own, because the two products have
different invariants. hood402's `settlePayment` takes an x402 `PaymentPayload`
and `PaymentRequirements` and answers in x402's `invalidReason` vocabulary, all
of which describes a machine paying for an HTTP resource. Human checkout needs
an exact amount rather than a covered price, a nonce derived from the intent
rather than a random one, failures that map to states a customer sees in a
widget, and idempotency anchored on a merchant's intent row. Bending the intent
model into an x402 envelope to reuse one function would have made both sides
worse.

hood-pay's `src/core/` also keeps its own copy of the chain constants so the
browser bundle does not have to import `viem` for four values. That duplication
is deliberate and guarded by the parity test.

## Security

**The relayer key.** It pays gas and nothing else: it cannot change the amount,
the recipient, or the deadline, because all three are inside the customer's
signature. What it can do is spend its own gas balance, so treat it as a hot key
with a small float, keep it out of the process serving customer traffic if you
can, and set `maxAmountPerPayment` as a ceiling. Rotating it never invalidates a
receipt, because receipts point at chain state, not at the relayer.

**Spend limits.** `relayer.maxAmountPerPayment` refuses any single payment above
a ceiling. A relayer with an unbounded ceiling and a compromised merchant API is
a gas-drain machine.

**What the merchant must validate.** hood-pay enforces all of these on every
payment, before anything is broadcast:

- the recipient matches the intent exactly
- the amount matches the intent **exactly**, not "at least" (an overpayment is a
  customer's mistake, not a tip, so it is refused rather than pocketed)
- the nonce is the one derived from `(intent id, payer)`, not one the client chose
- the validity window covers now and never outlives the intent
- the signature recovers to the stated payer, over the right chain's domain
- the nonce is unused on-chain
- the payer's USDG balance covers the amount

Your own responsibilities:

- **Fulfil on the webhook or on a verified receipt, never on a browser event.**
  `hood-pay:settled` is for the UI. A browser can be lied to.
- **Verify receipts you did not issue.** If a receipt arrives from anywhere other
  than your own database, run `verifyReceipt` before honouring it.
- **Keep the API key server-side.** It mints payment links in your name.
- **Set `successUrl` and `cancelUrl` to your own origins.** hood-pay refuses any
  scheme other than http and https, but it cannot know which hosts are yours.

**Metadata is untrusted display data.** It is echoed to the hosted page, the
widget, and your webhook. It is HTML-escaped on render and hashed into the
receipt, but never treat it as an instruction or a capability.

## Limits and caveats

- **Exact amounts only.** No partial payments, no overpayment, no tipping on top
  of an intent. Charge a different amount by creating a different intent.
- **No refunds primitive.** A refund is an ordinary USDG transfer back to the
  payer, which hood-pay does not model. The receipt gives you the payer address.
- **One payer per intent.** The derived nonce is scoped to `(intent, payer)`, so
  a shared link paid by two different wallets is guarded by the store, not by the
  token contract. Do not publish a single link expecting many payers.
- **Expiry is enforced at write time and folded in at read time.** An intent past
  its deadline reports `expired` on the next read; run `merchant.expireDue()` on
  a schedule if you want the stored rows to keep up on their own.
- **The relayer needs native gas.** Gasless is the customer's experience, not the
  system's. Somebody pays; hood-pay makes sure it is not the person checking out.
- **`node:sqlite` is still marked experimental** in Node and prints a warning.
  `SqliteStore` is a single file with no native module; implement `PaymentStore`
  against your own database for anything larger than one process.
- **A settled payment cannot be undone.** There is no chargeback and no escrow.
  Verify before you ship the goods, not after.

## License

Proprietary, all rights reserved. See [LICENSE](./LICENSE).

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=nirholas/robinhood-chain-pay&type=Date)](https://www.star-history.com/#nirholas/robinhood-chain-pay&Date)

<!-- three.ws:growth -->
## Support the project

If robinhood-chain-pay saves you time, **[star it on GitHub](https://github.com/nirholas/robinhood-chain-pay)**. Stars are how other developers and AI agents find the repositories worth trusting, and they cost you one click.

Know someone who would use it? [Post on X](https://twitter.com/intent/tweet?text=robinhood-chain-pay%3A%20Stripe-Checkout-grade%20USDG%20payments%20for%20Robinhood%20Chain%3A%20embeddable%20widget%2C%20hosted%20payment%20links&url=https%3A%2F%2Fgithub.com%2Fnirholas%2Frobinhood-chain-pay) · [Share on Bluesky](https://bsky.app/intent/compose?text=robinhood-chain-pay%3A%20Stripe-Checkout-grade%20USDG%20payments%20for%20Robinhood%20Chain%3A%20embeddable%20widget%2C%20hosted%20payment%20links%20https%3A%2F%2Fgithub.com%2Fnirholas%2Frobinhood-chain-pay) · [Share on LinkedIn](https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fgithub.com%2Fnirholas%2Frobinhood-chain-pay) · [Submit to Hacker News](https://news.ycombinator.com/submitlink?u=https%3A%2F%2Fgithub.com%2Fnirholas%2Frobinhood-chain-pay&t=robinhood-chain-pay%3A%20Stripe-Checkout-grade%20USDG%20payments%20for%20Robinhood%20Chain%3A%20embeddable%20widget%2C%20hosted%20payment%20links) · [Share on Reddit](https://www.reddit.com/submit?url=https%3A%2F%2Fgithub.com%2Fnirholas%2Frobinhood-chain-pay&title=robinhood-chain-pay%3A%20Stripe-Checkout-grade%20USDG%20payments%20for%20Robinhood%20Chain%3A%20embeddable%20widget%2C%20hosted%20payment%20links)

## Built for AI agents too

Coding agents and LLM tooling can read this repo directly: [AGENTS.md](./AGENTS.md), [llms.txt](./llms.txt), [llms-full.txt](./llms-full.txt). Point an agent at `https://github.com/nirholas/robinhood-chain-pay` and it has the context it needs.

## More from the same author

- [All repositories by nirholas](https://github.com/nirholas/nirholas#readme): the full catalog, grouped by topic
- [three.ws](https://three.ws): the platform for 3D AI agents with Solana wallets, a skill marketplace and x402 payments
- Questions or ideas: [open an issue](https://github.com/nirholas/robinhood-chain-pay/issues) or [start a discussion](https://github.com/nirholas/robinhood-chain-pay/discussions)

## Contributors

[![Contributors](https://contrib.rocks/image?repo=nirholas/robinhood-chain-pay)](https://github.com/nirholas/robinhood-chain-pay/graphs/contributors)

<!-- /three.ws:growth -->
