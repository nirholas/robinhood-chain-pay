/**
 * `hood-pay/widget`: the embeddable checkout element.
 *
 * Importing this module registers `<hood-pay-button>` automatically, which is
 * why the package marks it as having side effects. Import
 * `hood-pay/widget/react` instead for the React wrapper.
 */

import { defineHoodPayButton } from './element.js'

export { HoodPayButtonElement, TAG_NAME, defineHoodPayButton } from './element.js'
export { WIDGET_STYLES } from './styles.js'
export {
  describeState,
  explorerLink,
  payLabel,
  receiptFingerprint,
  type StateTone,
  type StateView,
} from './view-model.js'

export type { CheckoutSnapshot, CheckoutState } from '../client/index.js'

// Register on import so a plain `<script type="module">` needs no extra call.
defineHoodPayButton()
