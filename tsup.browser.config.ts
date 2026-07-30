import { defineConfig } from 'tsup'

/**
 * Browser build. `src/browser.ts` pulls in the client SDK and the
 * `<hood-pay-button>` custom element, both of which are deliberately free of
 * `viem` and `hood402` imports, so this bundle has zero dependencies and stays
 * small enough to drop in with a single `<script>` tag.
 */
export default defineConfig({
  // The entry key is the output basename, so it must stay unscoped: the
  // package.json `exports` map and `sideEffects` globs both point at
  // `dist/browser/hood-pay.js` / `hood-pay.iife.js`. Using the scoped package
  // name here emits `dist/browser/@three-ws/hood-pay.js` instead and breaks
  // every `@three-ws/hood-pay/browser` import.
  entry: { 'hood-pay': 'src/browser.ts' },
  outDir: 'dist/browser',
  format: ['esm', 'iife'],
  globalName: 'HoodPay',
  platform: 'browser',
  target: 'es2020',
  dts: false,
  sourcemap: true,
  minify: true,
  clean: false,
  outExtension({ format }) {
    return { js: format === 'iife' ? '.iife.js' : '.js' }
  },
})
