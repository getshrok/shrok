import { defineConfig } from 'vitest/config'
import path from 'path'

// Dashboard-local vitest config. Run with: cd dashboard && npx vitest run
// Uses the root-hoisted vitest install (no new devDependency needed).
// Environment is 'node' — Phase 21 tests cover pure reducers. Any future DOM-dependent
// tests will require adding jsdom/happy-dom as a devDependency in a later phase.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    pool: 'forks',
    poolOptions: {
      forks: { minForks: 0, maxForks: 1 },
    },
    testTimeout: 10_000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
})
