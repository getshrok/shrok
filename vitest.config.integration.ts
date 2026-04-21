import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'

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
    pool: 'forks',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 30_000,
  },
})
