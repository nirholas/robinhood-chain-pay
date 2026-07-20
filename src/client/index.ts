/**
 * `hood-pay/client`: the browser SDK.
 *
 * It owns one payment: load the session, pick a wallet, put the wallet on the
 * right chain, derive the nonce, sign the EIP-712 authorization, post it, and
 * report the outcome. Every step that can fail has a designed state and a
 * typed error, because a checkout that silently does nothing is worse than one
 * that says why.
 *
 * There is no `viem` here on purpose. A checkout widget that costs a merchant
 * hundreds of kilobytes of JavaScript will not get embedded, and the only
 * cryptography the browser needs is a SHA-256 (Web Crypto) and whatever the
 * wallet does behind `eth_signTypedData_v4`.
 */

import {
  HoodPayError,
  NetworkError,
  WalletNotFoundError,
  toHoodPayError,
} from '../core/errors.js'
import { deriveNonce } from '../core/eip712.js'
import type { Address, Hex } from '../core/networks.js'
import type {
  AuthorizationWire,
  CheckoutSession,
  ErrorResponse,
  PayResponse,
  TypedDataPayloadLike,
} from './types.js'
import {
  connect,
  discoverWallets,
  ensureChain,
  requireWallet,
  signTypedData,
  type DiscoveredWallet,
  type Eip1193Provider,
} from './provider.js'

export * from './provider.js'

/**
 * Every state a checkout can be in. The widget renders one design per state,
 * and nothing else is reachable.
 */
export type CheckoutState =
  | 'loading'
  | 'idle'
  | 'wallet-missing'
  | 'wrong-chain'
  | 'insufficient-usdg'
  | 'awaiting-signature'
  | 'relaying'
  | 'settled'
  | 'failed'
  | 'expired'
  | 'canceled'

export interface CheckoutSnapshot {
  state: CheckoutState
  /** Customer-facing explanation of the current state. */
  message: string
  session?: CheckoutSession
  result?: PayResponse
  error?: HoodPayError
  wallets: DiscoveredWallet[]
  selectedWallet?: DiscoveredWallet
}

export interface HoodPayCheckoutOptions {
  /** The intent to pay. */
  intentId: string
  /**
   * Origin (and optional base path) of the merchant server, e.g.
   * `'https://shop.example.com'`. Defaults to the current origin.
   */
  apiBase?: string
  /** Called on every state change. */
  onChange?: (snapshot: CheckoutSnapshot) => void
  /** Override the wallet instead of discovering one. */
  provider?: Eip1193Provider
  /** Injectable fetch, for tests and for non-browser hosts. */
  fetchImpl?: typeof fetch
  /** Injectable clock in unix seconds. */
  now?: () => number
  /** How long to wait for EIP-6963 announcements, in ms. */
  discoveryTimeoutMs?: number
}

const STATE_MESSAGES: Record<CheckoutState, string> = {
  loading: 'Loading payment details.',
  idle: 'Ready to pay. You will sign a message, not a transaction, so no gas is required.',
  'wallet-missing': 'No Ethereum wallet was detected in this browser.',
  'wrong-chain': 'Your wallet is on a different network.',
  'insufficient-usdg': 'This wallet does not hold enough USDG for this payment.',
  'awaiting-signature': 'Approve the request in your wallet.',
  relaying: 'Submitting your payment. The merchant pays the gas.',
  settled: 'Payment complete.',
  failed: 'The payment could not be completed.',
  expired: 'This payment link has expired.',
  canceled: 'This payment was canceled.',
}

/** Map a server error code onto the state the customer should see. */
export function stateForErrorCode(code: string): CheckoutState {
  switch (code) {
    case 'insufficient_funds':
      return 'insufficient-usdg'
    case 'intent_expired':
    case 'authorization_expired':
      return 'expired'
    case 'intent_canceled':
      return 'canceled'
    case 'intent_already_paid':
      return 'settled'
    case 'wallet_not_found':
      return 'wallet-missing'
    case 'wrong_chain':
      return 'wrong-chain'
    case 'wallet_rejected':
      return 'idle'
    default:
      return 'failed'
  }
}

/**
 * Drives one payment from an intent id to a settled receipt.
 *
 * ```ts
 * const checkout = new HoodPayCheckout({
 *   intentId: 'pi_2f1c...',
 *   apiBase: 'https://shop.example.com',
 *   onChange: (s) => render(s),
 * })
 * await checkout.load()
 * const { receipt } = await checkout.pay()
 * ```
 */
export class HoodPayCheckout {
  private readonly options: HoodPayCheckoutOptions
  private readonly fetchImpl: typeof fetch
  private readonly clock: () => number
  private snapshot: CheckoutSnapshot = { state: 'loading', message: STATE_MESSAGES.loading, wallets: [] }

  constructor(options: HoodPayCheckoutOptions) {
    if (!options.intentId) {
      throw new HoodPayError('config_invalid', 'hood-pay: `intentId` is required')
    }
    this.options = options
    const impl = options.fetchImpl ?? globalThis.fetch
    if (!impl) {
      throw new HoodPayError(
        'config_invalid',
        'hood-pay: no `fetch` implementation is available. Pass `fetchImpl`.',
      )
    }
    this.fetchImpl = impl.bind(globalThis)
    this.clock = options.now ?? ((): number => Math.floor(Date.now() / 1000))
  }

  /** The current snapshot. Safe to read at any time. */
  get current(): CheckoutSnapshot {
    return this.snapshot
  }

