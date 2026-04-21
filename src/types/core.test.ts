import { describe, it, expect } from 'vitest'
import { PRIORITY } from './core.js'
import type {
  TextMessage,
  ToolCallMessage,
  ToolResultMessage,
  SummaryMessage,
  Message,
  QueueEvent,
  ToolCall,
  ToolResult,
} from './core.js'

describe('PRIORITY constants', () => {
  it('has expected priority ordering', () => {
    expect(PRIORITY.USER_MESSAGE).toBeGreaterThan(PRIORITY.AGENT_QUESTION)
    expect(PRIORITY.AGENT_QUESTION).toBeGreaterThan(PRIORITY.AGENT_COMPLETED)
    expect(PRIORITY.AGENT_COMPLETED).toBeGreaterThan(PRIORITY.WEBHOOK)
    expect(PRIORITY.WEBHOOK).toBeGreaterThan(PRIORITY.SCHEDULE_TRIGGER)
  })

  it('has correct absolute values', () => {
    expect(PRIORITY.USER_MESSAGE).toBe(100)
    expect(PRIORITY.AGENT_QUESTION).toBe(50)
    expect(PRIORITY.AGENT_COMPLETED).toBe(30)
    expect(PRIORITY.AGENT_FAILED).toBe(30)
    expect(PRIORITY.WEBHOOK).toBe(20)
    expect(PRIORITY.SCHEDULE_TRIGGER).toBe(10)
  })
})

describe('Message discriminated union', () => {
  it('TextMessage satisfies Message', () => {
    const msg: TextMessage = {
      kind: 'text',
      id: 'msg-1',
      role: 'user',
      content: 'hello',
      createdAt: '2025-01-01T00:00:00Z',
    }
    const _m: Message = msg  // type-level check
    expect(msg.kind).toBe('text')
    expect(msg.role).toBe('user')
  })

  it('TextMessage can have optional channel', () => {
    const msg: TextMessage = {
      kind: 'text',
      id: 'msg-2',
      role: 'user',
      content: 'hi',
      createdAt: '2025-01-01T00:00:00Z',
      channel: 'discord',
    }
    expect(msg.channel).toBe('discord')
  })

  it('assistant TextMessage has no channel', () => {
    const msg: TextMessage = {
      kind: 'text',
      id: 'msg-3',
      role: 'assistant',
      content: 'hi back',
      createdAt: '2025-01-01T00:00:00Z',
    }
    expect(msg.role).toBe('assistant')
    expect(msg.channel).toBeUndefined()
  })

  it('ToolCallMessage satisfies Message', () => {
    const tc: ToolCall = { id: 'tc-1', name: 'bash', input: { cmd: 'ls' } }
    const msg: ToolCallMessage = {
      kind: 'tool_call',
      id: 'msg-4',
      content: '',
      toolCalls: [tc],
      createdAt: '2025-01-01T00:00:00Z',
    }
    const _m: Message = msg
    expect(msg.kind).toBe('tool_call')
    expect(msg.toolCalls).toHaveLength(1)
  })

  it('ToolCallMessage can be injected', () => {
    const tc: ToolCall = { id: 'tc-2', name: 'read', input: {} }
    const msg: ToolCallMessage = {
      kind: 'tool_call',
      id: 'msg-5',
      content: '',
      toolCalls: [tc],
      injected: true,
      createdAt: '2025-01-01T00:00:00Z',
    }
    expect(msg.injected).toBe(true)
  })

  it('ToolResultMessage satisfies Message', () => {
    const tr: ToolResult = { toolCallId: 'tc-1', name: 'bash', content: 'file.ts' }
    const msg: ToolResultMessage = {
      kind: 'tool_result',
      id: 'msg-6',
      toolResults: [tr],
      createdAt: '2025-01-01T00:00:00Z',
    }
    const _m: Message = msg
    expect(msg.kind).toBe('tool_result')
    expect(msg.toolResults[0]?.content).toBe('file.ts')
  })

  it('SummaryMessage satisfies Message', () => {
    const msg: SummaryMessage = {
      kind: 'summary',
      id: 'msg-7',
      content: 'Summary of 10 messages',
      summarySpan: ['2025-01-01T00:00:00Z', '2025-01-01T01:00:00Z'],
      createdAt: '2025-01-01T01:00:00Z',
    }
    const _m: Message = msg
    expect(msg.kind).toBe('summary')
    expect(msg.summarySpan).toHaveLength(2)
  })
})

describe('QueueEvent discriminated union', () => {
  it('user_message event', () => {
    const ev: QueueEvent = {
      type: 'user_message',
      id: 'ev-1',
      channel: 'discord',
      text: 'hello',
      createdAt: '2025-01-01T00:00:00Z',
    }
    expect(ev.type).toBe('user_message')
  })

  it('agent_completed event', () => {
    const ev: QueueEvent = {
      type: 'agent_completed',
      id: 'ev-2',
      agentId: 't-1',
      output: 'done',
      createdAt: '2025-01-01T00:00:00Z',
    }
    expect(ev.type).toBe('agent_completed')
  })

  it('agent_question event', () => {
    const ev: QueueEvent = {
      type: 'agent_question',
      id: 'ev-3',
      agentId: 't-1',
      question: 'should I proceed?',
      createdAt: '2025-01-01T00:00:00Z',
    }
    expect(ev.type).toBe('agent_question')
  })

  it('agent_failed event', () => {
    const ev: QueueEvent = {
      type: 'agent_failed',
      id: 'ev-4',
      agentId: 't-1',
      error: 'timed out',
      createdAt: '2025-01-01T00:00:00Z',
    }
    expect(ev.type).toBe('agent_failed')
  })

  it('schedule_trigger event', () => {
    const ev: QueueEvent = {
      type: 'schedule_trigger',
      id: 'ev-5',
      scheduleId: 's-1',
      taskName: 'email',
      kind: 'task',
      createdAt: '2025-01-01T00:00:00Z',
    }
    expect(ev.type).toBe('schedule_trigger')
  })

  it('webhook event', () => {
    const ev: QueueEvent = {
      type: 'webhook',
      id: 'ev-6',
      source: 'github',
      event: 'push',
      payload: { ref: 'main' },
      createdAt: '2025-01-01T00:00:00Z',
    }
    expect(ev.type).toBe('webhook')
  })
})
