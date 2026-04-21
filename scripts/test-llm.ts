/**
 * Smoke-tests the configured LLM provider by sending a minimal completion.
 * Called by setup.ts; exits 0 on success, 1 on failure.
 * Reads only the env vars it needs so it works mid-wizard before .env is fully populated.
 */

import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'
import OpenAI from 'openai'

const provider = process.env['LLM_PROVIDER'] ?? 'anthropic'

try {
  if (provider === 'anthropic') {
    const key = process.env['ANTHROPIC_API_KEY'] ?? ''
    const client = new Anthropic({ apiKey: key })
    const model = process.env['ANTHROPIC_MODEL_STANDARD'] ?? 'claude-haiku-4-5-20251001'
    const msg = await client.messages.create({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
    })
    if (!msg.content.length) throw new Error('Empty response')

  } else if (provider === 'gemini') {
    const key = process.env['GEMINI_API_KEY'] ?? ''
    const genai = new GoogleGenerativeAI(key)
    const model = genai.getGenerativeModel({ model: process.env['GEMINI_MODEL_STANDARD'] ?? 'gemini-2.0-flash' })
    const result = await model.generateContent('Reply with exactly: ok')
    if (!result.response.text()) throw new Error('Empty response')

  } else {
    const key = process.env['OPENAI_API_KEY'] ?? ''
    const client = new OpenAI({ apiKey: key })
    const model = process.env['OPENAI_MODEL_STANDARD'] ?? 'gpt-4o-mini'
    const resp = await client.chat.completions.create({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
    })
    if (!resp.choices[0]?.message.content) throw new Error('Empty response')
  }

  process.exit(0)
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
