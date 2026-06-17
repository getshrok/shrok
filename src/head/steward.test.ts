import { describe, it, expect, vi } from 'vitest'
import { runSpawnAgentSteward, runRelaySteward, DEFAULT_STEWARDS } from './steward.js'
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
    const result = await runSpawnAgentSteward('parent task', 'child task', [], router, 'dumb')
    expect(result).toEqual({ pass: true, reason: '' })
  })

  it('TEST-02 reject path: returns pass:false with reason verbatim', async () => {
    const router = makeStubRouter({ response: '{"pass": false, "reason": "trivial task"}' })
    const result = await runSpawnAgentSteward('parent task', 'child task', [], router, 'dumb')
    expect(result).toEqual({ pass: false, reason: 'trivial task' })
  })

  it('TEST-02 fail-open on throw: returns pass:true and logs warning', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const router = makeStubRouter({ throwError: new Error('network down') })
    const result = await runSpawnAgentSteward('parent task', 'child task', [], router, 'dumb')
    expect(result).toEqual({ pass: true, reason: '' })
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[steward:spawn-agent] failed, defaulting to pass:'),
      expect.any(String),
    )
    warnSpy.mockRestore()
  })

  it('TEST-02 schema-defensive: missing pass field treated as pass', async () => {
    const router = makeStubRouter({ response: '{}' })
    const result = await runSpawnAgentSteward('parent task', 'child task', [], router, 'dumb')
    expect(result).toEqual({ pass: true, reason: '' })
  })
})

describe('runRelaySteward — per-schedule relay guidance', () => {
  // Captures the interpolated prompt so we can assert what the steward actually saw.
  function makeCapturingRouter(response: string): { router: LLMRouter; prompts: string[] } {
    const prompts: string[] = []
    const router = {
      complete: async (model: string, messages: Array<{ content: string }>): Promise<LLMResponse> => {
        prompts.push(messages[0]?.content ?? '')
        return { content: response, inputTokens: 1, outputTokens: 1, stopReason: 'end_turn', model }
      },
    } as unknown as LLMRouter
    return { router, prompts }
  }

  const baseCtx = {
    output: 'all clear, nothing to report',
    task: 'health check',
    skillInstructions: '',
    userMd: '',
    soulMd: '',
    currentTime: '2026-06-17 12:00',
  }

  it('injects the per-schedule relayGuidance into the prompt', async () => {
    const { router, prompts } = makeCapturingRouter('{"relay": true}')
    await runRelaySteward({ ...baseCtx, relayGuidance: 'Always notify me of this digest' }, router, 'dumb')
    expect(prompts[0]).toContain('Always notify me of this digest')
  })

  it('uses a (none) placeholder when no relayGuidance is set', async () => {
    const { router, prompts } = makeCapturingRouter('{"relay": false}')
    await runRelaySteward(baseCtx, router, 'dumb')
    expect(prompts[0]).toContain('(none')
  })

  it('returns the steward decision', async () => {
    const { router } = makeCapturingRouter('{"relay": false}')
    const relay = await runRelaySteward({ ...baseCtx, relayGuidance: 'only on failure' }, router, 'dumb')
    expect(relay).toBe(false)
  })

  it('fails open (relays) on a malformed response', async () => {
    const { router } = makeCapturingRouter('not json')
    const relay = await runRelaySteward(baseCtx, router, 'dumb')
    expect(relay).toBe(true)
  })
})
