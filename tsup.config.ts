import { defineConfig } from 'tsup'

/** Node/bundler build. `viem`, `hood402`, and `react` stay external. */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'server/index': 'src/server/index.ts',
    'client/index': 'src/client/index.ts',
    'widget/index': 'src/widget/index.ts',
    'widget/react': 'src/widget/react.ts',
    'verify/index': 'src/verify/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  external: ['viem', 'hood402', 'react'],
})