  private get base(): string {
    const configured = this.options.apiBase
    if (configured !== undefined) return configured.replace(/\/+$/, '')
    if (typeof location === 'undefined') {
      throw new HoodPayError(
        'config_invalid',
        'hood-pay: `apiBase` is required outside a browser context',
      )
    }
    return location.origin
  }

  private set(patch: Partial<CheckoutSnapshot> & { state: CheckoutState }): CheckoutSnapshot {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      message: patch.message ?? STATE_MESSAGES[patch.state],
    }
    this.options.onChange?.(this.snapshot)
    return this.snapshot
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.base}${path}`, init)
    } catch (err) {
      throw new NetworkError(
        `hood-pay: could not reach the merchant server. ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : {}
    } catch {
      throw new NetworkError(
        `hood-pay: the merchant server returned a non-JSON response (HTTP ${response.status})`,
      )
    }
    if (!response.ok) {
      const body = parsed as ErrorResponse
      const detail = body?.error
      throw new HoodPayError(
        (detail?.code ?? 'network_error') as HoodPayError['code'],
        detail?.message ?? `hood-pay: the merchant server returned HTTP ${response.status}`,
        detail?.details ?? {},
      )
    }
    return parsed as T
  }

  /** Load the checkout session and discover wallets. */
  async load(): Promise<CheckoutSnapshot> {
    this.set({ state: 'loading' })
    let session: CheckoutSession
    try {
      session = await this.json<CheckoutSession>(
        `/api/intents/${encodeURIComponent(this.options.intentId)}`,
      )
    } catch (err) {
      const error = toHoodPayError(err)
      return this.set({ state: stateForErrorCode(error.code), message: error.message, error })
    }

    const wallets = this.options.provider
      ? [
          {
            info: { uuid: 'provided', name: 'Wallet', rdns: 'unknown.provided' },
            provider: this.options.provider,
          },
        ]
      : await discoverWallets(this.options.discoveryTimeoutMs)

    const base: Partial<CheckoutSnapshot> = {
      session,
      wallets,
      ...(wallets[0] ? { selectedWallet: wallets[0] } : {}),
    }

    if (session.intent.status === 'succeeded') {
      return this.set({
        ...base,
        state: 'settled',
        result: {
          intent: session.intent,
          ...(session.receipt ? { receipt: session.receipt } : {}),
          ...(session.explorerTxUrl ? { explorerTxUrl: session.explorerTxUrl } : {}),
        },
      })
    }
    if (session.intent.status === 'expired') return this.set({ ...base, state: 'expired' })
    if (session.intent.status === 'canceled') return this.set({ ...base, state: 'canceled' })
    if (wallets.length === 0) return this.set({ ...base, state: 'wallet-missing' })
    return this.set({ ...base, state: 'idle' })
  }

  /** Choose which discovered wallet to pay with. */
  selectWallet(wallet: DiscoveredWallet): CheckoutSnapshot {
    return this.set({ state: this.snapshot.state, selectedWallet: wallet })
  }

  /**
   * Run the payment. Resolves with the settlement response, or throws a
   * `HoodPayError` after moving the snapshot into the matching state, so a
   * caller can either await the result or just render `onChange`.
   */
  async pay(): Promise<PayResponse> {
    const session = this.snapshot.session ?? (await this.load()).session
    if (!session) {
      throw this.snapshot.error ?? new HoodPayError('config_invalid', 'hood-pay: no checkout session')
    }

    const wallet =
      this.snapshot.selectedWallet ??
      (this.options.provider
        ? { info: { uuid: 'provided', name: 'Wallet', rdns: 'unknown.provided' }, provider: this.options.provider }
        : await requireWallet(this.options.discoveryTimeoutMs).catch(() => undefined))

    if (!wallet) {
      const error = new WalletNotFoundError()
      this.set({ state: 'wallet-missing', message: error.message, error })
      throw error
    }

    const intent = session.intent
    const net = session.network

    try {
      this.set({ state: 'awaiting-signature', selectedWallet: wallet })
      const payer = await connect(wallet.provider)

      await ensureChain(wallet.provider, {
        chainId: net.chainId,
        chainIdHex: net.chainIdHex as Hex,
        label: net.label,
        rpcUrl: net.rpcUrl,
        explorerUrl: net.explorerUrl,
      })

      const nonce = await deriveNonce(intent.id, payer)
      const validAfter = 0n
      const validBefore = BigInt(this.clock() + session.authorizationValiditySeconds)
      const authorization: AuthorizationWire = {
        from: payer,
        to: intent.payTo as Address,
        value: intent.amount,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      }

      const typedData: TypedDataPayloadLike = {
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
          TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        },
        primaryType: 'TransferWithAuthorization',
        domain: {
          name: net.usdgDomain.name,
          version: net.usdgDomain.version,
          chainId: net.chainId,
          verifyingContract: net.usdg,
        },
        message: authorization,
      }

      const signature = await signTypedData(wallet.provider, payer, typedData)

      this.set({ state: 'relaying' })
      const result = await this.json<PayResponse>(
        `/api/intents/${encodeURIComponent(intent.id)}/pay`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ signature, authorization }),
        },
      )

      this.set({ state: 'settled', result, session: { ...session, intent: result.intent } })
      return result
    } catch (err) {
      const error = toHoodPayError(err)
      const state = stateForErrorCode(error.code)
      this.set({
        state,
        error,
        message:
          error.code === 'wallet_rejected'
            ? 'You canceled the request. Nothing was charged.'
            : error.message,
      })
      throw error
    }
  }

  /** Re-read the session from the server, for example after a failure. */
  async refresh(): Promise<CheckoutSnapshot> {
    return this.load()
  }
}
