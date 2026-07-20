/**
 * The hosted checkout page served at `GET /pay/:id`.
 *
 * One self-contained HTML document: inline styles, inline script, no external
 * requests, no fonts, no CDN. It renders fully on the server, so the amount,
 * the description, the recipient, and the deadline are visible before a single
 * line of JavaScript executes, and a `<noscript>` block explains exactly what
 * is missing when scripting is off.
 *
 * This page is deliberately NOT the `<hood-pay-button>` widget. The widget is
 * for merchants embedding checkout in their own site, where it must inherit
 * nothing and pollute nothing. The hosted page is a standalone destination
 * reached from a link, an invoice, or a QR code, where inlining everything is
 * the right call because it has to work as one file. They share the HTTP API
 * and the EIP-712 construction, not the DOM layer. Stripe splits Checkout and
 * Elements along the same seam for the same reason.
 */

import { displayUsdg } from '../core/amount.js'
import type { CheckoutSession } from './merchant.js'

/** Escape a string for interpolation into HTML text or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Serialize JSON for embedding in a `<script type="application/json">` block.
 * `<` is escaped so the payload can never terminate the script element, and
 * U+2028 / U+2029 are escaped because they are legal inside a JSON string but
 * are line terminators in JavaScript source.
 */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * The checkout page's client script.
 *
 * Written as a plain string rather than a bundled module so the page stays a
 * single file with no second request. It contains no template literals, so it
 * can live inside one here without escaping.
 */
