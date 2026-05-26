// src/types/agent-context-head-id.test.ts
// Phase 45 TDD-RED: AgentContext.headId required field contract
// This test verifies the runtime behavioral contract: an AgentContext object
// must carry a non-empty headId string so ring_device can resolve the HA channel.
import { describe, it, expect } from 'vitest'
import type { AgentContext } from './agent.js'

describe('AgentContext.headId contract (Phase 45 RING-03)', () => {
  it('accepts a plain object with all required fields including headId', () => {
    const ctx: AgentContext = {
      agentId: 'test-agent-1',
      headId: 'test-head',
      suspend: () => {},
      complete: (_output: string) => {},
      fail: (_error: string) => { throw new Error(_error) },
    }
    expect(ctx.headId).toBe('test-head')
    expect(ctx.agentId).toBe('test-agent-1')
  })

  it('headId is accessible on the context object', () => {
    const ctx: AgentContext = {
      agentId: 'agent-42',
      headId: 'work-head',
      suspend: () => {},
      complete: () => {},
      fail: (_error: string) => { throw new Error(_error) },
    }
    expect(ctx.headId).toStrictEqual('work-head')
  })

  it('headId can be any non-empty string (default head)', () => {
    const ctx: AgentContext = {
      agentId: 'a',
      headId: 'default',
      suspend: () => {},
      complete: () => {},
      fail: (_error: string) => { throw new Error(_error) },
    }
    expect(typeof ctx.headId).toBe('string')
    expect(ctx.headId.length).toBeGreaterThan(0)
  })
})
