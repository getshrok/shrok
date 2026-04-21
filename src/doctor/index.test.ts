import { describe, it, expect, vi } from 'vitest'
import type { Check, CheckResult, Ctx } from './types.js'
import { computeExitCode, runChecks } from './index.js'

function makeCtx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    config: null,
    configError: null,
    deep: false,
    fetch: vi.fn(),
    fs: require('node:fs'),
    now: () => 0,
    ...overrides,
  }
}

describe('computeExitCode', () => {
  it('returns 0 when all results are ok/skip', () => {
    const rs: CheckResult[] = [
      { id: 'a', title: 'a', layer: 'process', status: 'ok', durationMs: 1 },
      { id: 'b', title: 'b', layer: 'live', status: 'skip', durationMs: 0 },
    ]
    expect(computeExitCode(rs)).toBe(0)
  })

  it('returns 1 when any result is fail', () => {
    const rs: CheckResult[] = [
      { id: 'a', title: 'a', layer: 'process', status: 'ok', durationMs: 1 },
      { id: 'b', title: 'b', layer: 'creds', status: 'fail', durationMs: 2 },
      { id: 'c', title: 'c', layer: 'creds', status: 'warn', durationMs: 1 },
    ]
    expect(computeExitCode(rs)).toBe(1)
  })

  it('returns 2 when warns but no fails', () => {
    const rs: CheckResult[] = [
      { id: 'a', title: 'a', layer: 'process', status: 'ok', durationMs: 1 },
      { id: 'b', title: 'b', layer: 'creds', status: 'warn', durationMs: 2 },
    ]
    expect(computeExitCode(rs)).toBe(2)
  })

  it('treats an empty result list as 0', () => {
    expect(computeExitCode([])).toBe(0)
  })
})

describe('runChecks', () => {
  const passing: Check = {
    id: 'pass', title: 'pass', layer: 'process',
    run: async () => ({ status: 'ok' }),
  }
  const failing: Check = {
    id: 'fail', title: 'fail', layer: 'config',
    run: async () => ({ status: 'fail', detail: 'boom', hint: 'fix it' }),
  }
  const thrower: Check = {
    id: 'throw', title: 'throw', layer: 'creds',
    run: async () => { throw new Error('exploded') },
  }
  const live: Check = {
    id: 'live', title: 'live', layer: 'live',
    run: async () => ({ status: 'ok' }),
  }

  it('executes all checks sequentially and wraps them with id/title/layer/durationMs', async () => {
    const results = await runChecks([passing, failing], makeCtx())
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ id: 'pass', title: 'pass', layer: 'process', status: 'ok' })
    expect(results[1]).toMatchObject({ id: 'fail', title: 'fail', layer: 'config', status: 'fail', detail: 'boom', hint: 'fix it' })
    for (const r of results) expect(typeof r.durationMs).toBe('number')
  })

  it('catches thrown errors and turns them into fail results without aborting other checks', async () => {
    const results = await runChecks([thrower, passing], makeCtx())
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({
      id: 'throw',
      status: 'fail',
      detail: 'exploded',
      hint: 'Check threw — file a bug if reproducible',
    })
    expect(results[1]).toMatchObject({ id: 'pass', status: 'ok' })
  })

  it('skips layer:live checks when ctx.deep is false', async () => {
    const results = await runChecks([passing, live], makeCtx({ deep: false }))
    const liveRes = results.find(r => r.id === 'live')!
    expect(liveRes.status).toBe('skip')
    expect(liveRes.detail).toBe('use --deep to enable live probes')
  })

  it('runs layer:live checks when ctx.deep is true', async () => {
    const results = await runChecks([passing, live], makeCtx({ deep: true }))
    const liveRes = results.find(r => r.id === 'live')!
    expect(liveRes.status).toBe('ok')
  })

  it('filters checks by --only layer when provided', async () => {
    const results = await runChecks([passing, failing, live], makeCtx({ deep: true }), { onlyLayer: 'config' })
    expect(results).toHaveLength(1)
    expect(results[0]!.id).toBe('fail')
  })

  it('runs the default suite under the 500ms budget against an in-memory fake ctx', async () => {
    // Build a synthetic 7-check suite that each takes a few ms; simulates the real
    // offline pipeline on a healthy install.
    const synth: Check[] = Array.from({ length: 7 }, (_, i) => ({
      id: `c${i}`,
      title: `c${i}`,
      layer: (['process', 'config', 'creds', 'live'] as const)[i % 4]!,
      run: async () => {
        await new Promise(r => setTimeout(r, 5))
        return { status: 'ok' as const }
      },
    }))
    const start = Date.now()
    await runChecks(synth, makeCtx())
    const dur = Date.now() - start
    expect(dur).toBeLessThan(500)
  })
})
