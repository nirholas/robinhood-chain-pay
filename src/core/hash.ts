/**
 * Isomorphic SHA-256 and HMAC-SHA-256 over the Web Crypto API.
 *
 * `globalThis.crypto.subtle` exists in every browser and in Node >= 18, so one
 * implementation covers the browser bundle and the merchant server without a
 * dependency and without a `node:crypto` import that would break the widget
 * build.
 */

import type { Hex } from './networks.js'

const encoder = new TextEncoder()

function subtle(): SubtleCrypto {
  const c = globalThis.crypto
  if (!c?.subtle) {
    throw new Error(
      'hood-pay: Web Crypto is unavailable. Node >= 18 or a secure browser context (https or localhost) is required.',
    )
  }
  return c.subtle
}

/** Lowercase hex encoding of a byte buffer, 0x-prefixed. */
export function toHex(bytes: ArrayBuffer | Uint8Array): Hex {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let out = '0x'
  for (const b of view) out += b.toString(16).padStart(2, '0')
  return out as Hex
}

/** Decode a 0x-prefixed hex string into bytes. Throws on malformed input. */
export function fromHex(hex: string): Uint8Array {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex
  if (body.length % 2 !== 0 || /[^0-9a-fA-F]/.test(body)) {
    throw new Error(`hood-pay: "${hex}" is not valid hex`)
  }
  const out = new Uint8Array(body.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** SHA-256 of a UTF-8 string, as 0x-prefixed hex. */
export async function sha256Hex(input: string): Promise<Hex> {
  const digest = await subtle().digest('SHA-256', encoder.encode(input))
  return toHex(digest)
}

/** HMAC-SHA-256 of `message` under `secret`, as 0x-prefixed hex. */
export async function hmacSha256Hex(secret: string, message: string): Promise<Hex> {
  const key = await subtle().importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await subtle().sign('HMAC', key, encoder.encode(message))
  return toHex(sig)
}

/**
 * Constant-time string comparison. Used for webhook signature checks so a
 * remote attacker cannot recover a signature byte by byte from response
 * timing. Length is compared first, which is not secret (signatures are a
 * fixed width).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** 32 cryptographically random bytes as 0x-prefixed hex. */
export function randomHex32(): Hex {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return toHex(bytes)
}

/** `n` cryptographically random bytes as a lowercase hex string (no 0x). */
export function randomId(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength)
  globalThis.crypto.getRandomValues(bytes)
  return toHex(bytes).slice(2)
}
