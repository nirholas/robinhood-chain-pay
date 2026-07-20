import { defineConfig } from 'tsup'

/**
 * Browser build. `src/browser.ts` pulls in the client SDK and the
 * `<hood-pay-button>` custom element, both of which are deliberately free of
 * `viem` and `hood402` imports, so this bundle has zero dependencies and stays
 * small enough to drop in with a single `<script>` tag.
 */
export default defineConfig({
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