export const CHECKOUT_SCRIPT = `
(function () {
  'use strict';
  var cfg = JSON.parse(document.getElementById('hood-pay-session').textContent);
  var session = cfg.session;
  var apiBase = cfg.apiBase;
  var intent = session.intent;
  var net = session.network;

  var root = document.getElementById('hp-root');
  var statusEl = document.getElementById('hp-status');
  var msgEl = document.getElementById('hp-message');
  var btn = document.getElementById('hp-action');
  var detailEl = document.getElementById('hp-detail');
  var providers = [];
  var chosen = null;

  function setState(state, message, detail) {
    root.setAttribute('data-state', state);
    statusEl.textContent = STATE_LABEL[state] || state;
    msgEl.textContent = message || '';
    detailEl.innerHTML = '';
    if (detail) detailEl.appendChild(detail);
    var disabled = state === 'awaiting-signature' || state === 'relaying' || state === 'settled' ||
      state === 'expired' || state === 'canceled';
    btn.disabled = disabled;
    btn.setAttribute('aria-busy', String(state === 'awaiting-signature' || state === 'relaying'));
    if (state === 'settled') btn.textContent = 'Paid';
    else if (state === 'expired') btn.textContent = 'Expired';
    else if (state === 'wallet-missing') btn.textContent = 'No wallet found';
    else if (state === 'wrong-chain') btn.textContent = 'Switch network';
    else if (state === 'failed') btn.textContent = 'Try again';
    else btn.textContent = 'Pay ' + intent.amountFormatted.replace(/0+$/, '').replace(/\\.$/, '.00') + ' USDG';
  }

  var STATE_LABEL = {
    idle: 'Ready to pay',
    'wallet-missing': 'No wallet detected',
    'wrong-chain': 'Wrong network',
    'insufficient-usdg': 'Not enough USDG',
    'awaiting-signature': 'Waiting for your wallet',
    relaying: 'Settling on-chain',
    settled: 'Payment complete',
    failed: 'Payment failed',
    expired: 'Payment link expired',
    canceled: 'Payment canceled'
  };

  function link(href, text) {
    var a = document.createElement('a');
    a.href = href;
    a.textContent = text;
    a.rel = 'noopener noreferrer';
    a.target = '_blank';
    a.className = 'hp-link';
    return a;
  }

  function discover() {
    var found = [];
    function add(detail) {
      for (var i = 0; i < found.length; i++) if (found[i].info.uuid === detail.info.uuid) return;
      found.push(detail);
    }
    window.addEventListener('eip6963:announceProvider', function (event) { add(event.detail); });
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    if (found.length === 0 && window.ethereum) {
      found.push({ info: { uuid: 'injected', name: 'Browser wallet', rdns: 'injected' }, provider: window.ethereum });
    }
    return found;
  }

  function toHex(buffer) {
    var view = new Uint8Array(buffer);
    var out = '0x';
    for (var i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, '0');
    return out;
  }

  function deriveNonce(intentId, payer) {
    var data = new TextEncoder().encode('hood-pay/eip3009-nonce/v1|' + intentId + '|' + payer.toLowerCase());
    return crypto.subtle.digest('SHA-256', data).then(toHex);
  }

  function rpc(provider, method, params) {
    return provider.request({ method: method, params: params || [] });
  }

  function ensureChain(provider) {
    return rpc(provider, 'eth_chainId').then(function (current) {
      if (parseInt(current, 16) === net.chainId) return true;
      return rpc(provider, 'wallet_switchEthereumChain', [{ chainId: net.chainIdHex }])
        .then(function () { return true; })
        .catch(function (err) {
          if (err && (err.code === 4902 || err.code === -32603)) {
            return rpc(provider, 'wallet_addEthereumChain', [{
              chainId: net.chainIdHex,
              chainName: net.label,
              nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
              rpcUrls: [net.rpcUrl],
              blockExplorerUrls: [net.explorerUrl]
            }]).then(function () { return true; });
          }
          throw err;
        });
    });
  }

  function buildTypedData(payer, nonce, validAfter, validBefore) {
    return {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' }
        ],
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' }
        ]
      },
      primaryType: 'TransferWithAuthorization',
      domain: {
        name: net.usdgDomain.name,
        version: net.usdgDomain.version,
        chainId: net.chainId,
        verifyingContract: net.usdg
      },
      message: {
        from: payer,
        to: intent.payTo,
        value: intent.amount,
        validAfter: String(validAfter),
        validBefore: String(validBefore),
        nonce: nonce
      }
    };
  }

  function showSettled(body) {
    var wrap = document.createElement('div');
    if (body && body.receipt) {
      var p = document.createElement('p');
      p.className = 'hp-receipt';
      p.textContent = 'Receipt ' + body.receipt.digest.slice(0, 18) + '\\u2026';
      wrap.appendChild(p);
    }
    if (body && body.explorerTxUrl) wrap.appendChild(link(body.explorerTxUrl, 'View transaction'));
    setState('settled', 'Thank you. Your payment settled on-chain.', wrap);
    if (intent.successUrl) {
      var a = document.createElement('a');
      a.href = intent.successUrl;
      a.className = 'hp-link';
      a.textContent = 'Continue';
      wrap.appendChild(a);
    }
  }

  function pay() {
    if (!chosen) { setState('wallet-missing', 'Install a browser wallet to pay with USDG.'); return; }
    var provider = chosen.provider;
    var payer;
    setState('awaiting-signature', 'Approve the request in ' + chosen.info.name + '. You are signing a message, not sending a transaction, so no gas is needed.');

    rpc(provider, 'eth_requestAccounts')
      .then(function (accounts) {
        if (!accounts || accounts.length === 0) throw { code: 4001 };
        payer = accounts[0];
        return ensureChain(provider);
      })
      .then(function () { return deriveNonce(intent.id, payer); })
      .then(function (nonce) {
        var nowSec = Math.floor(Date.now() / 1000);
        var validAfter = 0;
        var validBefore = nowSec + session.authorizationValiditySeconds;
        var typed = buildTypedData(payer, nonce, validAfter, validBefore);
        return rpc(provider, 'eth_signTypedData_v4', [payer, JSON.stringify(typed)])
          .then(function (signature) {
            setState('relaying', 'Submitting your payment. The merchant pays the gas.');
            return fetch(apiBase + '/api/intents/' + encodeURIComponent(intent.id) + '/pay', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                signature: signature,
                authorization: {
                  from: payer,
                  to: intent.payTo,
                  value: intent.amount,
                  validAfter: String(validAfter),
                  validBefore: String(validBefore),
                  nonce: nonce
                }
              })
            });
          });
      })
      .then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (result) {
        if (result.ok) { showSettled(result.body); return; }
        var err = (result.body && result.body.error) || {};
        var code = err.code || 'relay_failed';
        if (code === 'insufficient_funds') {
          setState('insufficient-usdg', 'This wallet does not hold enough USDG for this payment.');
        } else if (code === 'intent_expired') {
          setState('expired', 'This payment link has expired. Ask the merchant for a new one.');
        } else if (code === 'intent_already_paid') {
          setState('settled', 'This payment was already completed.');
        } else {
          setState('failed', err.message || 'The payment could not be completed.');
        }
      })
      .catch(function (err) {
        if (err && (err.code === 4001 || err.code === 'ACTION_REJECTED')) {
          setState('idle', 'You canceled the request. Nothing was charged.');
        } else if (err && err.code === 4902) {
          setState('wrong-chain', 'Add ' + net.label + ' to your wallet to continue.');
        } else {
          setState('failed', (err && err.message) || 'Something went wrong. Please try again.');
        }
      });
  }

  btn.addEventListener('click', pay);

  providers = discover();
  chosen = providers[0] || null;
  if (!chosen) {
    setState('wallet-missing', 'No Ethereum wallet was detected in this browser. Install one, then reload this page.');
  } else if (intent.status === 'succeeded') {
    showSettled({ receipt: session.receipt, explorerTxUrl: session.explorerTxUrl });
  } else if (intent.status === 'expired') {
    setState('expired', 'This payment link has expired. Ask the merchant for a new one.');
  } else if (intent.status === 'canceled') {
    setState('canceled', 'This payment was canceled by the merchant.');
  } else {
    setState('idle', 'Pay with USDG on ' + net.label + '. You will sign a message, not a transaction, so no gas is required.');
  }

  if (providers.length > 1) {
    var picker = document.getElementById('hp-wallets');
    picker.hidden = false;
    providers.forEach(function (p, index) {
      var option = document.createElement('button');
      option.type = 'button';
      option.className = 'hp-wallet';
      option.textContent = p.info.name;
      option.setAttribute('aria-pressed', String(index === 0));
      option.addEventListener('click', function () {
        chosen = p;
        Array.prototype.forEach.call(picker.children, function (child) {
          child.setAttribute('aria-pressed', String(child === option));
        });
      });
      picker.appendChild(option);
    });
  }

  var deadline = intent.expiresAt * 1000;
  var timerEl = document.getElementById('hp-timer');
  function tick() {
    var remaining = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
    if (remaining === 0) {
      timerEl.textContent = 'Expired';
      if (root.getAttribute('data-state') === 'idle') {
        setState('expired', 'This payment link has expired. Ask the merchant for a new one.');
      }
      clearInterval(handle);
      return;
    }
    var mins = Math.floor(remaining / 60);
    var secs = remaining % 60;
    timerEl.textContent = 'Expires in ' + mins + ':' + String(secs).padStart(2, '0');
  }
  var handle = setInterval(tick, 1000);
  if (intent.status === 'requires_payment' || intent.status === 'failed') tick();
  else { timerEl.textContent = ''; clearInterval(handle); }
})();
`

