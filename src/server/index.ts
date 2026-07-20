/**
 * `hood-pay/server`: everything a merchant runs.
 *
 * ```ts
 * import express from 'express'
 * import { createPublicClient, createWalletClient, http } from 'viem'
 * import { privateKeyToAccount } from 'viem/accounts'
 * import { robinhood } from 'viem/chains'
 * import { HoodPayMerchant, SqliteStore, expressHoodPay } from 'hood-pay/server'
 *
 * const account = privateKeyToAccount(process.env.HOOD_PAY_RELAYER_KEY as `0x${string}`)
 * const transport = http('https://rpc.mainnet.chain.robinhood.com')
 *
 * const merchant = new HoodPayMerchant({
 *   payTo: '0xYourReceivingAddress',
 *   store: new SqliteStore('./data/hood-pay.sqlite'),
 *   baseUrl: 'https://shop.example.com',
 *   relayer: {
 *     reader: createPublicClient({ chain: robinhood, transport }),
 *     writer: createWalletClient({ account, chain: robinhood, transport }),
 *     address: account.address,
 *     chain: robinhood,
 *   },
 * })
 *
 * const app = express()
 * app.use(express.json())
 * app.use(expressHoodPay({ merchant, apiKey: process.env.HOOD_PAY_API_KEY }))
 * app.listen(3000)
 * ```
 */

export { HoodPayMerchant } from './merchant.js'
export type {
  CheckoutSession,
  HoodPayMerchantOptions,
  MerchantIntentParams,
  PaymentLink,
  PayResult,
  RelayerConfig,
  WebhookConfig,
} from './merchant.js'

export { MemoryStore } from './store.js'
export type {
  ClaimResult,
  CreateResult,
  IntentPatch,
  ListIntentsOptions,
  PaymentStore,
  WebhookDelivery,
} from './store.js'

export { SqliteStore } from './sqlite-store.js'

export { preflight, relayAuthorization } from './relay.js'
export type {
  ChainReader,
  ChainWriter,
  PreflightOptions,
  PreflightResult,
  RelayOptions,
  RelayOutcome,
} from './relay.js'

export {
  DEFAULT_TOLERANCE_SECONDS,
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  SIGNATURE_SCHEME,
  buildEvent,
  constructWebhookEvent,
  dispatchWebhook,
  parseSignatureHeader,
  signWebhook,
  verifyWebhookSignature,
} from './webhooks.js'
export type {
  VerifyWebhookOptions,
  WebhookDispatchOptions,
  WebhookDispatchResult,
} from './webhooks.js'

export { CHECKOUT_SCRIPT, CHECKOUT_STYLES, escapeHtml, renderCheckoutPage } from './checkout-page.js'
export type { RenderCheckoutOptions } from './checkout-page.js'

export { createRouter } from './router.js'
export type { HoodPayHandler, HoodPayRequest, HoodPayResponse, RouterOptions } from './router.js'

export { expressHoodPay, honoHoodPay } from './adapters.js'

// Re-exported so a server file needs one import, not three.
export * from '../core/index.js'
