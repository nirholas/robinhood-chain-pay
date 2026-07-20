/**
 * Test doubles for the two external interfaces hood-pay talks to: an EVM chain
 * and a browser wallet.
 *
 * These are stand-ins for interfaces owned by someone else, which is the one
 * legitimate use of a double. Nothing here fakes hood-pay's own behaviour:
 * every intent, authorization, signature, and receipt in the suite is real,
 * produced by the shipped code, and the signatures are genuine secp256k1
 * signatures from viem accounts.
 *
 * `FakeUsdgChain` implements enough of USDG's EIP-3009 facet to be honest:
 * balances move, the nonce mapping flips, a replayed authorization reverts,
 * and the transaction emits the real `Transfer` and `AuthorizationUsed` logs
 * with correctly encoded topics, so `hood-pay/verify` decodes them exactly as
 * it would on mainnet.
 */

import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  parseAbi,
  toHex as viemToHex,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'

import { TRANSFER_WITH_AUTHORIZATION_TYPE, usdgDomain } from '../src/core/eip712.js'
import { ROBINHOOD_TESTNET, type HoodPayNetwork } from '../src/core/networks.js'
import type { AuthorizationWire, SignedAuthorization } from '../src/core/types.js'

const eventsAbi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
])

export interface FakeLog {
  address: Address
  topics: string[]
  data: Hex
}

interface FakeTx {
  status: 'success' | 'reverted'
  to: Address | null
  blockNumber: bigint
  logs: FakeLog[]
}

/** A minimal, honest USDG implementation for tests. */
export class FakeUsdgChain {
  readonly net: HoodPayNetwork
  readonly balances = new Map<string, bigint>()
  readonly used = new Set<string>()
  readonly transactions = new Map<Hex, FakeTx>()
  /** Every `transferWithAuthorization` call, in order. */
  readonly calls: Array<{ from: Address; to: Address; value: bigint; nonce: Hex }> = []
  private block = 1_000n
  /** Set to make the next broadcast throw, simulating an RPC failure. */
  failNextBroadcast: string | null = null
  /** Set to make the next transaction revert on-chain. */
  revertNext = false

  constructor(net: HoodPayNetwork = ROBINHOOD_TESTNET) {
    this.net = net
  }

  credit(address: Address, amount: bigint): void {
    this.balances.set(address.toLowerCase(), (this.balances.get(address.toLowerCase()) ?? 0n) + amount)
  }

  balanceOf(address: Address): bigint {
    return this.balances.get(address.toLowerCase()) ?? 0n
  }

  private nonceKey(authorizer: Address, nonce: Hex): string {
    return `${authorizer.toLowerCase()}:${nonce.toLowerCase()}`
  }

  authorizationState(authorizer: Address, nonce: Hex): boolean {
    return this.used.has(this.nonceKey(authorizer, nonce))
  }

  /** The read half of a viem `PublicClient`, as the relay and verifier use it. */
  get reader() {
    return {
      readContract: async (args: {
        address: Address
        functionName: string
        args?: readonly unknown[]
      }): Promise<unknown> => {
        if (getAddress(args.address) !== getAddress(this.net.usdg)) {
          throw new Error(`unexpected contract ${args.address}`)
        }
        const params = args.args ?? []
        if (args.functionName === 'authorizationState') {
          return this.authorizationState(params[0] as Address, params[1] as Hex)
        }
        if (args.functionName === 'balanceOf') return this.balanceOf(params[0] as Address)
        if (args.functionName === 'decimals') return 6
        throw new Error(`unexpected read ${args.functionName}`)
      },
      waitForTransactionReceipt: async (args: { hash: Hex }) => {
        const tx = this.transactions.get(args.hash)
        if (!tx) throw new Error(`unknown transaction ${args.hash}`)
        return {
          status: tx.status,
          transactionHash: args.hash,
          blockNumber: tx.blockNumber,
        }
      },
      getTransactionReceipt: async (args: { hash: Hex }) => {
        const tx = this.transactions.get(args.hash)
        if (!tx) throw new Error(`transaction ${args.hash} not found`)
        return { status: tx.status, to: tx.to, blockNumber: tx.blockNumber, logs: tx.logs }
      },
    }
  }

