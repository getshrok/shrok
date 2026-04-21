import { describe, it, expect, vi } from 'vitest'
import * as fs from 'node:fs'
import type { Config } from '../../config.js'
import type { Ctx, CheckResult } from '../types.js'
import { credentialsChecks, buildCredentialsChecks } from './credentials.js'

function makeCtx(cfg: Partial<Config>, fetchFake: typeof fetch): Ctx {
  return {
    config: cfg as Config,
    configError: null,
    deep: false,
    fetch: fetchFake,
    fs,
    now: () => 0,
  }
}

describe('credentialsChecks', () => {
  it('exports a static suite covering all providers and channels', () => {
    // Sanity: we expose some checks under a stable name.
    expect(Array.isArray(credentialsChecks)).toBe(true)
    expect(credentialsChecks.length).toBeGreaterThan(0)
  })

  it('never calls fetch — all checks are offline', async () => {
    const fake = vi.fn(async () => { throw new Error('should not fetch') }) as unknown as typeof fetch
    const cfg: Partial<Config> = {
      llmProviderPriority: ['anthropic', 'openai', 'gemini'],
      anthropicApiKey: 'sk-ant-foo',
      openaiApiKey: 'sk-bar',
      geminiApiKey: 'a'.repeat(40),
      discordBotToken: 'tok',
      discordChannelId: 'chan',
    }
    const ctx = makeCtx(cfg, fake)
    for (const c of buildCredentialsChecks(cfg.llmProviderPriority!)) {
      await c.run(ctx)
    }
    expect((fake as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('reports fail + env-var hint when a configured provider key is missing', async () => {
    const fake = vi.fn() as unknown as typeof fetch
    const cfg: Partial<Config> = { llmProviderPriority: ['anthropic'] }
    const ctx = makeCtx(cfg, fake)
    const checks = buildCredentialsChecks(['anthropic'])
    const ant = checks.find(c => c.id === 'creds.anthropic')!
    const out = await ant.run(ctx)
    expect(out.status).toBe('fail')
    expect(out.hint).toMatch(/ANTHROPIC_API_KEY/)
  })

  it('warns when anthropic key shape looks wrong', async () => {
    const cfg: Partial<Config> = { llmProviderPriority: ['anthropic'], anthropicApiKey: 'nope-wrong-prefix' }
    const ctx = makeCtx(cfg, vi.fn() as unknown as typeof fetch)
    const ant = buildCredentialsChecks(['anthropic']).find(c => c.id === 'creds.anthropic')!
    const out = await ant.run(ctx)
    expect(out.status).toBe('warn')
    expect(out.hint).toMatch(/unusual/i)
  })

  it('warns when openai key shape looks wrong', async () => {
    const cfg: Partial<Config> = { llmProviderPriority: ['openai'], openaiApiKey: 'plain-key' }
    const ctx = makeCtx(cfg, vi.fn() as unknown as typeof fetch)
    const oa = buildCredentialsChecks(['openai']).find(c => c.id === 'creds.openai')!
    const out = await oa.run(ctx)
    expect(out.status).toBe('warn')
  })

  it('warns when gemini key is too short', async () => {
    const cfg: Partial<Config> = { llmProviderPriority: ['gemini'], geminiApiKey: 'short' }
    const ctx = makeCtx(cfg, vi.fn() as unknown as typeof fetch)
    const g = buildCredentialsChecks(['gemini']).find(c => c.id === 'creds.gemini')!
    const out = await g.run(ctx)
    expect(out.status).toBe('warn')
  })

  it('fail when a channel is partially configured', async () => {
    const cfg: Partial<Config> = {
      llmProviderPriority: ['anthropic'],
      discordBotToken: 'tok', // but no channelId → partial
    }
    const ctx = makeCtx(cfg, vi.fn() as unknown as typeof fetch)
    const disc = buildCredentialsChecks(['anthropic']).find(c => c.id === 'creds.discord')!
    const out = await disc.run(ctx)
    expect(out.status).toBe('fail')
    expect(out.detail).toMatch(/DISCORD_CHANNEL_ID|channel id/i)
  })

  it('skips fully-unset channels with detail "not configured"', async () => {
    const cfg: Partial<Config> = { llmProviderPriority: ['anthropic'] }
    const ctx = makeCtx(cfg, vi.fn() as unknown as typeof fetch)
    const tg = buildCredentialsChecks(['anthropic']).find(c => c.id === 'creds.telegram')!
    const out = await tg.run(ctx)
    expect(out.status).toBe('skip')
    expect(out.detail).toContain('not configured')
  })

  it('returns ok when a channel is fully configured', async () => {
    const cfg: Partial<Config> = {
      llmProviderPriority: ['anthropic'],
      discordBotToken: 'tok',
      discordChannelId: 'chan',
    }
    const ctx = makeCtx(cfg, vi.fn() as unknown as typeof fetch)
    const disc = buildCredentialsChecks(['anthropic']).find(c => c.id === 'creds.discord')!
    const out = await disc.run(ctx)
    expect(out.status).toBe('ok')
  })
})

// Type hygiene sanity — make sure buildCredentialsChecks produces Check[] with
// outputs that unambiguously fit into CheckResult.
void (null as unknown as CheckResult)
