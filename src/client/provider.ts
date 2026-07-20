/**
 * Wallet discovery over EIP-6963, with an EIP-1193 fallback.
 *
 * EIP-6963 exists because `window.ethereum` is a single slot that several
 * installed wallets fight over, and whoever wins is not necessarily the one
 * the customer wants to pay with. Announcing wallets over an event lets the
 * checkout show all of them. When no wallet announces itself, a legacy
 * `window.ethereum` is still offered rather than telling a customer with a
 * working wallet that they have none.
 */

import {
  WalletNotFoundError,
  WrongChainError,
  toHoodPayError,
  walletErrorCode,
} from '../core/errors.js'
import type { Address, Hex } from '../core/networks.js'

/** The minimal EIP-1193 surface hood-pay uses. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>
  on?(event: string, listener: (...args: unknown[]) => void): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
}

/** EIP-6963 provider metadata. */
export interface WalletInfo {
  uuid: string
  name: string
  icon?: string
  rdns: string
}

/** A discovered wallet: its metadata plus the provider to talk to it. */
export interface DiscoveredWallet {
  info: WalletInfo
  provider: Eip1193Provider
}

interface Eip6963AnnounceEvent extends Event {
  detail: DiscoveredWallet
}

interface EthereumWindow {
  ethereum?: Eip1193Provider
  addEventListener: Window['addEventListener']
  removeEventListener: Window['removeEventListener']
  dispatchEvent: Window['dispatchEvent']
}

function browserWindow(): EthereumWindow | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as EthereumWindow)
}

/**
 * Discover every announced wallet.
 *
 * EIP-6963 announcements are synchronous responses to a request event, but
 * some wallets announce on their own schedule during page load, so this waits
 * a short window before resolving. `timeoutMs` is that window, not a network
 * timeout.
 */
export async function discoverWallets(timeoutMs = 120): Promise<DiscoveredWallet[]> {
  const win = browserWindow()
  if (!win) return []

  const found: DiscoveredWallet[] = []
  const seen = new Set<string>()

  const onAnnounce = (event: Event): void => {
    const detail = (event as Eip6963AnnounceEvent).detail
    if (!detail?.info?.uuid || seen.has(detail.info.uuid)) return
    seen.add(detail.info.uuid)
    found.push(detail)
  }

  win.addEventListener('eip6963:announceProvider', onAnnounce)
  win.dispatchEvent(new Event('eip6963:requestProvider'))
  await new Promise((resolve) => setTimeout(resolve, timeoutMs))
  win.removeEventListener('eip6963:announceProvider', onAnnounce)

  if (found.length === 0 && win.ethereum) {
    found.push({
      info: { uuid: 'injected', name: 'Browser wallet', rdns: 'unknown.injected' },
      provider: win.ethereum,
    })
  }
  return found
}

/** The first announced wallet, or the injected one. Throws when there is none. */
export async function requireWallet(timeoutMs?: number): Promise<DiscoveredWallet> {
  const wallets = await discoverWallets(timeoutMs)
  const first = wallets[0]
  if (!first) throw new WalletNotFoundError()
  return first
}

async function request<T>(provider: Eip1193Provider, method: string, params?: unknown[]): Promise<T> {
  try {
    return (await provider.request({ method, ...(params ? { params } : {}) })) as T
  } catch (err) {
    throw toHoodPayError(err, 'network_error')
  }
}

/** Prompt for account access and return the selected address. */
export async function connect(provider: Eip1193Provider): Promise<Address> {
  const accounts = await request<string[]>(provider, 'eth_requestAccounts')
  const first = accounts?.[0]
  if (!first) throw new WalletNotFoundError()
  return first as Address
}

/** The wallet's current chain id, or `null` when it will not say. */
export async function currentChainId(provider: Eip1193Provider): Promise<number | null> {
  const raw = await request<string>(provider, 'eth_chainId')
  const parsed = Number.parseInt(raw, 16)
  return Number.isNaN(parsed) ? null : parsed
}

export interface ChainDescriptor {
  chainId: number
  chainIdHex: Hex
  label: string
  rpcUrl: string
  explorerUrl: string
}

/**
 * Make sure the wallet is on the right chain, switching (and adding the chain
 * if the wallet does not know it) when necessary.
 *
 * Wallets report an unknown chain as either 4902 or, in some builds, a generic
 * -32603, so both are treated as "try adding it".
 */
export async function ensureChain(provider: Eip1193Provider, chain: ChainDescriptor): Promise<void> {
  const current = await currentChainId(provider)
  if (current === chain.chainId) return

  try {
    await request(provider, 'wallet_switchEthereumChain', [{ chainId: chain.chainIdHex }])
  } catch (err) {
    // 4902 is "unrecognized chain". Some wallet builds report the same
    // condition as a generic -32603, so both mean "offer to add it".
    const code = walletErrorCode(err)
    if (code !== 4902 && code !== -32603) throw err
    await request(provider, 'wallet_addEthereumChain', [
      {
        chainId: chain.chainIdHex,
        chainName: chain.label,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: [chain.rpcUrl],
        blockExplorerUrls: [chain.explorerUrl],
      },
    ])
  }

  const after = await currentChainId(provider)
  if (after !== chain.chainId) throw new WrongChainError(chain.chainId, after)
}

/** Ask the wallet to sign an EIP-712 payload. */
export async function signTypedData(
  provider: Eip1193Provider,
  account: Address,
  typedData: unknown,
): Promise<Hex> {
  return request<Hex>(provider, 'eth_signTypedData_v4', [account, JSON.stringify(typedData)])
}
