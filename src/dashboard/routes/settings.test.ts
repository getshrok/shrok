import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'
import type { Server } from 'node:http'
import { createSettingsRouter } from './settings.js'

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number }
      srv.close(() => resolve(addr.port))
    })
    srv.on('error', reject)
  })
}

describe('PUT /api/settings — channel hot-reload sentinels', () => {
  let workspace: string
  let envFile: string
  let server: Server
  let port: number

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-ws-'))
    envFile = path.join(workspace, '.env')
    fs.writeFileSync(envFile, [
      'DISCORD_BOT_TOKEN=existing-discord-token',
      'DISCORD_CHANNEL_ID=12345',
      'TELEGRAM_BOT_TOKEN=existing-telegram-token',
      'ZOHO_CLIQ_CHAT_ID=cliq-chat-1',
    ].join('\n') + '\n', 'utf8')

    const app = express()
    app.use(express.json())
    app.use((_req, res, next) => { res.locals['authenticated'] = true; next() })
    app.use('/api/settings', createSettingsRouter(workspace, envFile))

    port = await getFreePort()
    await new Promise<void>((resolve, reject) => {
      server = app.listen(port, '127.0.0.1', () => resolve())
      server.once('error', reject)
    })
  })

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()))
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  async function put(body: Record<string, unknown>): Promise<number> {
    const r = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return r.status
  }

  function exists(sentinel: string): boolean {
    return fs.existsSync(path.join(workspace, sentinel))
  }

  it('changing a discord field touches .reload-discord only', async () => {
    expect(await put({ discordChannelId: 'changed-channel' })).toBe(200)
    expect(exists('.reload-discord')).toBe(true)
    expect(exists('.reload-telegram')).toBe(false)
    expect(exists('.reload-slack')).toBe(false)
    expect(exists('.reload-whatsapp')).toBe(false)
    expect(exists('.reload-zoho-cliq')).toBe(false)
  })

  it('changing fields across two channels touches both sentinels', async () => {
    expect(await put({
      discordBotToken: 'new-token',
      slackBotToken: 'new-slack-token',
    })).toBe(200)
    expect(exists('.reload-discord')).toBe(true)
    expect(exists('.reload-slack')).toBe(true)
    expect(exists('.reload-telegram')).toBe(false)
  })

  it('submitting unchanged value does NOT touch the sentinel', async () => {
    expect(await put({ discordChannelId: '12345' })).toBe(200)  // same as before
    expect(exists('.reload-discord')).toBe(false)
  })

  it('clearing a channel cred (empty string) still touches sentinel', async () => {
    expect(await put({ discordBotToken: '' })).toBe(200)
    expect(exists('.reload-discord')).toBe(true)
  })

  it('non-channel field changes (accentColor) do NOT touch any sentinel', async () => {
    expect(await put({ accentColor: '#abcdef' })).toBe(200)
    expect(exists('.reload-discord')).toBe(false)
    expect(exists('.reload-telegram')).toBe(false)
    expect(exists('.reload-slack')).toBe(false)
    expect(exists('.reload-whatsapp')).toBe(false)
    expect(exists('.reload-zoho-cliq')).toBe(false)
  })

  it('zoho cliq fields touch .reload-zoho-cliq', async () => {
    expect(await put({ zohoClientId: 'abc', zohoCliqChatId: 'cliq-2' })).toBe(200)
    expect(exists('.reload-zoho-cliq')).toBe(true)
    // and the .env actually got updated
    const env = fs.readFileSync(envFile, 'utf8')
    expect(env).toContain('ZOHO_CLIENT_ID=abc')
    expect(env).toContain('ZOHO_CLIQ_CHAT_ID=cliq-2')
  })

  it('api key changes (anthropic) do NOT touch any reload sentinel', async () => {
    expect(await put({ anthropicApiKey: 'sk-ant-abc' })).toBe(200)
    for (const s of ['.reload-discord', '.reload-telegram', '.reload-slack', '.reload-whatsapp', '.reload-zoho-cliq']) {
      expect(exists(s), `${s} should not exist`).toBe(false)
    }
  })
})
