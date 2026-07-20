/**
 * The widget's presentation logic, separated from the DOM.
 *
 * Every state the checkout can reach maps to exactly one view model here:
 * a status label, a customer-facing message, a button label, whether the
 * button is interactive, and a tone the stylesheet colours from. Keeping this
 * pure means the states can be tested without a browser, and it makes an
 * undesigned state impossible to ship: adding a `CheckoutState` without adding
 * its row here fails the type check.
 */

import { displayUsdg } from '../core/amount.js'
import type { CheckoutSnapshot, CheckoutState } from '../client/index.js'

/** Colour family the stylesheet applies. */
export type StateTone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger'

export interface StateView {
  state: CheckoutState
  /** Short status label, shown next to the status dot. */
  label: string
  /** Longer explanation, shown under the amount. */
  message: string
  /** Text on the primary button. */
  actionLabel: string
  /** Whether the primary button can be pressed. */
  actionEnabled: boolean
  /** What pressing the button does now. */
  action: 'pay' | 'retry' | 'close' | 'none'
  tone: StateTone
  /** Whether to show a busy indicator. */
  busy: boolean
}

interface StateSpec {
  label: string
  tone: StateTone
  action: StateView['action']
  actionLabel?: string
  actionEnabled: boolean
  busy: boolean
}

/**
 * One row per state. `Record<CheckoutState, ...>` is load-bearing: the compiler
 * rejects a new state that has no design.
 */
const SPECS: Record<CheckoutState, StateSpec> = {
  loading: {
    label: 'Loading',
    tone: 'neutral',
    action: 'none',
    actionLabel: 'Loading',
    actionEnabled: false,
    busy: true,
  },
  idle: { label: 'Ready to pay', tone: 'neutral', action: 'pay', actionEnabled: true, busy: false },
  'wallet-missing': {
    label: 'No wallet detected',
    tone: 'warning',
    action: 'none',
    actionLabel: 'No wallet found',
    actionEnabled: false,
    busy: false,
  },
  'wrong-chain': {
    label: 'Wrong network',
    tone: 'warning',
    action: 'retry',
    actionLabel: 'Switch network and pay',
    actionEnabled: true,
    busy: false,
  },
  'insufficient-usdg': {
    label: 'Not enough USDG',
    tone: 'danger',
    action: 'retry',
    actionLabel: 'Try again',
    actionEnabled: true,
    busy: false,
  },
  'awaiting-signature': {
    label: 'Waiting for your wallet',
    tone: 'progress',
    action: 'none',
    actionLabel: 'Check your wallet',
    actionEnabled: false,
    busy: true,
  },
  relaying: {
    label: 'Settling on-chain',
    tone: 'progress',
    action: 'none',
    actionLabel: 'Settling',
    actionEnabled: false,
    busy: true,
  },
  settled: {
    label: 'Payment complete',
    tone: 'success',
    action: 'close',
    actionLabel: 'Done',
    actionEnabled: true,
    busy: false,
  },
  failed: {
    label: 'Payment failed',
    tone: 'danger',
    action: 'retry',
    actionLabel: 'Try again',
    actionEnabled: true,
    busy: false,
  },
  expired: {
    label: 'Link expired',
    tone: 'neutral',
    action: 'close',
    actionLabel: 'Close',
    actionEnabled: true,
    busy: false,
  },
  canceled: {
    label: 'Payment canceled',
    tone: 'neutral',
    action: 'close',
    actionLabel: 'Close',
    actionEnabled: true,
    busy: false,
  },
}

/** Format the intent amount for a button label, e.g. `Pay 12.50 USDG`. */
export function payLabel(snapshot: CheckoutSnapshot): string {
  const amount = snapshot.session?.intent.amount
  if (!amount) return 'Pay with USDG'
  return `Pay ${displayUsdg(BigInt(amount))} USDG`
}

/** Derive the complete view model for a snapshot. */
export function describeState(snapshot: CheckoutSnapshot): StateView {
  const spec = SPECS[snapshot.state]
  return {
    state: snapshot.state,
    label: spec.label,
    message: snapshot.message,
    actionLabel: spec.action === 'pay' ? payLabel(snapshot) : (spec.actionLabel ?? spec.label),
    actionEnabled: spec.actionEnabled,
    action: spec.action,
    tone: spec.tone,
    busy: spec.busy,
  }
}

/** The explorer link to show for a settled payment, when there is one. */
export function explorerLink(snapshot: CheckoutSnapshot): string | undefined {
  return snapshot.result?.explorerTxUrl ?? snapshot.session?.explorerTxUrl
}

/** A short, quotable receipt fingerprint for the success state. */
export function receiptFingerprint(snapshot: CheckoutSnapshot): string | undefined {
  const digest = snapshot.result?.receipt?.digest ?? snapshot.session?.receipt?.digest
  return digest ? `${digest.slice(0, 18)}...` : undefined
}