  /** The write half of a viem `WalletClient`. */
  get writer() {
    return {
      writeContract: async (args: {
        address: Address
        functionName: string
        args: readonly unknown[]
      }): Promise<Hex> => {
        if (this.failNextBroadcast) {
          const message = this.failNextBroadcast
          this.failNextBroadcast = null
          throw new Error(message)
        }
        if (args.functionName !== 'transferWithAuthorization') {
          throw new Error(`unexpected write ${args.functionName}`)
        }
        const [from, to, value, , , nonce] = args.args as [
          Address,
          Address,
          bigint,
          bigint,
          bigint,
          Hex,
        ]
        this.calls.push({ from, to, value, nonce })

        this.block += 1n
        const hash = keccak256(viemToHex(`${from}${to}${value}${nonce}${this.block}`)) as Hex

        const replayed = this.authorizationState(from, nonce)
        const broke = this.revertNext
        this.revertNext = false
        const underfunded = this.balanceOf(from) < value

        if (replayed || broke || underfunded) {
          this.transactions.set(hash, {
            status: 'reverted',
            to: this.net.usdg,
            blockNumber: this.block,
            logs: [],
          })
          return hash
        }

        this.balances.set(from.toLowerCase(), this.balanceOf(from) - value)
        this.balances.set(to.toLowerCase(), this.balanceOf(to) + value)
        this.used.add(this.nonceKey(from, nonce))

        this.transactions.set(hash, {
          status: 'success',
          to: this.net.usdg,
          blockNumber: this.block,
          logs: [
            {
              address: this.net.usdg,
              topics: encodeEventTopics({
                abi: eventsAbi,
                eventName: 'Transfer',
                args: { from, to },
              }) as string[],
              data: encodeAbiParameters([{ type: 'uint256' }], [value]),
            },
            {
              address: this.net.usdg,
              topics: encodeEventTopics({
                abi: eventsAbi,
                eventName: 'AuthorizationUsed',
                args: { authorizer: from, nonce },
              }) as string[],
              data: '0x',
            },
          ],
        })
        return hash
      },
    }
  }
}

/** A deterministic funded test account. */
export function testAccount(index = 1): PrivateKeyAccount {
  const key = `0x${index.toString(16).padStart(64, '0')}` as Hex
  return privateKeyToAccount(key)
}

/** Sign an authorization exactly as a wallet would. */
export async function signAuthorization(
  account: PrivateKeyAccount,
  net: HoodPayNetwork,
  authorization: AuthorizationWire,
): Promise<SignedAuthorization> {
  const signature = await account.signTypedData({
    domain: usdgDomain(net),
    types: { TransferWithAuthorization: [...TRANSFER_WITH_AUTHORIZATION_TYPE] },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  })
  return { authorization, signature }
}

/**
 * An EIP-1193 provider backed by a local account: it answers
 * `eth_requestAccounts`, `eth_chainId`, and `eth_signTypedData_v4` the way a
 * real wallet does, and can be told to reject like a customer dismissing the
 * popup.
 */
export class FakeWalletProvider {
  rejectNextSignature = false
  chainId: number
  readonly switchCalls: number[] = []

  constructor(
    private readonly account: PrivateKeyAccount,
    chainId: number,
    /** When false, `wallet_switchEthereumChain` reports an unknown chain. */
    private readonly knowsChain = true,
  ) {
    this.chainId = chainId
  }

  async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    switch (args.method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [this.account.address]
      case 'eth_chainId':
        return `0x${this.chainId.toString(16)}`
      case 'wallet_switchEthereumChain': {
        const target = (args.params?.[0] as { chainId: string }).chainId
        this.switchCalls.push(Number.parseInt(target, 16))
        if (!this.knowsChain) throw Object.assign(new Error('Unrecognized chain'), { code: 4902 })
        this.chainId = Number.parseInt(target, 16)
        return null
      }
      case 'wallet_addEthereumChain': {
        const target = (args.params?.[0] as { chainId: string }).chainId
        this.chainId = Number.parseInt(target, 16)
        return null
      }
      case 'eth_signTypedData_v4': {
        if (this.rejectNextSignature) {
          this.rejectNextSignature = false
          throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
        }
        const typed = JSON.parse(args.params?.[1] as string) as {
          domain: { name: string; version: string; chainId: number; verifyingContract: Address }
          message: Record<string, string>
        }
        return this.account.signTypedData({
          domain: {
            name: typed.domain.name,
            version: typed.domain.version,
            chainId: typed.domain.chainId,
            verifyingContract: typed.domain.verifyingContract,
          },
          types: { TransferWithAuthorization: [...TRANSFER_WITH_AUTHORIZATION_TYPE] },
          primaryType: 'TransferWithAuthorization',
          message: {
            from: typed.message['from'] as Address,
            to: typed.message['to'] as Address,
            value: BigInt(typed.message['value'] as string),
            validAfter: BigInt(typed.message['validAfter'] as string),
            validBefore: BigInt(typed.message['validBefore'] as string),
            nonce: typed.message['nonce'] as Hex,
          },
        })
      }
      default:
        throw new Error(`unexpected wallet method ${args.method}`)
    }
  }
}
