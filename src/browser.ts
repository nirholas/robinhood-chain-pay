/**
 * Browser bundle entry.
 *
 * Everything reachable from here is free of `viem`, `hood402`, and Node
 * built-ins, which is what keeps the single-`<script>` build small. Loading it
 * registers `<hood-pay-button>` and exposes the SDK on `window.HoodPay`.
 *
 * ```html
 * <script src="https://unpkg.com/@three-ws/hood-pay/dist/browser/hood-pay.iife.js"></script>
 * <hood-pay-button intent-id="pi_..." api-base="https://shop.example.com"></hood-pay-button>
 * ```
 */

export {
  HoodPayCheckout,
  stateForErrorCode,
  type CheckoutSnapshot,
  type CheckoutState,
  type HoodPayCheckoutOptions,
} from './client/index.js'

export {
  connect,
  currentChainId,
  discoverWallets,
  ensureChain,
  requireWallet,
  signTypedData,
  type DiscoveredWallet,
  type Eip1193Provider,
  type WalletInfo,
} from './client/provider.js'

export {
  HoodPayButtonElement,
  TAG_NAME,
  defineHoodPayButton,
  describeState,
  explorerLink,
  payLabel,
  receiptFingerprint,
} from './widget/index.js'

export {
  HoodPayError,
  NETWORKS,
  ROBINHOOD_MAINNET,
  ROBINHOOD_TESTNET,
  buildTypedData,
  deriveNonce,
  displayUsdg,
  formatUsdg,
  parseUsdg,
  requireNetwork,
  resolveNetwork,
} from './core/index.js'
