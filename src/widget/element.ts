/**
 * `<hood-pay-button>`: the embeddable checkout widget.
 *
 * ```html
 * <script src="https://unpkg.com/@three-ws/hood-pay/dist/browser/hood-pay.iife.js"></script>
 * <hood-pay-button intent-id="pi_2f1c..." api-base="https://shop.example.com"></hood-pay-button>
 * ```
 *
 * One script tag and one element. The widget renders a button; pressing it
 * opens a modal that runs the whole payment in the top-level window, because a
 * cross-origin iframe cannot reach the customer's wallet.
 *
 * Everything is inside a shadow root, so the merchant's CSS cannot break it
 * and it cannot break the merchant's CSS. Branding crosses the boundary
 * through four custom properties (see `styles.ts`).
 *
 * Events (all `CustomEvent`, bubbling and composed):
 *   `hood-pay:state`    detail: { state, snapshot }
 *   `hood-pay:settled`  detail: { intent, receipt, explorerTxUrl }
 *   `hood-pay:error`    detail: { code, message }
 *   `hood-pay:close`    detail: { state }
 */

import { displayUsdg } from '../core/amount.js'
import { HoodPayCheckout, type CheckoutSnapshot } from '../client/index.js'
import type { DiscoveredWallet } from '../client/provider.js'
import { WIDGET_STYLES } from './styles.js'
import { describeState, explorerLink, receiptFingerprint } from './view-model.js'

/** The element's tag name. */
export const TAG_NAME = 'hood-pay-button'

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'

