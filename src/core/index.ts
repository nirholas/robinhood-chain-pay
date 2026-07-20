/**
 * `hood-pay` core: the payment model shared by the server, the browser SDK,
 * the widget, and the standalone verifier.
 *
 * Nothing in this directory imports `viem`, `hood402`, or any Node built-in.
 * That constraint is what lets the same intent, amount, EIP-712, and receipt
 * code run inside a 20 kB browser bundle and inside a merchant server without
 * two implementations that can disagree.
 */

export {
  AmountError,
  USDG_DECIMALS,
  displayUsdg,
  formatUsdg,
  parseUsdg,
} from './amount.js'

export {
  ConfigError,
  HoodPayError,
  IdempotencyConflictError,
  InsufficientFundsError,
  IntentExpiredError,
  IntentNotFoundError,
  NetworkError,
  RelayError,
  WalletNotFoundError,
  WalletRejectedError,
  WrongChainError,
  toHoodPayError,
  walletErrorCode,
} from './errors.js'
export type { HoodPayErrorCode } from './errors.js'

export {
  NETWORKS,
  ROBINHOOD_MAINNET,
  ROBINHOOD_TESTNET,
  addressUrl,
  chainIdHex,
  requireNetwork,
  resolveNetwork,
  txUrl,
} from './networks.js'
export type { Address, Hex, HoodPayNetwork } from './networks.js'

export {
  fromHex,
  hmacSha256Hex,
  randomHex32,
  randomId,
  sha256Hex,
  timingSafeEqual,
  toHex,
} from './hash.js'

export {
  EIP712_DOMAIN_TYPE,
  TRANSFER_WITH_AUTHORIZATION_TYPE,
  buildTypedData,
  deriveNonce,
  fromWire,
  sameAddress,
  splitSignature,
  toWire,
  usdgDomain,
} from './eip712.js'
export type { Eip712Domain, TypedDataPayload } from './eip712.js'

export {
  DEFAULT_EXPIRY_SECONDS,
  MAX_EXPIRY_SECONDS,
  MAX_METADATA_KEYS,
  MAX_METADATA_VALUE_LENGTH,
  MIN_EXPIRY_SECONDS,
  TERMINAL_STATUSES,
  assertTransition,
  canTransition,
  canonicalMetadata,
  createIntent,
  deriveIntentId,
  deserializeIntent,
  effectiveStatus,
  intentFingerprint,
  isPayable,
  serializeIntent,
} from './intent.js'
export type { CreateIntentContext } from './intent.js'

export {
  RECEIPT_VERSION,
  buildReceipt,
  canonicalReceipt,
  deserializeReceipt,
  isDigestValid,
  metadataHash,
  receiptDigest,
  serializeReceipt,
} from './receipt.js'
export type { BuildReceiptParams } from './receipt.js'

export type {
  Authorization,
  AuthorizationWire,
  CreateIntentParams,
  IntentStatus,
  PaymentIntent,
  PaymentIntentWire,
  PaymentReceipt,
  PaymentReceiptWire,
  SignedAuthorization,
  WebhookEvent,
  WebhookEventType,
} from './types.js'
