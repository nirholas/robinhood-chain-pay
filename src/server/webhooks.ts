/**
 * Merchant webhooks, signed with HMAC-SHA-256.
 *
 * The signature covers a timestamp **and** the exact request body, joined by a
 * separator that cannot occur in the timestamp. Signing the body alone would
 * let an attacker who captured one delivery replay it forever; including the
 * timestamp and having the receiver enforce a tolerance window bounds that
 * exposure to the window.
 *
 * Header format (one header, comma-separated key=value pairs):
 *
 * ```
 * Hood-Pay-Signature: t=1763558400,v1=0x9f2c...
 * ```
 *
 * The signed string is `${t}.${rawBody}`. Verify against the **raw** body
 * bytes, never against a re-serialized object: `JSON.parse` followed by
 * `JSON.stringify` is not guaranteed to reproduce the same bytes, and a
 * verifier that re-serializes will reject valid deliveries.
 */

import { hmacSha256Hex, randomId, timingSafeEqual } from '../core/hash.js'
import { HoodPayError } from '../core/errors.js'
import type { WebhookEvent } from '../core/types.js'

/** The header carrying the signature and timestamp. */
export const SIGNATURE_HEADER = 'Hood-Pay-Signature'
/** The header carrying the event id, useful for receiver-side deduplication. */
export const EVENT_ID_HEADER = 'Hood-Pay-Event-Id'
/** Default replay tolerance in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 300

/** The signature scheme version. Bumped only if the signed string changes. */
export const SIGNATURE_SCHEME = 'v1' as const

/** Build the `Hood-Pay-Signature` header value for a raw body. */
export async function signWebhook(
  secret: string,
  rawBody: string,
  timestamp: number,
): Promise<string> {
  if (!secret) {
    throw new HoodPayError('config_invalid', 'hood-pay: a webhook secret is required to sign events')
  }
  const mac = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`)
  return `t=${timestamp},${SIGNATURE_SCHEME}=${mac}`
}

export interface VerifyWebhookOptions {
  /** The shared secret configured on both sides. */
  secret: string
  /** The exact bytes of the request body, as received. */
  rawBody: string
  /** The `Hood-Pay-Signature` header value. */
  signature: string
  /** Unix seconds. Defaults to now. */
  now?: number
  /** Replay window in seconds. Defaults to {@link DEFAULT_TOLERANCE_SECONDS}. */
  toleranceSeconds?: number
}

/** Parse a signature header into its parts. Returns `null` when malformed. */
export function parseSignatureHeader(
  header: string,
): { timestamp: number; mac: string } | null {
  const parts = header.split(',').map((p) => p.trim())
  let timestamp: number | undefined
  let mac: string | undefined
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq)
    const value = part.slice(eq + 1)
    if (key === 't') {
      const parsed = Number(value)
      if (Number.isInteger(parsed) && parsed > 0) timestamp = parsed
    } else if (key === SIGNATURE_SCHEME) {
      mac = value
    }
  }
  if (timestamp === undefined || mac === undefined) return null
  return { timestamp, mac }
}

/**
 * Verify a webhook signature. Returns `true` only when the MAC matches **and**
 * the timestamp is inside the tolerance window in both directions (a future
 * timestamp is as suspicious as an ancient one).
 */
export async function verifyWebhookSignature(options: VerifyWebhookOptions): Promise<boolean> {
  const { secret, rawBody, signature } = options
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS

  const parsed = parseSignatureHeader(signature)
  if (!parsed) return false
  if (Math.abs(now - parsed.timestamp) > tolerance) return false

  const expected = await hmacSha256Hex(secret, `${parsed.timestamp}.${rawBody}`)
  return timingSafeEqual(expected.toLowerCase(), parsed.mac.toLowerCase())
}

/** Verify and parse in one step, throwing a typed error on failure. */
export async function constructWebhookEvent(options: VerifyWebhookOptions): Promise<WebhookEvent> {
  const ok = await verifyWebhookSignature(options)
  if (!ok) {
    throw new HoodPayError(
      'webhook_signature_invalid',
      'hood-pay: webhook signature is invalid, expired, or malformed',
    )
  }
  return JSON.parse(options.rawBody) as WebhookEvent
}

export interface WebhookDispatchOptions {
  url: string
  secret: string
  event: WebhookEvent
  /** Total attempts including the first. Defaults to 3. */
  maxAttempts?: number
  /** Base delay in ms for exponential backoff. Defaults to 250. */
  retryBaseMs?: number
  /** Per-attempt timeout in ms. Defaults to 10000. */
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** Injectable sleep, so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface WebhookDispatchResult {
  delivered: boolean
  status: number | null
  attempts: number
  error: string | null
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Deliver one event with bounded exponential-backoff retries.
 *
 * A 2xx is a delivery. A 4xx other than 408/429 is a permanent rejection and
 * is not retried: the receiver understood the request and refused it, and
 * hammering it will not change that. 408, 429, 5xx, and transport errors are
 * retried.
 */
export async function dispatchWebhook(
  options: WebhookDispatchOptions,
): Promise<WebhookDispatchResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? ((): number => Math.floor(Date.now() / 1000))
  const maxAttempts = options.maxAttempts ?? 3
  const retryBaseMs = options.retryBaseMs ?? 250
  const timeoutMs = options.timeoutMs ?? 10_000

  const rawBody = JSON.stringify(options.event)
  let lastStatus: number | null = null
  let lastError: string | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const timestamp = now()
    const signature = await signWebhook(options.secret, rawBody, timestamp)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: signature,
          [EVENT_ID_HEADER]: options.event.id,
          'user-agent': 'hood-pay-webhooks/1',
        },
        body: rawBody,
        signal: controller.signal,
      })
      lastStatus = res.status
      if (res.ok) return { delivered: true, status: res.status, attempts: attempt, error: null }
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429
      lastError = `hood-pay: webhook endpoint responded ${res.status}`
      if (permanent) return { delivered: false, status: res.status, attempts: attempt, error: lastError }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    } finally {
      clearTimeout(timer)
    }
    if (attempt < maxAttempts) await sleep(retryBaseMs * 2 ** (attempt - 1))
  }

  return { delivered: false, status: lastStatus, attempts: maxAttempts, error: lastError }
}

/** Create a fresh event envelope. */
export function buildEvent(
  type: WebhookEvent['type'],
  data: WebhookEvent['data'],
  now = Math.floor(Date.now() / 1000),
): WebhookEvent {
  return { object: 'event', id: `evt_${randomId(16)}`, type, created: now, data }
}