export class HoodPayButtonElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['intent-id', 'api-base', 'label', 'merchant-name', 'theme', 'disabled']
  }

  private readonly root: ShadowRoot
  private trigger!: HTMLButtonElement
  private scrim: HTMLDivElement | null = null
  private checkout: HoodPayCheckout | null = null
  private snapshot: CheckoutSnapshot | null = null
  private lastFocused: Element | null = null
  private readonly onKeyDown: (event: KeyboardEvent) => void

  constructor() {
    super()
    this.root = this.attachShadow({ mode: 'open' })
    this.onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        this.close()
        return
      }
      if (event.key === 'Tab') this.trapFocus(event)
    }
  }

  connectedCallback(): void {
    this.render()
  }

  disconnectedCallback(): void {
    this.teardownDialog()
  }

  attributeChangedCallback(name: string): void {
    if (!this.trigger) return
    if (name === 'label' || name === 'disabled') this.syncTrigger()
    if (name === 'intent-id' || name === 'api-base') {
      this.checkout = null
      this.snapshot = null
    }
  }

  /** The intent this widget pays. */
  get intentId(): string {
    return this.getAttribute('intent-id') ?? ''
  }
  set intentId(value: string) {
    this.setAttribute('intent-id', value)
  }

  /** Origin of the merchant server. Defaults to the current origin. */
  get apiBase(): string | null {
    return this.getAttribute('api-base')
  }
  set apiBase(value: string | null) {
    if (value === null) this.removeAttribute('api-base')
    else this.setAttribute('api-base', value)
  }

  private render(): void {
    this.root.innerHTML = ''
    const style = document.createElement('style')
    style.textContent = WIDGET_STYLES
    this.root.appendChild(style)

    this.trigger = document.createElement('button')
    this.trigger.className = 'trigger'
    this.trigger.type = 'button'
    this.trigger.addEventListener('click', () => {
      void this.open()
    })
    this.syncTrigger()
    this.root.appendChild(this.trigger)
  }

  private syncTrigger(): void {
    this.trigger.textContent = this.getAttribute('label') ?? 'Pay with USDG'
    this.trigger.disabled = this.hasAttribute('disabled')
  }

  private emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }))
  }

  /** Open the checkout modal and load the session. */
  async open(): Promise<void> {
    if (!this.intentId) {
      this.emit('hood-pay:error', {
        code: 'config_invalid',
        message: 'hood-pay: <hood-pay-button> requires an `intent-id` attribute',
      })
      return
    }
    if (this.scrim) return

    this.lastFocused = document.activeElement
    this.buildDialog()

    const apiBase = this.apiBase
    this.checkout = new HoodPayCheckout({
      intentId: this.intentId,
      ...(apiBase !== null ? { apiBase } : {}),
      onChange: (snapshot) => this.onSnapshot(snapshot),
    })
    await this.checkout.load()
  }

  /** Close the modal and return focus to whatever opened it. */
  close(): void {
    const state = this.snapshot?.state ?? 'idle'
    this.teardownDialog()
    this.emit('hood-pay:close', { state })
    if (this.lastFocused instanceof HTMLElement) this.lastFocused.focus()
  }

  private teardownDialog(): void {
    if (!this.scrim) return
    document.removeEventListener('keydown', this.onKeyDown, true)
    this.scrim.remove()
    this.scrim = null
  }

  private buildDialog(): void {
    const scrim = document.createElement('div')
    scrim.className = 'scrim'
    scrim.addEventListener('click', (event) => {
      // Only a click on the backdrop itself closes, never one that started on
      // the dialog and ended outside it.
      if (event.target === scrim && !this.isBusy()) this.close()
    })

    const dialog = document.createElement('div')
    dialog.className = 'dialog'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-labelledby', 'hp-amount')
    dialog.setAttribute('aria-describedby', 'hp-message')
    dialog.innerHTML = `
      <button class="close" type="button" aria-label="Close checkout">&#215;</button>
      <p class="merchant" id="hp-merchant"></p>
      <p class="amount" id="hp-amount">&nbsp;</p>
      <p class="description" id="hp-description" hidden></p>
      <div class="status" role="status" aria-live="polite">
        <span class="dot" id="hp-dot" aria-hidden="true"></span><span id="hp-label">Loading</span>
      </div>
      <p class="message" id="hp-message">Loading payment details.</p>
      <div class="wallets" id="hp-wallets" role="group" aria-label="Choose a wallet" hidden></div>
      <button class="action" id="hp-action" type="button" disabled>Loading</button>
      <div class="detail" id="hp-detail"></div>
      <div class="foot"><span id="hp-network"></span><span>Gasless via EIP-3009</span></div>
    `
    scrim.appendChild(dialog)
    this.root.appendChild(scrim)
    this.scrim = scrim

    dialog.querySelector<HTMLButtonElement>('.close')?.addEventListener('click', () => this.close())
    dialog.querySelector<HTMLButtonElement>('#hp-action')?.addEventListener('click', () => {
      void this.onAction()
    })

    document.addEventListener('keydown', this.onKeyDown, true)
    dialog.querySelector<HTMLButtonElement>('#hp-action')?.focus()
  }

  private isBusy(): boolean {
    const state = this.snapshot?.state
    return state === 'awaiting-signature' || state === 'relaying'
  }

  private trapFocus(event: KeyboardEvent): void {
    const dialog = this.scrim?.querySelector('.dialog')
    if (!dialog) return
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    )
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!first || !last) return

    const active = this.root.activeElement
    if (event.shiftKey && active === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  private async onAction(): Promise<void> {
    if (!this.checkout || !this.snapshot) return
    const view = describeState(this.snapshot)
    if (view.action === 'close') {
      this.close()
      return
    }
    if (view.action === 'pay' || view.action === 'retry') {
      try {
        await this.checkout.pay()
      } catch {
        // `onChange` has already moved the widget into the failure state and
        // an error event is emitted from `onSnapshot`. Nothing to add here,
        // and rethrowing would surface an unhandled rejection from a click.
      }
    }
  }

  private onSnapshot(snapshot: CheckoutSnapshot): void {
    this.snapshot = snapshot
    this.emit('hood-pay:state', { state: snapshot.state, snapshot })
    if (snapshot.state === 'settled' && snapshot.result) {
      this.emit('hood-pay:settled', {
        intent: snapshot.result.intent,
        receipt: snapshot.result.receipt,
        explorerTxUrl: snapshot.result.explorerTxUrl,
      })
    }
    if (snapshot.error && snapshot.state !== 'settled') {
      this.emit('hood-pay:error', { code: snapshot.error.code, message: snapshot.error.message })
    }
    this.paint(snapshot)
  }

  private paint(snapshot: CheckoutSnapshot): void {
    const dialog = this.scrim?.querySelector('.dialog')
    if (!dialog) return
    const view = describeState(snapshot)
    const intent = snapshot.session?.intent

    const pick = <T extends HTMLElement>(id: string): T | null => dialog.querySelector<T>(`#${id}`)

    const merchant = pick('hp-merchant')
    if (merchant) {
      merchant.textContent = this.getAttribute('merchant-name') ?? intent?.merchantId ?? ''
    }

    const amountEl = pick('hp-amount')
    if (amountEl) {
      amountEl.innerHTML = intent
        ? `${displayUsdg(BigInt(intent.amount))}<span class="unit">USDG</span>`
        : '&nbsp;'
    }

    const description = pick('hp-description')
    if (description) {
      description.textContent = intent?.description ?? ''
      description.hidden = !intent?.description
    }

    const dot = pick('hp-dot')
    if (dot) dot.className = `dot ${view.tone}${view.busy ? ' busy' : ''}`

    const label = pick('hp-label')
    if (label) label.textContent = view.label

    const message = pick('hp-message')
    if (message) message.textContent = view.message

    const action = pick<HTMLButtonElement>('hp-action')
    if (action) {
      action.textContent = view.actionLabel
      action.disabled = !view.actionEnabled
      action.setAttribute('aria-busy', String(view.busy))
    }

    const network = pick('hp-network')
    if (network) network.textContent = snapshot.session?.network.label ?? ''

    this.paintWallets(dialog, snapshot)
    this.paintDetail(dialog, snapshot)
  }

  private paintWallets(dialog: Element, snapshot: CheckoutSnapshot): void {
    const container = dialog.querySelector<HTMLElement>('#hp-wallets')
    if (!container) return
    const selectable =
      snapshot.wallets.length > 1 &&
      (snapshot.state === 'idle' || snapshot.state === 'failed' || snapshot.state === 'wrong-chain')
    container.hidden = !selectable
    if (!selectable) {
      container.innerHTML = ''
      return
    }
    if (container.childElementCount === snapshot.wallets.length) {
      this.markSelected(container, snapshot.selectedWallet)
      return
    }
    container.innerHTML = ''
    for (const wallet of snapshot.wallets) {
      const button = document.createElement('button')
      button.className = 'wallet'
      button.type = 'button'
      button.dataset['uuid'] = wallet.info.uuid
      if (wallet.info.icon) {
        const icon = document.createElement('img')
        icon.src = wallet.info.icon
        icon.alt = ''
        button.appendChild(icon)
      }
      button.appendChild(document.createTextNode(wallet.info.name))
      button.addEventListener('click', () => {
        this.checkout?.selectWallet(wallet)
      })
      container.appendChild(button)
    }
    this.markSelected(container, snapshot.selectedWallet)
  }

  private markSelected(container: HTMLElement, selected: DiscoveredWallet | undefined): void {
    for (const child of Array.from(container.children)) {
      const uuid = (child as HTMLElement).dataset['uuid']
      child.setAttribute('aria-pressed', String(!!selected && uuid === selected.info.uuid))
    }
  }

  private paintDetail(dialog: Element, snapshot: CheckoutSnapshot): void {
    const detail = dialog.querySelector<HTMLElement>('#hp-detail')
    if (!detail) return
    detail.innerHTML = ''
    if (snapshot.state !== 'settled') return

    const fingerprint = receiptFingerprint(snapshot)
    if (fingerprint) {
      const p = document.createElement('p')
      p.className = 'fingerprint'
      p.textContent = `Receipt ${fingerprint}`
      detail.appendChild(p)
    }
    const href = explorerLink(snapshot)
    if (href) {
      const a = document.createElement('a')
      a.className = 'link'
      a.href = href
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.textContent = 'View transaction'
      detail.appendChild(a)
    }
    const successUrl = snapshot.session?.intent.successUrl
    if (successUrl) {
      const a = document.createElement('a')
      a.className = 'link'
      a.href = successUrl
      a.textContent = 'Continue'
      detail.appendChild(a)
    }
  }
}

/**
 * Register `<hood-pay-button>`. Safe to call more than once: a second call
 * with the element already defined is a no-op rather than a thrown error, so
 * two copies of the script on one page do not break it.
 */
export function defineHoodPayButton(tagName: string = TAG_NAME): void {
  if (typeof customElements === 'undefined') return
  if (customElements.get(tagName)) return
  customElements.define(tagName, HoodPayButtonElement)
}
