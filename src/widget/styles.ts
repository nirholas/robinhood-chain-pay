/**
 * The widget's stylesheet, scoped inside a shadow root.
 *
 * Shadow DOM is the whole point: a merchant's page cannot restyle the pay
 * button by accident, and the widget cannot leak a single rule onto the
 * merchant's page. The only things that cross the boundary are the CSS custom
 * properties listed below, which a merchant can set on the host element to
 * match their brand.
 *
 * Themeable custom properties:
 *   --hood-pay-accent, --hood-pay-accent-text, --hood-pay-radius,
 *   --hood-pay-font
 */
export const WIDGET_STYLES = `
:host {
  --hp-accent: var(--hood-pay-accent, #0a7d3f);
  --hp-accent-text: var(--hood-pay-accent-text, #ffffff);
  --hp-radius: var(--hood-pay-radius, 10px);
  --hp-font: var(--hood-pay-font, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
  --hp-bg: #ffffff;
  --hp-text: #14161a;
  --hp-dim: #5c6270;
  --hp-border: #e2e5ea;
  --hp-scrim: rgba(12, 14, 18, 0.55);
  --hp-danger: #b3261e;
  --hp-warning: #8a5a00;
  --hp-success: #0a7d3f;
  display: inline-block;
  font-family: var(--hp-font);
  color-scheme: light dark;
}
:host([theme="dark"]),
:host([theme="auto"]) { color-scheme: dark light; }
@media (prefers-color-scheme: dark) {
  :host(:not([theme="light"])) {
    --hp-accent: var(--hood-pay-accent, #7ef29a);
    --hp-accent-text: var(--hood-pay-accent-text, #06210f);
    --hp-bg: #131317;
    --hp-text: #ededf0;
    --hp-dim: #9c9ca6;
    --hp-border: #26262d;
    --hp-scrim: rgba(0, 0, 0, 0.7);
    --hp-danger: #f26d7e;
    --hp-warning: #f0c674;
    --hp-success: #7ef29a;
  }
}
:host([theme="dark"]) {
  --hp-accent: var(--hood-pay-accent, #7ef29a);
  --hp-accent-text: var(--hood-pay-accent-text, #06210f);
  --hp-bg: #131317;
  --hp-text: #ededf0;
  --hp-dim: #9c9ca6;
  --hp-border: #26262d;
  --hp-scrim: rgba(0, 0, 0, 0.7);
  --hp-danger: #f26d7e;
  --hp-warning: #f0c674;
  --hp-success: #7ef29a;
}
:host([hidden]) { display: none; }

button { font: inherit; }

.trigger {
  border: none;
  border-radius: var(--hp-radius);
  background: var(--hp-accent);
  color: var(--hp-accent-text);
  padding: 12px 22px;
  font-size: 15px;
  font-weight: 650;
  cursor: pointer;
  transition: filter 0.15s ease, transform 0.08s ease, box-shadow 0.15s ease;
}
.trigger:hover:not(:disabled) { filter: brightness(1.07); }
.trigger:active:not(:disabled) { transform: translateY(1px); }
.trigger:disabled { opacity: 0.55; cursor: not-allowed; }
.trigger:focus-visible, .action:focus-visible, .wallet:focus-visible, .close:focus-visible, .link:focus-visible {
  outline: 2px solid var(--hp-accent);
  outline-offset: 2px;
}

.scrim {
  position: fixed;
  inset: 0;
  background: var(--hp-scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  z-index: 2147483000;
  animation: hp-fade 0.16s ease-out;
}
.dialog {
  position: relative;
  width: 100%;
  max-width: 400px;
  background: var(--hp-bg);
  color: var(--hp-text);
  border: 1px solid var(--hp-border);
  border-radius: 16px;
  padding: 26px 24px 22px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
  animation: hp-rise 0.18s cubic-bezier(0.2, 0.8, 0.3, 1);
  max-height: calc(100vh - 40px);
  overflow-y: auto;
}
@keyframes hp-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes hp-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .scrim, .dialog { animation: none; }
  .dot.busy { animation: none; }
}

.close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--hp-dim);
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
}
.close:hover { border-color: var(--hp-border); color: var(--hp-text); }

.merchant { margin: 0 0 6px; font-size: 13px; color: var(--hp-dim); }
.amount { margin: 0; font-size: 36px; font-weight: 650; letter-spacing: -0.03em; }
.amount .unit { font-size: 15px; font-weight: 600; color: var(--hp-dim); margin-left: 6px; }
.description { margin: 8px 0 0; font-size: 14px; color: var(--hp-dim); }

.status { display: inline-flex; align-items: center; gap: 8px; margin: 20px 0 6px; font-size: 13px; font-weight: 600; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--hp-dim); flex: none; }
.dot.progress, .dot.success { background: var(--hp-success); }
.dot.danger { background: var(--hp-danger); }
.dot.warning { background: var(--hp-warning); }
.dot.busy { animation: hp-pulse 1.1s ease-in-out infinite; }
@keyframes hp-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }

.message { margin: 0 0 16px; font-size: 13.5px; color: var(--hp-dim); min-height: 40px; }

.wallets { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.wallet {
  display: inline-flex; align-items: center; gap: 7px;
  border: 1px solid var(--hp-border); background: transparent; color: var(--hp-text);
  border-radius: 8px; padding: 6px 11px; font-size: 13px; cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.wallet:hover { border-color: var(--hp-accent); }
.wallet[aria-pressed="true"] { border-color: var(--hp-accent); color: var(--hp-accent); }
.wallet img { width: 16px; height: 16px; border-radius: 4px; }

.action {
  width: 100%;
  border: none;
  border-radius: var(--hp-radius);
  background: var(--hp-accent);
  color: var(--hp-accent-text);
  padding: 13px 18px;
  font-size: 15px;
  font-weight: 650;
  cursor: pointer;
  transition: filter 0.15s ease, transform 0.08s ease;
}
.action:hover:not(:disabled) { filter: brightness(1.07); }
.action:active:not(:disabled) { transform: translateY(1px); }
.action:disabled { opacity: 0.55; cursor: not-allowed; }

.detail { margin-top: 14px; display: flex; gap: 14px; flex-wrap: wrap; align-items: center; }
.link { color: var(--hp-accent); font-size: 13px; font-weight: 600; text-decoration: none; }
.link:hover { text-decoration: underline; }
.fingerprint {
  width: 100%; margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px; color: var(--hp-dim);
}
.foot {
  margin: 18px 0 0; padding-top: 13px; border-top: 1px solid var(--hp-border);
  display: flex; justify-content: space-between; gap: 12px;
  font-size: 11.5px; color: var(--hp-dim);
}
`
