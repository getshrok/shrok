import { describe, it, expect, vi } from 'vitest'
import { runSpawnAgentSteward, DEFAULT_STEWARDS } from './steward.js'
import { log } from '../logger.js'
import type { LLMRouter, LLMResponse } from '../types/llm.js'

function makeStubRouter(opts: {
  response?: string
  throwError?: Error
}): LLMRouter {
  return {
    complete: async (model: string): Promise<LLMResponse> => {
      if (opts.throwError) throw opts.throwError
      return {
        content: opts.response ?? '{"pass": true, "reason": ""}',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'end_turn',
        model,
      }
    },
  } as unknown as LLMRouter
}

describe('DEFAULT_STEWARDS (Phase 15)', () => {
  it('contains exactly four stewards', () => {
    expect(DEFAULT_STEWARDS).toHaveLength(4)
  })

  it('first entry is bootstrapSteward', () => {
    expect(DEFAULT_STEWARDS[0]?.name).toBe('bootstrapSteward')
  })

  it('second entry is preferenceSteward', () => {
    expect(DEFAULT_STEWARDS[1]?.name).toBe('preferenceSteward')
  })

  it('third entry is spawnSteward', () => {
    expect(DEFAULT_STEWARDS[2]?.name).toBe('spawnSteward')
  })

  it('fourth entry is actionComplianceSteward', () => {
    expect(DEFAULT_STEWARDS[3]?.name).toBe('actionComplianceSteward')
  })
})

describe('runSpawnAgentSteward', () => {
  it('TEST-02 pass path: returns pass:true when stub says pass', async () => {
    const router = makeStubRouter({ response: '{"pass": true, "reason": ""}' })
    const result = await runSpawnAgentSteward('parent task', 'child task', [], router, 'standard')
    expect(result).toEqual({ pass: true, reason: '' })
  })

  it('TEST-02 reject path: returns pass:false with reason verbatim', async () => {
    const router = makeStubRouter({ response: '{"pass": false, "reason": "trivial task"}' })
    const result = await runSpawnAgentSteward('parent task', 'child task', [], router, 'standard')
    expect(result).toEqual({ pass: false, reason: 'trivial task' })
  })

  it('TEST-02 fail-open on throw: returns pass:true and logs warning', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const router = makeStubRouter({ throwError: new Error('network down') })
    const result = await runSpawnAgentSteward('parent task', 'child task', [], router, 'standard')
    expect(result).toEqual({ pass: true, reason: '' })
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[steward:spawn-agent] failed, defaulting to pass:'),
      expect.any(String),
    )
    warnSpy.mockRestore()
  })

  it('TEST-02 schema-defensive: missing pass field treated as pass', async () => {
    const router = makeStubRouter({ response: '{}' })
    const result = await runSpawnAgentSteward('parent task', 'child task', [], router, 'standard')
    expect(result).toEqual({ pass: true, reason: '' })
  })
})