/** The page's stylesheet. Dark and light, no external assets. */
export const CHECKOUT_STYLES = `
:root {
  color-scheme: light dark;
  --hp-bg: #f6f7f9;
  --hp-card: #ffffff;
  --hp-text: #14161a;
  --hp-dim: #5c6270;
  --hp-border: #e2e5ea;
  --hp-accent: #0a7d3f;
  --hp-accent-text: #ffffff;
  --hp-danger: #b3261e;
  --hp-warn: #8a5a00;
}
@media (prefers-color-scheme: dark) {
  :root {
    --hp-bg: #0a0a0c;
    --hp-card: #131317;
    --hp-text: #ededf0;
    --hp-dim: #9c9ca6;
    --hp-border: #26262d;
    --hp-accent: #7ef29a;
    --hp-accent-text: #06210f;
    --hp-danger: #f26d7e;
    --hp-warn: #f0c674;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  background: var(--hp-bg);
  color: var(--hp-text);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.hp-card {
  width: 100%;
  max-width: 420px;
  background: var(--hp-card);
  border: 1px solid var(--hp-border);
  border-radius: 16px;
  padding: 28px 26px 24px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 12px 32px rgba(0,0,0,0.06);
}
.hp-merchant { font-size: 13px; color: var(--hp-dim); letter-spacing: 0.02em; margin: 0 0 6px; }
.hp-amount { font-size: 38px; font-weight: 650; letter-spacing: -0.03em; margin: 0; }
.hp-amount .hp-unit { font-size: 16px; font-weight: 600; color: var(--hp-dim); margin-left: 6px; }
.hp-description { margin: 10px 0 0; color: var(--hp-dim); font-size: 14px; }
.hp-rows { margin: 22px 0 20px; border-top: 1px solid var(--hp-border); }
.hp-row {
  display: flex; justify-content: space-between; gap: 16px;
  padding: 10px 0; border-bottom: 1px solid var(--hp-border); font-size: 13px;
}
.hp-row dt { color: var(--hp-dim); margin: 0; }
.hp-row dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; overflow-wrap: anywhere; text-align: right; }
.hp-status {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 13px; font-weight: 600; margin-bottom: 8px;
}
.hp-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--hp-dim); flex: none; }
[data-state="settled"] .hp-dot { background: var(--hp-accent); }
[data-state="failed"] .hp-dot, [data-state="insufficient-usdg"] .hp-dot { background: var(--hp-danger); }
[data-state="expired"] .hp-dot, [data-state="canceled"] .hp-dot { background: var(--hp-dim); }
[data-state="wrong-chain"] .hp-dot, [data-state="wallet-missing"] .hp-dot { background: var(--hp-warn); }
[data-state="awaiting-signature"] .hp-dot, [data-state="relaying"] .hp-dot {
  background: var(--hp-accent);
  animation: hp-pulse 1.1s ease-in-out infinite;
}
@keyframes hp-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .hp-dot { animation: none !important; } }
.hp-message { margin: 0 0 16px; font-size: 13.5px; color: var(--hp-dim); min-height: 38px; }
.hp-action {
  width: 100%;
  border: none; border-radius: 10px;
  padding: 13px 18px;
  background: var(--hp-accent); color: var(--hp-accent-text);
  font-size: 15px; font-weight: 650; cursor: pointer;
  transition: filter 0.15s ease, transform 0.08s ease;
}
.hp-action:hover:not(:disabled) { filter: brightness(1.06); }
.hp-action:active:not(:disabled) { transform: translateY(1px); }
.hp-action:disabled { opacity: 0.55; cursor: not-allowed; }
.hp-action:focus-visible, .hp-wallet:focus-visible, .hp-link:focus-visible {
  outline: 2px solid var(--hp-accent); outline-offset: 2px;
}
.hp-wallets { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.hp-wallet {
  border: 1px solid var(--hp-border); background: transparent; color: var(--hp-text);
  border-radius: 8px; padding: 6px 12px; font-size: 13px; cursor: pointer;
}
.hp-wallet[aria-pressed="true"] { border-color: var(--hp-accent); color: var(--hp-accent); }
.hp-detail { margin-top: 14px; display: flex; gap: 14px; flex-wrap: wrap; }
.hp-link { color: var(--hp-accent); font-size: 13px; font-weight: 600; text-decoration: none; }
.hp-link:hover { text-decoration: underline; }
.hp-receipt { width: 100%; margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--hp-dim); }
.hp-foot {
  margin: 18px 0 0; padding-top: 14px; border-top: 1px solid var(--hp-border);
  display: flex; justify-content: space-between; gap: 12px;
  font-size: 12px; color: var(--hp-dim);
}
.hp-noscript {
  border: 1px solid var(--hp-warn); border-radius: 10px;
  padding: 12px 14px; font-size: 13px; margin-bottom: 16px;
}
`

