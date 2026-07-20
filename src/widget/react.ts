/**
 * `hood-pay/widget/react`: a React wrapper around `<hood-pay-button>`.
 *
 * React 18 and earlier do not attach `on*` props to custom elements as event
 * listeners, and they stringify non-primitive props onto attributes. This
 * wrapper handles both: it registers real listeners on the element and keeps
 * the attributes in sync, so `onSettled` and friends behave like ordinary
 * React callbacks.
 *
 * Written with `createElement` rather than JSX so the package needs no JSX
 * build configuration and no `react/jsx-runtime` at any consumer's bundler.
 *
 * ```tsx
 * import { HoodPayButton } from 'hood-pay/widget/react'
 *
 * <HoodPayButton
 *   intentId={intentId}
 *   apiBase="https://shop.example.com"
 *   onSettled={({ receipt }) => confirmOrder(receipt)}
 * />
 * ```
 */

import { createElement, useEffect, useRef, type CSSProperties, type ReactElement } from 'react'

import { defineHoodPayButton, TAG_NAME, type HoodPayButtonElement } from './element.js'
import type { CheckoutSnapshot, CheckoutState } from '../client/index.js'
import type { PaymentIntentWire, PaymentReceiptWire } from '../core/types.js'

export interface SettledDetail {
  intent: PaymentIntentWire
  receipt?: PaymentReceiptWire
  explorerTxUrl?: string
}

export interface StateDetail {
  state: CheckoutState
  snapshot: CheckoutSnapshot
}

export interface ErrorDetail {
  code: string
  message: string
}

export interface HoodPayButtonProps {
  /** The payment intent to pay. */
  intentId: string
  /** Origin of the merchant server. Defaults to the page's origin. */
  apiBase?: string
  /** Text on the trigger button. */
  label?: string
  /** Merchant name shown in the modal. */
  merchantName?: string
  /** Colour scheme. `'auto'` follows the OS setting. */
  theme?: 'auto' | 'light' | 'dark'
  disabled?: boolean
  className?: string
  style?: CSSProperties
  /** Fires on every state transition. */
  onState?: (detail: StateDetail) => void
  /** Fires once the payment has settled on-chain. */
  onSettled?: (detail: SettledDetail) => void
  /** Fires on any customer-visible failure. */
  onError?: (detail: ErrorDetail) => void
  /** Fires when the modal closes. */
  onClose?: (detail: { state: CheckoutState }) => void
}

/** React wrapper for `<hood-pay-button>`. */
export function HoodPayButton(props: HoodPayButtonProps): ReactElement {
  const ref = useRef<HoodPayButtonElement | null>(null)

  // Registering inside an effect keeps this safe under server-side rendering,
  // where `customElements` does not exist.
  useEffect(() => {
    defineHoodPayButton()
  }, [])

  const { onState, onSettled, onError, onClose } = props

  useEffect(() => {
    const element = ref.current
    if (!element) return undefined

    const handlers: Array<[string, EventListener]> = []
    const bind = <T,>(name: string, handler: ((detail: T) => void) | undefined): void => {
      if (!handler) return
      const listener = ((event: Event): void => {
        handler((event as CustomEvent<T>).detail)
      }) as EventListener
      element.addEventListener(name, listener)
      handlers.push([name, listener])
    }

    bind<StateDetail>('hood-pay:state', onState)
    bind<SettledDetail>('hood-pay:settled', onSettled)
    bind<ErrorDetail>('hood-pay:error', onError)
    bind<{ state: CheckoutState }>('hood-pay:close', onClose)

    return () => {
      for (const [name, listener] of handlers) element.removeEventListener(name, listener)
    }
  }, [onState, onSettled, onError, onClose])

  return createElement(TAG_NAME, {
    ref,
    'intent-id': props.intentId,
    ...(props.apiBase !== undefined ? { 'api-base': props.apiBase } : {}),
    ...(props.label !== undefined ? { label: props.label } : {}),
    ...(props.merchantName !== undefined ? { 'merchant-name': props.merchantName } : {}),
    ...(props.theme !== undefined ? { theme: props.theme } : {}),
    ...(props.disabled ? { disabled: '' } : {}),
    ...(props.className !== undefined ? { class: props.className } : {}),
    ...(props.style !== undefined ? { style: props.style } : {}),
  })
}

export default HoodPayButton
