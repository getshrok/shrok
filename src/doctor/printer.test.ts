import { describe, it, expect } from 'vitest'
import { renderHuman, renderJson } from './printer.js'
import type { CheckResult } from './types.js'

describe('renderHuman', () => {
  it('formats a single ok result with status and duration columns', () => {
    const r: CheckResult = { id: 'x', title: 'sanity', layer: 'process', status: 'ok', durationMs: 12 }
    const out = renderHuman([r], { deep: false, durationMs: 12 })
    expect(out).toContain('── process ──')
    expect(out).toContain('  ok    12ms  sanity')
    expect(out).toMatch(/verdict: ok\b/)
  })

  it('emits detail + hint lines for fail results', () => {
    const r: CheckResult = {
      id: 'cfg',
      title: 'config parses',
      layer: 'config',
      status: 'fail',
      detail: 'SyntaxError at line 3',
      hint: 'edit ~/.shrok/workspace/config.json',
      durationMs: 4,
    }
    const out = renderHuman([r], { deep: false, durationMs: 4 })
    // status padEnd(6) → 'fail  '; duration padEnd(6) → '4ms   '
    expect(out).toContain('  fail  4ms   config parses')
    expect(out).toContain('       detail: SyntaxError at line 3')
    expect(out).toContain('       hint: edit ~/.shrok/workspace/config.json')
    expect(out).toMatch(/verdict: fail\b/)
  })

  it('groups results by layer and prints a header per group', () => {
    const results: CheckResult[] = [
      { id: 'p1', title: 'pid', layer: 'process', status: 'ok', durationMs: 1 },
      { id: 'c1', title: 'config', layer: 'config', status: 'ok', durationMs: 2 },
      { id: 'k1', title: 'anthropic key', layer: 'creds', status: 'warn', durationMs: 1, hint: 'check shape' },
      { id: 'l1', title: 'anthropic live', layer: 'live', status: 'skip', durationMs: 0, detail: 'use --deep to enable live probes' },
    ]
    const out = renderHuman(results, { deep: false, durationMs: 4 })
    expect(out).toContain('── process ──')
    expect(out).toContain('── config ──')
    expect(out).toContain('── creds ──')
    expect(out).toContain('── live ──')
    // verdict: worst of ok/warn/fail wins — skip is ignored
    expect(out).toMatch(/verdict: warn\b/)
  })

  it('produces a stable snapshot for a mixed input', () => {
    const results: CheckResult[] = [
      { id: 'proc.pid', title: 'pid file present', layer: 'process', status: 'ok', durationMs: 3 },
      { id: 'cfg.load', title: 'config loads', layer: 'config', status: 'ok', durationMs: 7 },
      { id: 'creds.anthropic', title: 'anthropic key', layer: 'creds', status: 'fail', durationMs: 1, detail: 'ANTHROPIC_API_KEY not set', hint: 'set ANTHROPIC_API_KEY in workspace .env' },
    ]
    const out = renderHuman(results, { deep: false, durationMs: 11 })
    expect(out).toMatchInlineSnapshot(`
      "── process ──
        ok    3ms   pid file present
      ── config ──
        ok    7ms   config loads
      ── creds ──
        fail  1ms   anthropic key
             detail: ANTHROPIC_API_KEY not set
             hint: set ANTHROPIC_API_KEY in workspace .env

      verdict: fail  (total 11ms, deep=false)
      "
    `)
  })
})

describe('renderJson', () => {
  it('produces schemaVersion 1 with summary counts', () => {
    const results: CheckResult[] = [
      { id: 'a', title: 'a', layer: 'process', status: 'ok', durationMs: 1 },
      { id: 'b', title: 'b', layer: 'config', status: 'warn', durationMs: 2, hint: 'h' },
      { id: 'c', title: 'c', layer: 'creds', status: 'fail', durationMs: 3, detail: 'd', hint: 'h' },
      { id: 'd', title: 'd', layer: 'live', status: 'skip', durationMs: 0 },
    ]
    const out = renderJson(results, { deep: true, durationMs: 6 })
    const parsed = JSON.parse(out)
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.deep).toBe(true)
    expect(parsed.durationMs).toBe(6)
    expect(parsed.summary).toEqual({ ok: 1, warn: 1, fail: 1, skip: 1 })
    expect(parsed.results).toHaveLength(4)
    expect(parsed.results[0]).toMatchObject({ id: 'a', status: 'ok' })
  })

  it('is stable against a fixed input (snapshot)', () => {
    const results: CheckResult[] = [
      { id: 'proc.pid', title: 'pid', layer: 'process', status: 'ok', durationMs: 1 },
      { id: 'creds.anthropic', title: 'anthropic key', layer: 'creds', status: 'fail', durationMs: 2, detail: 'missing', hint: 'set env' },
    ]
    const out = renderJson(results, { deep: false, durationMs: 3 })
    expect(out).toMatchInlineSnapshot(`
      "{
        "schemaVersion": 1,
        "deep": false,
        "durationMs": 3,
        "summary": {
          "ok": 1,
          "warn": 0,
          "fail": 1,
          "skip": 0
        },
        "results": [
          {
            "id": "proc.pid",
            "title": "pid",
            "layer": "process",
            "status": "ok",
            "durationMs": 1
          },
          {
            "id": "creds.anthropic",
            "title": "anthropic key",
            "layer": "creds",
            "status": "fail",
            "detail": "missing",
            "hint": "set env",
            "durationMs": 2
          }
        ]
      }"
    `)
  })
})
