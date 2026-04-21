import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'

// node:sqlite landed in Node 22.5 as an experimental built-in.
// It's not in builtinModules (frozen array), so Vite doesn't recognise it
// and fails to load it as a URL. We intercept it and serve a virtual module
// that loads the actual implementation via createRequire, bypassing Vite's
// URL resolution entirely.
const nodeBuiltinPlugin: Plugin = {
  name: 'node-sqlite',
  enforce: 'pre',
  resolveId(id) {
    if (id === 'node:sqlite' || id === 'sqlite') return '\0node:sqlite'
  },
  load(id) {
    if (id === '\0node:sqlite') {
      return `
        import { createRequire } from 'node:module'
        const _r = createRequire(import.meta.url)
        const mod = _r('node:sqlite')
        export const DatabaseSync = mod.DatabaseSync
        export const StatementSync = mod.StatementSync
      `
    }
  },
}

export default defineConfig({
  plugins: [nodeBuiltinPlugin],
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    pool: 'forks',
    poolOptions: {
      forks: { minForks: 0, maxForks: 1, execArgv: ['--max-old-space-size=4096'] },
    },
    testTimeout: 30_000,
    hookTimeout: 15_000,
    teardownTimeout: 10_000,
  },
})
