/**
 * Express and Hono adapters.
 *
 * Both are translations of a framework request into {@link HoodPayRequest} and
 * of a {@link HoodPayResponse} back out. All routing, authorization, and error
 * mapping lives in `router.ts`, so the two adapters have nothing to disagree
 * about.
 *
 * The framework types are declared structurally rather than imported, so
 * `hood-pay` does not depend on Express or Hono and a merchant installs only
 * the one they actually use.
 */

import { createRouter, type HoodPayRequest, type RouterOptions } from './router.js'

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------

interface ExpressRequestLike {
  method: string
  path?: string
  originalUrl?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
}

interface ExpressResponseLike {
  status(code: number): ExpressResponseLike
  set(name: string, value: string): ExpressResponseLike
  send(body: string): unknown
}

type ExpressNextLike = (err?: unknown) => void

function flattenHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

function pathOf(req: ExpressRequestLike): string {
  const raw = req.path ?? req.originalUrl ?? req.url ?? '/'
  const q = raw.indexOf('?')
  return q >= 0 ? raw.slice(0, q) : raw
}

/**
 * Express middleware serving the whole hood-pay surface.
 *
 * Mount it before your own routes and give it `express.json()` upstream, since
 * the pay endpoint takes a JSON body.
 *
 * ```ts
 * app.use(express.json())
 * app.use(expressHoodPay({ merchant, apiKey: process.env.HOOD_PAY_API_KEY }))
 * ```
 *
 * Requests that do not match a hood-pay route fall through to `next()`, so it
 * composes with an existing application instead of taking over its router.
 */
export function expressHoodPay(options: RouterOptions) {
  const handle = createRouter(options)
  return async (
    req: ExpressRequestLike,
    res: ExpressResponseLike,
    next: ExpressNextLike,
  ): Promise<void> => {
    try {
      const request: HoodPayRequest = {
        method: req.method,
        path: pathOf(req),
        headers: flattenHeaders(req.headers),
        ...(req.body !== undefined ? { body: req.body } : {}),
      }
      const response = await handle(request)
      // A 404 from the router means "not a hood-pay route", so hand the
      // request back to the host application rather than ending it.
      if (response.status === 404 && !isKnownPrefix(request.path, options.basePath)) {
        next()
        return
      }
      res.status(response.status)
      for (const [name, value] of Object.entries(response.headers)) res.set(name, value)
      res.send(response.body)
    } catch (err) {
      next(err)
    }
  }
}

function isKnownPrefix(path: string, basePath?: string): boolean {
  const base = (basePath ?? '').replace(/\/+$/, '')
  const rest = base && path.startsWith(base) ? path.slice(base.length) : path
  return rest.startsWith('/pay/') || rest.startsWith('/api/intents') || rest === '/healthz'
}

// ---------------------------------------------------------------------------
// Hono
// ---------------------------------------------------------------------------

interface HonoContextLike {
  req: {
    method: string
    path: string
    url: string
    header(name?: string): string | undefined | Record<string, string>
    json<T = unknown>(): Promise<T>
  }
  body(data: string, status?: number, headers?: Record<string, string>): Response
}

type HonoNextLike = () => Promise<void>

/**
 * Hono middleware with the same semantics as the Express adapter.
 *
 * ```ts
 * const app = new Hono()
 * app.use('*', honoHoodPay({ merchant, apiKey: process.env.HOOD_PAY_API_KEY }))
 * ```
 */
export function honoHoodPay(options: RouterOptions) {
  const handle = createRouter(options)
  return async (c: HonoContextLike, next: HonoNextLike): Promise<Response | void> => {
    const path = c.req.path
    if (!isKnownPrefix(path, options.basePath)) {
      await next()
      return
    }

    let body: unknown
    if (c.req.method.toUpperCase() === 'POST') {
      try {
        body = await c.req.json()
      } catch {
        body = {}
      }
    }

    const rawHeaders = c.req.header()
    const headers: Record<string, string | undefined> =
      rawHeaders && typeof rawHeaders === 'object' ? { ...(rawHeaders as Record<string, string>) } : {}

    const response = await handle({
      method: c.req.method,
      path,
      headers,
      ...(body !== undefined ? { body } : {}),
    })
    return c.body(response.body, response.status, response.headers)
  }
}
