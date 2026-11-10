---
name: hood-pay
description: Take USDG payments on Robinhood Chain with @three-ws/hood-pay (hosted payment links, an embeddable pay button, webhooks) and verify any payment receipt on-chain. Use when building a merchant checkout on Robinhood Chain or when asked to confirm that a USDG payment really settled.
---

# hood-pay

`@three-ws/hood-pay` (npm, `npm install @three-ws/hood-pay viem`, Node 20+) is human checkout. The customer signs an EIP-3009 `transferWithAuthorization` for exactly the stated amount and recipient. A relayer pays gas and submits it. For agents paying APIs, use the sibling `hood402` package instead.

## Entry points

- `@three-ws/hood-pay`: payment model (intents, amounts, authorization, receipts, networks).
- `@three-ws/hood-pay/server`: `HoodPayMerchant`, `SqliteStore`, `expressHoodPay`, `honoHoodPay`, `createRouter`, `signWebhook`, `verifyWebhookSignature`, `constructWebhookEvent`.
- `@three-ws/hood-pay/widget`: the `<hood-pay-button>` custom element, with a React wrapper at `/widget/react`. Events: `hood-pay:state`, `hood-pay:settled`, `hood-pay:error`, `hood-pay:close`.
- `@three-ws/hood-pay/verify`: `verifyReceipt`, `verifyPaymentByHash`, `formatVerification`.

Networks: `robinhood` (4663) and `robinhood-testnet` (46630). USDG has 6 decimals.

## Merchant server

`new HoodPayMerchant({ payTo, network, baseUrl, store, relayer, webhook })`, mounted with `app.use(expressHoodPay({ merchant, apiKey }))`. That serves the hosted page `/pay/:id`, the `/api/intents` routes and `/healthz`. Then `merchant.createPaymentLink({ amount: '12.50', description, metadata, idempotencyKey, expiresInSeconds })` returns `{ intent, url }`. Set `relayer.maxAmountPerPayment` as a ceiling. Configure secrets in the server environment: `HOOD_PAY_RELAYER_KEY` (gas wallet, small float), `HOOD_PAY_API_KEY`, `HOOD_PAY_WEBHOOK_SECRET`. Never ask for these in chat or commit them.

## Verifying a payment (read only, safe)

```ts
import { verifyReceipt, verifyPaymentByHash, formatVerification } from '@three-ws/hood-pay/verify'

const result = await verifyReceipt({ receipt })
console.log(formatVerification(result))

const byHash = await verifyPaymentByHash({
  txHash: '0xabc...', network: 'robinhood', payTo: '0xYourReceivingAddress', amount: 12_500_000n,
})
```

Six checks run against chain state: the transaction did not revert, it hit the USDG contract, a `Transfer` log moves exactly the amount from payer to merchant, an `AuthorizationUsed` log matches the payer and nonce, `authorizationState` is now true, and the receipt digest recomputes. When `result.valid` is false, list the failed entries of `result.checks`.

From a clone, `npm run verify:receipt -- --receipt ./receipt.json` or `-- --tx 0xabc... --to 0xYourAddress --amount 12.50` does the same.

## Rules for the agent

Verification and code generation are safe. Starting a relayer with a funded key or creating real mainnet payment links is the operator's call: show network, payTo address and amount, and wait for a yes. Use `robinhood-testnet` while developing.
