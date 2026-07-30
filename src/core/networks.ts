/**
 * Robinhood Chain network constants, as plain data.
 *
 * This module has NO imports on purpose. `hood-pay`'s browser bundle (the
 * widget and the client SDK) needs the chain id, the USDG address, and the
 * EIP-712 domain fields, and nothing else. Importing `viem/chains` here would
 * drag the whole of viem into a `<script>` tag for four constants.
 *
 * The values are the same ones the sibling `hood402` package resolves at
 * runtime from `viem/chains`. `tests/hood402-parity.test.ts` imports `hood402`
 * and asserts every field below matches its registry, so the two can never
 * drift apart silently.
 *
 * Verified on-chain (see `hood402`'s `npm run verify:usdg`): USDG is a
 * facet/diamond stablecoin with EIP-3009 `transferWithAuthorization` (selector
 * `0xe3ee160e`), `receiveWithAuthorization`, and `authorizationState`
 * registered as facets on both networks, 6 decimals, and an EIP-712 domain of
 * `name="Global Dollar", version="1"` that reconstructs to exactly the live
 * `DOMAIN_SEPARATOR()`.
 */

/** A 0x-prefixed hex string. */
export type Hex = `0x${string}`
/** A 0x-prefixed 20-byte address. */
export type Address = `0x${string}`

export interface HoodPayNetwork {
  /** Canonical network id used in intents, receipts, and webhooks. */
  readonly id: string
  /** EVM chain id. */
  readonly chainId: number
  /** Human label for UI surfaces. */
  readonly label: string
  /** Default public JSON-RPC endpoint. */
  readonly rpcUrl: string
  /** Blockscout-style explorer base URL (no trailing slash). */
  readonly explorerUrl: string
  /** USDG (Global Dollar) token address. */
  readonly usdg: Address
  /** USDG decimals. 6 on both networks. */
  readonly usdgDecimals: number
  /** EIP-712 domain `name`/`version` for USDG. */
  readonly usdgDomain: { readonly name: string; readonly version: string }
  /** Whether this is a test network. */
  readonly testnet: boolean
}

export const ROBINHOOD_MAINNET: HoodPayNetwork = {
  id: 'robinhood',
  chainId: 4663,
  label: 'Robinhood Chain',
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  explorerUrl: 'https://robinhoodchain.blockscout.com',
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  usdgDecimals: 6,
  usdgDomain: { name: 'Global Dollar', version: '1' },
  testnet: false,
}

export const ROBINHOOD_TESTNET: HoodPayNetwork = {
  id: 'robinhood-testnet',
  chainId: 46630,
  label: 'Robinhood Chain Testnet',
  rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
  explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
  usdg: '0x7E955252E15c84f5768B83c41a71F9eba181802F',
  usdgDecimals: 6,
  usdgDomain: { name: 'Global Dollar', version: '1' },
  testnet: true,
}

/** Every network hood-pay can take a payment on. */
export const NETWORKS: readonly HoodPayNetwork[] = [ROBINHOOD_MAINNET, ROBINHOOD_TESTNET]

const ALIASES: Record<string, HoodPayNetwork> = {
  robinhood: ROBINHOOD_MAINNET,
  'robinhood-chain': ROBINHOOD_MAINNET,
  'robinhood-mainnet': ROBINHOOD_MAINNET,
  mainnet: ROBINHOOD_MAINNET,
  '4663': ROBINHOOD_MAINNET,
  'eip155:4663': ROBINHOOD_MAINNET,
  'robinhood-testnet': ROBINHOOD_TESTNET,
  'robinhood-sepolia': ROBINHOOD_TESTNET,
  testnet: ROBINHOOD_TESTNET,
  '46630': ROBINHOOD_TESTNET,
  'eip155:46630': ROBINHOOD_TESTNET,
}

/** Resolve a network by id, alias, or chain id. `undefined` when unknown. */
export function resolveNetwork(idOrChainId: string | number): HoodPayNetwork | undefined {
  return ALIASES[String(idOrChainId).toLowerCase()]
}

/** Resolve a network or throw a descriptive error. */
export function requireNetwork(idOrChainId: string | number): HoodPayNetwork {
  const net = resolveNetwork(idOrChainId)
  if (!net) {
    throw new Error(
      `hood-pay: unknown network "${idOrChainId}". Supported: ${Object.keys(ALIASES).join(', ')}`,
    )
  }
  return net
}

/** Explorer URL for a transaction hash on a network. */
export function txUrl(net: HoodPayNetwork, hash: string): string {
  return `${net.explorerUrl}/tx/${hash}`
}

/** Explorer URL for an address on a network. */
export function addressUrl(net: HoodPayNetwork, address: string): string {
  return `${net.explorerUrl}/address/${address}`
}

/** The `eth_chainId` hex form a wallet reports, e.g. `0x1237` for 4663. */
export function chainIdHex(net: HoodPayNetwork): Hex {
  return `0x${net.chainId.toString(16)}`
}
