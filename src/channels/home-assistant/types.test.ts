import { describe, it, expect } from 'vitest'
import { extractLastUserTurn, buildChatCompletionResponse } from './types.js'

describe('extractLastUserTurn', () => {
  it('returns the last role:user content from a multi-turn array', () => {
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'latest' },
    ]
    expect(extractLastUserTurn(messages)).toBe('latest')
  })

  it('returns the last user turn even when followed by an assistant turn', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]
    expect(extractLastUserTurn(messages)).toBe('hello')
  })

  it('returns null for an empty array', () => {
    expect(extractLastUserTurn([])).toBeNull()
  })

  it('returns null when no role:user entry is present', () => {
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'assistant', content: 'reply' },
    ]
    expect(extractLastUserTurn(messages)).toBeNull()
  })

  it('returns null when the last user entry has null content', () => {
    const messages = [
      { role: 'user', content: null },
    ]
    expect(extractLastUserTurn(messages)).toBeNull()
  })

  it('returns null when the last user entry has empty string content', () => {
    const messages = [
      { role: 'user', content: '' },
    ]
    expect(extractLastUserTurn(messages)).toBeNull()
  })

  it('tolerates null content on intermediate entries and still finds the last user turn', () => {
    const messages = [
      { role: 'system', content: null },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: null },
    ]
    expect(extractLastUserTurn(messages)).toBe('hello')
  })

  it('picks the LAST user turn when multiple user turns are present (loops from end)', () => {
    const messages = [
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'latest turn' },
    ]
    expect(extractLastUserTurn(messages)).toBe('latest turn')
  })
})

describe('buildChatCompletionResponse', () => {
  it('returns an object with object === chat.completion', () => {
    const result = buildChatCompletionResponse('hello', 'conv-123')
    expect(result['object']).toBe('chat.completion')
  })

  it('returns model === shrok', () => {
    const result = buildChatCompletionResponse('hello', 'conv-123')
    expect(result['model']).toBe('shrok')
  })

  it('returns choices[0].message.role === assistant', () => {
    const result = buildChatCompletionResponse('hello', 'conv-123')
    const choices = result['choices'] as Array<Record<string, unknown>>
    const choice = choices[0]
    expect(choice).toBeDefined()
    if (choice) {
      const message = choice['message'] as Record<string, unknown>
      expect(message['role']).toBe('assistant')
    }
  })

  it('returns choices[0].message.content equal to the provided content', () => {
    const result = buildChatCompletionResponse('hello', 'conv-123')
    const choices = result['choices'] as Array<Record<string, unknown>>
    const choice = choices[0]
    expect(choice).toBeDefined()
    if (choice) {
      const message = choice['message'] as Record<string, unknown>
      expect(message['content']).toBe('hello')
    }
  })

  it('returns choices[0].finish_reason === stop', () => {
    const result = buildChatCompletionResponse('hello', 'conv-123')
    const choices = result['choices'] as Array<Record<string, unknown>>
    const choice = choices[0]
    expect(choice).toBeDefined()
    if (choice) {
      expect(choice['finish_reason']).toBe('stop')
    }
  })

  it('returns choices[0].logprobs === null', () => {
    const result = buildChatCompletionResponse('hello', 'conv-123')
    const choices = result['choices'] as Array<Record<string, unknown>>
    const choice = choices[0]
    expect(choice).toBeDefined()
    if (choice) {
      expect(choice['logprobs']).toBeNull()
    }
  })

  it('returns choices[0].index === 0', () => {
    const result = buildChatCompletionResponse('hello', 'conv-123')
    const choices = result['choices'] as Array<Record<string, unknown>>
    const choice = choices[0]
    expect(choice).toBeDefined()
    if (choice) {
      expect(choice['index']).toBe(0)
    }
  })

  it('returns zeroed usage (HACV-01)', () => {
    const result = buildChatCompletionResponse('hello', 'conv-123')
    expect(result['usage']).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    })
  })

  it('echoes conversation_id at top level (HACV-05)', () => {
    const result = buildChatCompletionResponse('hello', 'conv-123')
    expect(result['conversation_id']).toBe('conv-123')
  })

  it('id starts with chatcmpl- prefix', () => {
    const result = buildChatCompletionResponse('hello', 'conv-123')
    const id = result['id'] as string
    expect(id).toMatch(/^chatcmpl-/)
  })

  it('created is a positive integer (seconds since epoch)', () => {
    const result = buildChatCompletionResponse('hello', 'conv-123')
    const created = result['created'] as number
    expect(Number.isInteger(created)).toBe(true)
    expect(created).toBeGreaterThan(0)
  })
})
