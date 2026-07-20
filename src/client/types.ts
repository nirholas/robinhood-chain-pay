/**
 * Wire types the browser SDK consumes, re-exported from core so a consumer of
 * `hood-pay/client` never has to import from `hood-pay/server` (which pulls in
 * viem, hood402, and Node built-ins).
 */

export type {
  AuthorizationWire,
  CheckoutSession,
  ErrorResponse,
  IntentStatus,
  NetworkDescriptor,
  PayResponse,
  PaymentIntentWire,
  PaymentReceiptWire,
  SignedAuthorization,
} from '../core/types.js'

export type { Address, Hex } from '../core/networks.js'

/**
 * The shape passed to `eth_signTypedData_v4`. Structural rather than the exact
 * `TypedDataPayload` from core, because the field arrays are declared `as
 * const` there and a mutable literal built at runtime must still satisfy it.
 */
export interface TypedDataPayloadLike {
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>
  primaryType: string
  domain: { name: string; version: string; chainId: number; verifyingContract: string }
  message: import('../core/types.js').AuthorizationWire
}
