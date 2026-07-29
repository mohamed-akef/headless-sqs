import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  // Dual output so both `require()` and `import` consumers get a native build.
  format: ['cjs', 'esm'],
  outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.js' }),
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'node22',
  platform: 'node',
  // The AWS SDK is a peer dependency: bundling it would ship a second copy and
  // break `instanceof` checks across the boundary.
  external: ['@aws-sdk/client-sqs', 'sqs-consumer'],
})
