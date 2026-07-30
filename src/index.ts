/**
 * hood-pay: Stripe-Checkout-grade USDG payments for Robinhood Chain.
 *
 * This root entry exports the payment model: intents, amounts, the EIP-3009
 * authorization and its EIP-712 construction, receipts, and the network
 * registry. It has no server or browser dependencies.
 *
 *   `@three-ws/hood-pay/server`        the merchant server (relay, webhooks, stores, adapters)
 *   `@three-ws/hood-pay/client`        the browser SDK
 *   `@three-ws/hood-pay/widget`        the `<hood-pay-button>` custom element
 *   `@three-ws/hood-pay/widget/react`  the React wrapper
 *   `@three-ws/hood-pay/verify`        standalone on-chain receipt verification
 */

export * from './core/index.js'
