/**
 * hood-pay: Stripe-Checkout-grade USDG payments for Robinhood Chain.
 *
 * This root entry exports the payment model: intents, amounts, the EIP-3009
 * authorization and its EIP-712 construction, receipts, and the network
 * registry. It has no server or browser dependencies.
 *
 *   `hood-pay/server`        the merchant server (relay, webhooks, stores, adapters)
 *   `hood-pay/client`        the browser SDK
 *   `hood-pay/widget`        the `<hood-pay-button>` custom element
 *   `hood-pay/widget/react`  the React wrapper
 *   `hood-pay/verify`        standalone on-chain receipt verification
 */

export * from './core/index.js'
