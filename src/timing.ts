import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const ENABLED = !!process.env['SHROK_TIMING']

let filePath: string | null = null
let lastMs: number | null = null

function trunc(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return String(v)
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
    return String(v)
  }
  try {
    return JSON.stringify(v)
  } catch {
    return '[unserializable]'
  }
}

export function timingMark(
  event: string,
  ctx: { sourceType?: string; sourceId?: string; round?: number; [k: string]: unknown } = {},
): void {
  if (!ENABLED) return

  if (filePath === null) {
    const tsSafe = new Date().toISOString().replace(/[:.]/g, '-')
    const candidate = path.join(os.tmpdir(), `shrok-timing-${tsSafe}.log`)
    try {
      fs.writeFileSync(candidate, '')
      filePath = candidate
      console.error(`[timing] logging to ${candidate}`)
    } catch (err) {
      console.error(`[timing] failed to init log file: ${(err as Error).message}`)
      filePath = ''
      return
    }
  }
  if (filePath === '') return

  const nowMs = performance.now()
  const deltaMs = lastMs === null ? 0 : Math.round(nowMs - lastMs)
  lastMs = nowMs

  const iso = new Date().toISOString()
  const srcType = ctx.sourceType ?? '-'
  const srcId = ctx.sourceId ?? '-'
  const round = ctx.round !== undefined ? `round=${ctx.round} ` : ''

  const kvParts: string[] = []
  for (const [k, v] of Object.entries(ctx)) {
    if (k === 'sourceType' || k === 'sourceId' || k === 'round') continue
    if (v === undefined) continue
    const rendered = formatValue(v)
    kvParts.push(`${k}=${trunc(rendered, 200)}`)
  }
  const kvStr = kvParts.join(' ')

  const line = `${iso} +${deltaMs}ms ${srcType}:${srcId} ${round}${event}${kvStr ? ' ' + kvStr : ''}\n`

  try {
    fs.appendFileSync(filePath, line)
  } catch {
    /* ignore */
  }
}
