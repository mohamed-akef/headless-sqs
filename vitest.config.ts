import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['src/**/*.ts'],
      // Re-export barrel only; nothing to cover.
      exclude: ['src/index.ts'],
      // Set below current coverage so an ordinary refactor does not turn CI red
      // on a rounding error, while still catching a real drop.
      thresholds: {
        lines: 85,
        functions: 78,
        branches: 75,
        statements: 85,
      },
    },
  },
})
