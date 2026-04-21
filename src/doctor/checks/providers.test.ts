import { describe, it, expect, vi } from 'vitest'
import * as fs from 'node:fs'
import type { Config } from '../../config.js'
import type { Ctx } from '../types.js'
import { buildProviderChecks } from './providers.js'

function makeCtx(cfg: Partial<Config>, fakeFetch: typeof fetch, deep = true): Ctx {
  return {
    config: cfg as Config,
    configError: null,
    deep,
    fetch: fakeFetch,
    fs,
    now: () => 0,
  }
}

function mockOk() {
  return vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
}
function mockStatus(code: number) {
  return vi.fn(async () => new Response('{}', { status: code })) as unknown as typeof fetch
}
function mockNetworkError() {
  return vi.fn(async () => { throw new Error('ENETUNREACH') }) as unknown as typeof fetch
}

describe('provider list-models probes', () => {
  it('anthropic: sends x-api-key and anthropic-version headers with a 5s timeout', async () => {
    const fake = mockOk()
    const cfg: Partial<Config> = { llmProviderPriority: ['anthropic'], anthropicApiKey: 'sk-ant-foo' }
    const ctx = makeCtx(cfg, fake)
    const out = await buildProviderChecks(['anthropic']).find(c => c.id === 'live.anthropic')!.run(ctx)
    expect(out.status).toBe('ok')
    expect(fake).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'sk-ant-foo',
          'anthropic-version': '2023-06-01',
        }),
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it('anthropic: 401 maps to fail with rejected-key hint', async () => {
    const fake = mockStatus(401)
    const cfg: Partial<Config> = { llmProviderPriority: ['anthropic'], anthropicApiKey: 'sk-ant-foo' }
    const ctx = makeCtx(cfg, fake)
    const out = await buildProviderChecks(['anthropic']).find(c => c.id === 'live.anthropic')!.run(ctx)
    expect(out.status).toBe('fail')
    expect(out.hint).toMatch(/rejected by anthropic/)
  })

  it('anthropic: network error maps to warn', async () => {
    const fake = mockNetworkError()
    const cfg: Partial<Config> = { llmProviderPriority: ['anthropic'], anthropicApiKey: 'sk-ant-foo' }
    const ctx = makeCtx(cfg, fake)
    const out = await buildProviderChecks(['anthropic']).find(c => c.id === 'live.anthropic')!.run(ctx)
    expect(out.status).toBe('warn')
    expect(out.hint).toMatch(/api.anthropic.com/)
  })

  it('openai: sends Authorization: Bearer header', async () => {
    const fake = mockOk()
    const cfg: Partial<Config> = { llmProviderPriority: ['openai'], openaiApiKey: 'sk-foo' }
    const ctx = makeCtx(cfg, fake)
    const out = await buildProviderChecks(['openai']).find(c => c.id === 'live.openai')!.run(ctx)
    expect(out.status).toBe('ok')
    expect(fake).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Authorization': 'Bearer sk-foo' }),
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it('openai: 403 maps to fail', async () => {
    const fake = mockStatus(403)
    const cfg: Partial<Config> = { llmProviderPriority: ['openai'], openaiApiKey: 'sk-foo' }
    const ctx = makeCtx(cfg, fake)
    const out = await buildProviderChecks(['openai']).find(c => c.id === 'live.openai')!.run(ctx)
    expect(out.status).toBe('fail')
    expect(out.hint).toMatch(/rejected by openai/)
  })

  it('gemini: puts key in query string, no auth header', async () => {
    const fake = mockOk()
    const cfg: Partial<Config> = { llmProviderPriority: ['gemini'], geminiApiKey: 'a'.repeat(40) }
    const ctx = makeCtx(cfg, fake)
    const out = await buildProviderChecks(['gemini']).find(c => c.id === 'live.gemini')!.run(ctx)
    expect(out.status).toBe('ok')
    const call = (fake as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    const url = call[0] as string
    expect(url).toContain('https://generativelanguage.googleapis.com/v1beta/models')
    expect(url).toContain('key=' + 'a'.repeat(40))
  })

  it('gemini: 5xx maps to warn', async () => {
    const fake = mockStatus(503)
    const cfg: Partial<Config> = { llmProviderPriority: ['gemini'], geminiApiKey: 'a'.repeat(40) }
    const ctx = makeCtx(cfg, fake)
    const out = await buildProviderChecks(['gemini']).find(c => c.id === 'live.gemini')!.run(ctx)
    expect(out.status).toBe('warn')
    expect(out.hint).toMatch(/gemini/)
  })

  it('provider without configured key is skipped (no fetch)', async () => {
    const fake = vi.fn() as unknown as typeof fetch
    const cfg: Partial<Config> = { llmProviderPriority: ['openai'] } // no key
    const ctx = makeCtx(cfg, fake)
    const out = await buildProviderChecks(['openai']).find(c => c.id === 'live.openai')!.run(ctx)
    expect(out.status).toBe('skip')
    expect((fake as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })
})
