/**
 * The framework-agnostic HTTP surface.
 *
 * Both shipped adapters (Express and Hono) are ten-line translations of their
 * framework's request object into {@link HoodPayRequest} and back out of
 * {@link HoodPayResponse}. Keeping every routing and authorization decision
 * here means the two adapters cannot drift, and a third adapter (Fastify, a
 * Worker, a Lambda) is a small amount of glue rather than a reimplementation.
 *
 * Routes:
 *
 * | Method | Path                      | Auth     | Purpose                          |
 * |--------|---------------------------|----------|----------------------------------|
 * | GET    | `/pay/:id`                | public   | Hosted checkout page (HTML)      |
 * | GET    | `/api/intents/:id`        | public   | Checkout session JSON            |
 * | POST   | `/api/intents/:id/pay`    | public   | Submit a signed authorization    |
 * | GET    | `/api/intents/:id/receipt`| public   | The verifiable receipt           |
 * | POST   | `/api/intents`            | merchant | Create an intent / payment link  |
 * | GET    | `/api/intents`            | merchant | List intents                     |
 * | POST   | `/api/intents/:id/cancel` | merchant | Cancel an unpaid intent          |
 * | GET    | `/healthz`                | public   | Liveness                         |
 *
 * The public routes are public on purpose: a customer opening a payment link
 * has no credentials, and the only thing they can do is submit a signature
 * that pays the exact amount the merchant already fixed.
 */

import { HoodPayError, IntentNotFoundError } from '../core/errors.js'
import { serializeIntent } from '../core/intent.js'
import { serializeReceipt } from '../core/receipt.js'
import { timingSafeEqual } from '../core/hash.js'
import type { SignedAuthorization } from '../core/types.js'
import type { HoodPayMerchant, MerchantIntentParams } from './merchant.js'
import { renderCheckoutPage } from './checkout-page.js'

export interface HoodPayRequest {
  method: string
  /** Path only, no query string and no origin. */
  path: string
  headers: Record<string, string | undefined>
  /** Parsed JSON body, or `undefined` for bodyless requests. */
  body?: unknown
}

export interface HoodPayResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export interface RouterOptions {
  merchant: HoodPayMerchant
  /**
   * Bearer token required by the merchant-only routes. When omitted those
   * routes are disabled entirely rather than left open, because an
   * unauthenticated create endpoint lets anyone mint payment links that look
   * like they came from this merchant.
   */
  apiKey?: string
  /** Path prefix the routes are mounted under, e.g. `'/hood-pay'`. */
  basePath?: string
  /** Merchant name shown on the hosted page. */
  merchantName?: string
  /** Origin the hosted page posts to. Defaults to same-origin. */
  apiBase?: string
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  // The page is self-contained: it needs its own inline style and script, and
  // nothing else. Everything not required is denied.
  'content-security-policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
}

function json(status: number, body: unknown): HoodPayResponse {
  return { status, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) }
}

function html(status: number, body: string): HoodPayResponse {
  return { status, headers: { ...HTML_HEADERS }, body }
}

function errorResponse(err: unknown): HoodPayResponse {
  if (err instanceof HoodPayError) {
    const status =
      err.code === 'intent_not_found'
        ? 404
        : err.code === 'idempotency_conflict'
          ? 409
          : err.code === 'config_invalid' && err.details['status'] === 'processing'
            ? 409
            : err.code === 'relay_failed' || err.code === 'settlement_reverted'
              ? 502
              : 400
    return json(status, err.toJSON())
  }
  const message = err instanceof Error ? err.message : 'internal error'
  return json(500, { error: { code: 'network_error', message, details: {} } })
}

/** Read a header case-insensitively. */
function header(req: HoodPayRequest, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() === lower) return value
  }
  return undefined
}

function isAuthorized(req: HoodPayRequest, apiKey: string | undefined): boolean {
  if (!apiKey) return false
  const auth = header(req, 'authorization')
  if (!auth) return false
  const prefix = 'bearer '
  if (auth.slice(0, prefix.length).toLowerCase() !== prefix) return false
  return timingSafeEqual(auth.slice(prefix.length).trim(), apiKey)
}

function unauthorized(reason: string): HoodPayResponse {
  return {
    status: 401,
    headers: { ...JSON_HEADERS, 'www-authenticate': 'Bearer realm="@three-ws/hood-pay"' },
    body: JSON.stringify({ error: { code: 'config_invalid', message: reason, details: {} } }),
  }
}

