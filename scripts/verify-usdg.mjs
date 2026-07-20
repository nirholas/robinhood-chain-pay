#!/usr/bin/env node
/**
 * Reproduce hood-pay's load-bearing claim against the live chain:
 *
 *   npm run verify:usdg
 *
 * USDG is a facet/diamond stablecoin, so the way to ask "does it implement
 * EIP-3009" is `getFacet(bytes4)`: a registered selector resolves to a facet
 * address, an unregistered one resolves to the zero address. The script probes
 * a deliberately nonsensical selector as a negative control, so a run that
 * reports everything as registered is visibly wrong rather than quietly wrong.
 *
 * It then reconstructs the EIP-712 domain separator offline and compares it to
 * the contract's own `DOMAIN_SEPARATOR()`. If those match, the message
 * hood-pay asks a customer to sign is exactly the message the token will
 * verify.
 *
 * Exits non-zero if any assertion fails.
 */

import { createPublicClient, domainSeparator, http, parseAbi } from 'viem'

const NETWORKS = [
  {
    id: 'robinhood',
    chainId: 4663,
    rpcUrl: process.env.HOOD_PAY_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com',
    usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  },
  {
    id: 'robinhood-testnet',
    chainId: 46630,
    rpcUrl: process.env.HOOD_PAY_TESTNET_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com',
    usdg: '0x7E955252E15c84f5768B83c41a71F9eba181802F',
  },
]

const abi = parseAbi([
  'function getFacet(bytes4) view returns (address)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function decimals() view returns (uint8)',
])

/** Selectors hood-pay depends on, plus a negative control. */
const SELECTORS = [
  { name: 'transferWithAuthorization', selector: '0xe3ee160e', required: true },
  { name: 'receiveWithAuthorization', selector: '0xef55bec6', required: true },
  { name: 'authorizationState', selector: '0xe94a0102', required: true },
  { name: 'permit (EIP-2612)', selector: '0xd505accf', required: false },
  { name: 'nonces (EIP-2612)', selector: '0x7ecebe00', required: false },
  { name: 'CONTROL: not a real function', selector: '0xdeadbeef', required: false, control: true },
]

const ZERO = '0x0000000000000000000000000000000000000000'

async function checkNetwork(net) {
  console.log('')
  console.log(`${net.id} (chain ${net.chainId})  USDG ${net.usdg}`)

  const client = createPublicClient({ transport: http(net.rpcUrl) })
  let ok = true

  for (const entry of SELECTORS) {
    let facet
    try {
      facet = await client.readContract({
        address: net.usdg,
        abi,
        functionName: 'getFacet',
        args: [entry.selector],
      })
    } catch (err) {
      console.log(`  getFacet(${entry.selector})  ${entry.name.padEnd(30)} ERROR ${err.shortMessage ?? err.message}`)
      ok = false
      continue
    }

    const registered = facet !== ZERO
    const label = registered ? facet : 'not registered'
    let verdict = ''
    if (entry.control) {
      // The control MUST be unregistered, otherwise getFacet tells us nothing.
      verdict = registered ? '  [FAIL: control selector resolved]' : '  [OK: control is unregistered]'
      if (registered) ok = false
    } else if (entry.required) {
      verdict = registered ? '  [OK]' : '  [FAIL: required by hood-pay]'
      if (!registered) ok = false
    } else {
      verdict = registered ? '  [present]' : '  [absent]'
    }
    console.log(`  getFacet(${entry.selector})  ${entry.name.padEnd(30)} ${label}${verdict}`)
  }

  const live = await client.readContract({ address: net.usdg, abi, functionName: 'DOMAIN_SEPARATOR' })
  const reconstructed = domainSeparator({
    domain: {
      name: 'Global Dollar',
      version: '1',
      chainId: net.chainId,
      verifyingContract: net.usdg,
    },
  })
  const matches = live === reconstructed
  console.log(`  DOMAIN_SEPARATOR() live       ${live}`)
  console.log(`  reconstructed offline         ${reconstructed}`)
  console.log(`  name="Global Dollar" version="1"  ${matches ? '[OK: match]' : '[FAIL: mismatch]'}`)
  if (!matches) ok = false

  const decimals = await client.readContract({ address: net.usdg, abi, functionName: 'decimals' })
  const decimalsOk = Number(decimals) === 6
  console.log(`  decimals()                    ${decimals}${decimalsOk ? '  [OK]' : '  [FAIL: expected 6]'}`)
  if (!decimalsOk) ok = false

  return ok
}

async function main() {
  console.log('hood-pay: verifying USDG EIP-3009 support on Robinhood Chain')
  const results = []
  for (const net of NETWORKS) results.push(await checkNetwork(net))

  console.log('')
  if (results.every(Boolean)) {
    console.log('PASS: USDG exposes EIP-3009 and the EIP-712 domain reconstructs on every network.')
    console.log('      Gasless checkout is settleable as specified.')
    process.exit(0)
  }
  console.log('FAIL: at least one assertion did not hold. hood-pay must not be used against this deployment.')
  process.exit(1)
}

main().catch((err) => {
  console.error(`hood-pay verify:usdg failed: ${err.message}`)
  process.exit(1)
})
