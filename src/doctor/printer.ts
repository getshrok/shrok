// Pure renderers for doctor results. No I/O, no color codes — the output is
// plain text so snapshot tests stay stable across CI/no-tty environments and
// downstream tooling can parse the JSON form deterministically.

import type { CheckResult, Layer, Status } from './types.js'

const LAYERS: Layer[] = ['process', 'config', 'creds', 'live']

function padRight(s: string, width: number): string {
  if (s.length >= width) return s
  return s + ' '.repeat(width - s.length)
}

function statusCol(s: Status): string {
  // 6-char column so 'ok'/'warn'/'fail'/'skip' share a common gutter.
  return padRight(s, 6)
}

function durationCol(ms: number): string {
  // 6-char column: '12ms  ', '3ms   ', '0ms   ' etc.
  return padRight(`${ms}ms`, 6)
}

/** Worst-wins verdict across ok < warn < fail; skip does not contribute. */
function verdict(results: CheckResult[]): Status {
  let worst: Status = 'ok'
  for (const r of results) {
    if (r.status === 'skip') continue
    if (r.status === 'fail') return 'fail'
    if (r.status === 'warn') worst = 'warn'
  }
  return worst
}

export function renderHuman(
  results: CheckResult[],
  opts: { deep: boolean; durationMs: number },
): string {
  const byLayer = new Map<Layer, CheckResult[]>()
  for (const r of results) {
    const arr = byLayer.get(r.layer) ?? []
    arr.push(r)
    byLayer.set(r.layer, arr)
  }

  const lines: string[] = []
  for (const layer of LAYERS) {
    const rs = byLayer.get(layer)
    if (!rs || rs.length === 0) continue
    lines.push(`── ${layer} ──`)
    for (const r of rs) {
      // Format: [2-space indent][status padEnd 6][duration padEnd 6][title]
      // e.g. '  ok    12ms  sanity' / '  fail  4ms   config parses'
      lines.push(`  ${statusCol(r.status)}${durationCol(r.durationMs)}${r.title}`)
      if (r.detail) lines.push(`       detail: ${r.detail}`)
      if (r.hint) lines.push(`       hint: ${r.hint}`)
    }
  }
  lines.push('')
  lines.push(`verdict: ${verdict(results)}  (total ${opts.durationMs}ms, deep=${opts.deep})`)
  return lines.join('\n') + '\n'
}

export function renderJson(
  results: CheckResult[],
  opts: { deep: boolean; durationMs: number },
): string {
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 }
  for (const r of results) summary[r.status] += 1
  const payload = {
    schemaVersion: 1 as const,
    deep: opts.deep,
    durationMs: opts.durationMs,
    summary,
    results: results.map(r => {
      // Emit keys in a stable order so snapshots stay deterministic.
      const out: Record<string, unknown> = {
        id: r.id,
        title: r.title,
        layer: r.layer,
        status: r.status,
      }
      if (r.detail !== undefined) out['detail'] = r.detail
      if (r.hint !== undefined) out['hint'] = r.hint
      out['durationMs'] = r.durationMs
      return out
    }),
  }
  return JSON.stringify(payload, null, 2)
}