export interface RenderCheckoutOptions {
  session: CheckoutSession
  /** Origin the page posts back to. Defaults to a same-origin relative path. */
  apiBase?: string
  /** Merchant name shown above the amount. */
  merchantName?: string
}

/** Render the complete hosted checkout document for an intent. */
export function renderCheckoutPage(options: RenderCheckoutOptions): string {
  const { session } = options
  const intent = session.intent
  const apiBase = options.apiBase ?? ''
  const merchantName = options.merchantName ?? intent.merchantId
  const amount = displayUsdg(BigInt(intent.amount))
  const title = intent.description
    ? `${amount} USDG - ${intent.description}`
    : `${amount} USDG payment`

  const initialState =
    intent.status === 'succeeded'
      ? 'settled'
      : intent.status === 'expired'
        ? 'expired'
        : intent.status === 'canceled'
          ? 'canceled'
          : 'idle'

  const rows: Array<[string, string]> = [
    ['Network', session.network.label],
    ['Asset', `USDG (${session.network.usdg.slice(0, 6)}...${session.network.usdg.slice(-4)})`],
    ['To', `${intent.payTo.slice(0, 8)}...${intent.payTo.slice(-6)}`],
    ['Reference', intent.id],
  ]

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${CHECKOUT_STYLES}</style>
</head>
<body>
<main class="hp-card" id="hp-root" data-state="${initialState}">
  <noscript>
    <div class="hp-noscript">
      Paying requires JavaScript, because your wallet has to sign the payment authorization in
      your browser. The details below are complete and correct. Enable JavaScript, or ask the
      merchant for an alternative payment method.
    </div>
  </noscript>

  <p class="hp-merchant">${escapeHtml(merchantName)}</p>
  <p class="hp-amount">${escapeHtml(amount)}<span class="hp-unit">USDG</span></p>
  ${intent.description ? `<p class="hp-description">${escapeHtml(intent.description)}</p>` : ''}

  <dl class="hp-rows">
    ${rows
      .map(
        ([label, value]) =>
          `<div class="hp-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`,
      )
      .join('\n    ')}
  </dl>

  <div class="hp-status" role="status" aria-live="polite">
    <span class="hp-dot" aria-hidden="true"></span><span id="hp-status">Ready to pay</span>
  </div>
  <p class="hp-message" id="hp-message">Pay with USDG on ${escapeHtml(session.network.label)}.</p>

  <div class="hp-wallets" id="hp-wallets" hidden role="group" aria-label="Choose a wallet"></div>

  <button class="hp-action" id="hp-action" type="button">Pay ${escapeHtml(amount)} USDG</button>
  <div class="hp-detail" id="hp-detail"></div>

  <div class="hp-foot">
    <span id="hp-timer"></span>
    <span>Gasless via EIP-3009</span>
  </div>
</main>
<script type="application/json" id="hood-pay-session">${embedJson({ session, apiBase })}</script>
<script>${CHECKOUT_SCRIPT}</script>
</body>
</html>`
}