function notFound(): HoodPayResponse {
  return json(404, { error: { code: 'intent_not_found', message: 'hood-pay: no such route', details: {} } })
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/**
 * Build the request handler. Returns a function from a normalized request to a
 * normalized response, never throwing: every failure becomes a response.
 */
export function createRouter(options: RouterOptions) {
  const { merchant } = options
  const basePath = (options.basePath ?? '').replace(/\/+$/, '')

  function strip(path: string): string | null {
    if (!basePath) return path
    if (path === basePath) return '/'
    if (path.startsWith(`${basePath}/`)) return path.slice(basePath.length)
    return null
  }

  return async function handle(req: HoodPayRequest): Promise<HoodPayResponse> {
    try {
      const path = strip(req.path)
      if (path === null) return notFound()
      const method = req.method.toUpperCase()
      const segments = path.split('/').filter(Boolean)

      if (method === 'GET' && segments[0] === 'healthz' && segments.length === 1) {
        return json(200, {
          ok: true,
          merchantId: merchant.merchantId,
          network: merchant.network.id,
          chainId: merchant.network.chainId,
        })
      }

      // GET /pay/:id
      if (method === 'GET' && segments[0] === 'pay' && segments.length === 2) {
        const id = decodeURIComponent(segments[1] as string)
        const session = await merchant.getCheckoutSession(id)
        return html(
          200,
          renderCheckoutPage({
            session,
            ...(options.apiBase !== undefined ? { apiBase: options.apiBase } : { apiBase: basePath }),
            ...(options.merchantName !== undefined ? { merchantName: options.merchantName } : {}),
          }),
        )
      }

      if (segments[0] !== 'api' || segments[1] !== 'intents') return notFound()

      // POST /api/intents
      if (method === 'POST' && segments.length === 2) {
        if (!isAuthorized(req, options.apiKey)) {
          return unauthorized(
            options.apiKey
              ? 'hood-pay: a valid merchant API key is required to create payment intents'
              : 'hood-pay: no apiKey was configured, so intent creation over HTTP is disabled',
          )
        }
        const body = asRecord(req.body)
        const params = body as unknown as MerchantIntentParams
        if (body['link'] === true) {
          const linkResult = await merchant.createPaymentLink(params)
          return json(201, {
            intent: serializeIntent(linkResult.intent, merchant.now()),
            url: linkResult.url,
          })
        }
        const intent = await merchant.createIntent(params)
        return json(201, { intent: serializeIntent(intent, merchant.now()) })
      }

      // GET /api/intents
      if (method === 'GET' && segments.length === 2) {
        if (!isAuthorized(req, options.apiKey)) {
          return unauthorized('hood-pay: a valid merchant API key is required to list intents')
        }
        const intents = await merchant.store.listIntents({ merchantId: merchant.merchantId })
        return json(200, { intents: intents.map((i) => serializeIntent(i, merchant.now())) })
      }

      const id = segments.length >= 3 ? decodeURIComponent(segments[2] as string) : undefined
      if (!id) return notFound()

      // GET /api/intents/:id
      if (method === 'GET' && segments.length === 3) {
        return json(200, await merchant.getCheckoutSession(id))
      }

      // POST /api/intents/:id/pay
      if (method === 'POST' && segments.length === 4 && segments[3] === 'pay') {
        const body = asRecord(req.body)
        const signature = body['signature']
        const authorization = body['authorization']
        if (typeof signature !== 'string' || !authorization || typeof authorization !== 'object') {
          return json(400, {
            error: {
              code: 'config_invalid',
              message: 'hood-pay: expected a JSON body with `signature` and `authorization`',
              details: {},
            },
          })
        }
        const signed = { signature, authorization } as unknown as SignedAuthorization
        const result = await merchant.pay(id, signed)
        return json(200, {
          intent: serializeIntent(result.intent, merchant.now()),
          ...(result.receipt ? { receipt: serializeReceipt(result.receipt) } : {}),
          ...(result.intent.txHash
            ? { explorerTxUrl: `${merchant.network.explorerUrl}/tx/${result.intent.txHash}` }
            : {}),
        })
      }

      // GET /api/intents/:id/receipt
      if (method === 'GET' && segments.length === 4 && segments[3] === 'receipt') {
        const receipt = await merchant.getReceipt(id)
        if (!receipt) {
          const intent = await merchant.getIntent(id)
          return json(404, {
            error: {
              code: 'intent_not_found',
              message: `hood-pay: intent "${id}" has no receipt yet (status: ${intent.status})`,
              details: { intentId: id, status: intent.status },
            },
          })
        }
        return json(200, { receipt: serializeReceipt(receipt) })
      }

      // POST /api/intents/:id/cancel
      if (method === 'POST' && segments.length === 4 && segments[3] === 'cancel') {
        if (!isAuthorized(req, options.apiKey)) {
          return unauthorized('hood-pay: a valid merchant API key is required to cancel an intent')
        }
        const intent = await merchant.cancel(id)
        return json(200, { intent: serializeIntent(intent, merchant.now()) })
      }

      return notFound()
    } catch (err) {
      if (err instanceof IntentNotFoundError) return errorResponse(err)
      return errorResponse(err)
    }
  }
}

export type HoodPayHandler = ReturnType<typeof createRouter>
