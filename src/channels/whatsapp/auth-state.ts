/**
 * File-based WhatsApp auth state for Baileys.
 *
 * Stores credentials and signal keys as individual JSON files under `folder/`.
 * Uses atomic rename writes to avoid corruption on crash.
 * Wraps the key store with Baileys' makeCacheableSignalKeyStore to avoid
 * redundant disk reads on every signal operation.
 *
 * Baileys is dynamically imported — this module is only loaded when WhatsApp
 * is actually configured.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

async function writeAtomic(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.tmp`
  await fs.promises.writeFile(tmp, data, 'utf8')
  await fs.promises.rename(tmp, filePath)
}

function makeSilentLogger() {
  const noop = (..._args: unknown[]) => {}
  const logger: Record<string, unknown> = {
    level: 'silent',
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
  }
  logger['child'] = () => logger
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return logger as any
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createAuthState(folder: string): Promise<{
  state: { creds: unknown; keys: unknown }
  saveCreds: () => Promise<void>
}> {
  // @ts-expect-error — optional dependency, only installed when WhatsApp is configured
  const b = await import('@whiskeysockets/baileys')

  function readJson(filePath: string): unknown {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'), b.BufferJSON.reviver)
    } catch {
      return null
    }
  }

  fs.mkdirSync(folder, { recursive: true })

  const credsPath = path.join(folder, 'creds.json')
  const creds = readJson(credsPath) ?? b.initAuthCreds()

  const baseKeyStore = {
    get: async (type: string, ids: string[]) => {
      const result: Record<string, unknown> = {}
      for (const id of ids) {
        const safeId = id.replace(/\//g, '_')
        const keyPath = path.join(folder, 'keys', type, `${safeId}.json`)
        const val = readJson(keyPath)
        if (val !== null) result[id] = val
      }
      return result
    },
    set: async (data: Record<string, Record<string, unknown> | null>) => {
      for (const [type, ids] of Object.entries(data)) {
        const typeDir = path.join(folder, 'keys', type)
        fs.mkdirSync(typeDir, { recursive: true })
        for (const [id, value] of Object.entries(ids ?? {})) {
          const safeId = id.replace(/\//g, '_')
          const keyPath = path.join(typeDir, `${safeId}.json`)
          if (value != null) {
            await writeAtomic(keyPath, JSON.stringify(value, b.BufferJSON.replacer))
          } else {
            try { fs.unlinkSync(keyPath) } catch { /* already gone */ }
          }
        }
      }
    },
  }

  return {
    state: {
      creds,
      keys: b.makeCacheableSignalKeyStore(baseKeyStore as never, makeSilentLogger()),
    },
    saveCreds: async () => {
      await writeAtomic(credsPath, JSON.stringify(creds, b.BufferJSON.replacer))
    },
  }
}
