import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as clack from '@clack/prompts'
import {
  buildEnvFile,
  readExistingEnv,
  runSetup,
  SetupCancelledError,
  type SetupDeps,
  type SetupPaths,
} from './setup/index.js'

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('@clack/prompts', () => ({
  intro:        vi.fn(),
  outro:        vi.fn(),
  note:         vi.fn(),
  cancel:       vi.fn(),
  spinner:      vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  isCancel:     vi.fn(() => false),
  select:       vi.fn(),
  multiselect:  vi.fn(),
  text:         vi.fn(),
  password:     vi.fn(),
  confirm:      vi.fn(),
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ENV_EXAMPLE = `# Shrok
LLM_PROVIDER=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
OPENAI_API_KEY=
DISCORD_BOT_TOKEN=
DISCORD_CHANNEL_ID=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
EMBEDDING_PROVIDER=
EMBEDDING_API_KEY=
SEARCH_PROVIDER=
TAVILY_API_KEY=
BRAVE_API_KEY=
WEBHOOK_SECRET=
`

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-setup-'))
  // Seed .env.example template
  fs.writeFileSync(path.join(dir, '.env.example'), ENV_EXAMPLE, 'utf8')
  // Seed identity dir so SYSTEM.md creation path works
  return dir
}

function makeFetchMock(innerMock?: (...args: unknown[]) => Promise<unknown>) {
  return vi.fn(async (url: string | URL, ...rest: unknown[]) => {
    const urlStr = typeof url === 'string' ? url : url.toString()
    if (urlStr.includes('api.github.com')) {
      return {
        ok: true,
        json: async () => [
          { name: 'email', type: 'dir' },
          { name: 'calendar', type: 'dir' },
        ],
      }
    }
    if (urlStr.includes('raw.githubusercontent.com')) {
      const skillName = urlStr.includes('/email/') ? 'email' : 'calendar'
      return {
        ok: true,
        text: async () => `---\nname: ${skillName}\ndescription: A test skill\n---\n`,
      }
    }
    if (innerMock) return innerMock(url, ...rest)
    return {
      ok: true,
      json: async () => ({ username: 'TestBot', discriminator: '0', name: 'general' }),
    }
  }) as unknown as typeof fetch
}

function makeDeps(tmpDir: string, overrides: Partial<SetupDeps> = {}): SetupDeps {
  const paths: SetupPaths = {
    root: tmpDir,
    envFile: path.join(tmpDir, '.env'),
    envExample: path.join(tmpDir, '.env.example'),
    workspacePath: path.join(tmpDir, 'workspace'),
    workspaceConfig: path.join(tmpDir, 'workspace', 'config.json'),
    skillsDir: path.join(tmpDir, 'workspace', 'skills'),
  }
  return {
    paths,
    execSync: vi.fn(),   // success by default (LLM key check passes)
    spawn: vi.fn().mockReturnValue({ unref: vi.fn() }),
    fetch: makeFetchMock(),
    ...overrides,
  }
}

// WizardResponses maps high-level intent to mock return values.
// Tests declare *what* the user picks, not which call index returns it.
interface WizardResponses {
  // Section 1 — LLM
  llmProvider?: string
  apiKey?: string
  llmRetryDecision?: 'retry' | 'skip'
  retryApiKey?: string
  // Section 2 — Channels
  channels?: string[]
  confirmNoChannels?: boolean   // fires when channels=[], default: true (continue anyway)
  retryChannels?: string[]      // second pick if confirmNoChannels=false
  discordToken?: string
  discordChannelId?: string
  discordRetryDecision?: 'retry' | 'skip'
  retryDiscordToken?: string
  retryDiscordChannelId?: string
  telegramToken?: string
  telegramChatId?: string
  // Section 3 — Search
  searchProvider?: string
  searchApiKey?: string
  searchRetryDecision?: 'retry' | 'skip'
  retrySearchApiKey?: string
  // Section 4 — Skills
  skills?: string[]
  // Section 5 — Dashboard
  dashboardPassword?: string
  // (Webhook section removed — coming soon)
  // Risk warning — always fires first
  confirmRisk?: boolean          // default: true
  // Save / start
  confirmSave?: boolean
  startNow?: boolean
  // Re-run: only fires when existing config files are present
  confirmReconfigure?: boolean
}

/**
 * Wires all clack mock functions based on named intent.
 * Retry decisions are inserted into the queue in the correct position
 * relative to the normal flow. Adding a new prompt only requires
 * adding a default here — no tests need positional updates.
 */
function queueResponses(r: WizardResponses = {}): void {
  const channels = r.channels ?? []
  const effectiveChannels = channels
  const llmProvider = r.llmProvider ?? 'anthropic'
  const searchProvider = r.searchProvider ?? 'none'

  // ── select ─────────────────────────────────────────────────────────────────
  // Actual call order in the wizard:
  //   1. llmProvider        (section 1)
  //   2. llmRetryDecision?  (section 1 retry loop, only when execSync throws)
  //   3. chosenChannel      (section 2 — single channel, or 'none')
  //   4. discordRetryDecision?  (section 2, only when discord + fetch fails)
  //   5. searchProvider     (section 3)
  //   6. searchRetryDecision?  (section 3 retry)
  //   7. skills install     (section 4 — toggle loop, __install__ to advance)
  vi.mocked(clack.select).mockResolvedValueOnce(llmProvider)
  if (r.llmRetryDecision) {
    vi.mocked(clack.select).mockResolvedValueOnce(r.llmRetryDecision)
  }
  vi.mocked(clack.select).mockResolvedValueOnce(effectiveChannels[0] ?? 'none')
  if (effectiveChannels.includes('discord') && r.discordRetryDecision) {
    vi.mocked(clack.select).mockResolvedValueOnce(r.discordRetryDecision)
  }
  vi.mocked(clack.select).mockResolvedValueOnce(searchProvider)
  if (searchProvider !== 'none' && r.searchRetryDecision) {
    vi.mocked(clack.select).mockResolvedValueOnce(r.searchRetryDecision)
  }

  // ── password ───────────────────────────────────────────────────────────────
  // Order: apiKey → [retryApiKey?] → [discordToken?] → [retryDiscordToken?]
  //        → [slackBotToken?] → [slackAppToken?] → [telegramToken?]
  //        → [searchKey?] → [retrySearchKey?] → dashPw → dashPwConfirm
  vi.mocked(clack.password).mockResolvedValueOnce(r.apiKey ?? 'sk-test')
  if (r.llmRetryDecision === 'retry') {
    vi.mocked(clack.password).mockResolvedValueOnce(r.retryApiKey ?? 'sk-retry')
  }
  if (effectiveChannels.includes('discord')) {
    vi.mocked(clack.password).mockResolvedValueOnce(r.discordToken ?? 'discord-token')
    if (r.discordRetryDecision === 'retry') {
      vi.mocked(clack.password).mockResolvedValueOnce(r.retryDiscordToken ?? 'discord-token-2')
    }
  }
  if (effectiveChannels.includes('telegram')) {
    vi.mocked(clack.password).mockResolvedValueOnce(r.telegramToken ?? 'tg-token')
  }
  if (searchProvider !== 'none') {
    vi.mocked(clack.password).mockResolvedValueOnce(r.searchApiKey ?? 'search-key')
    if (r.searchRetryDecision === 'retry') {
      vi.mocked(clack.password).mockResolvedValueOnce(r.retrySearchApiKey ?? 'search-key-2')
    }
  }
  // Dashboard password: pw + confirm (always prompted)
  vi.mocked(clack.password).mockResolvedValueOnce(r.dashboardPassword ?? 'testpassword')
  vi.mocked(clack.password).mockResolvedValueOnce(r.dashboardPassword ?? 'testpassword')

  // ── text ───────────────────────────────────────────────────────────────────
  // Order: [discordChannelId?] → [retryDiscordChannelId?] → [telegramChatId?]
  if (effectiveChannels.includes('discord')) {
    vi.mocked(clack.text).mockResolvedValueOnce(r.discordChannelId ?? '111222333444555666')
    if (r.discordRetryDecision === 'retry') {
      vi.mocked(clack.text).mockResolvedValueOnce(r.retryDiscordChannelId ?? '444555666777888999')
    }
  }
  if (effectiveChannels.includes('telegram')) {
    vi.mocked(clack.text).mockResolvedValueOnce(r.telegramChatId ?? '987654321')
  }

  // ── confirm ────────────────────────────────────────────────────────────────
  // Order: confirmRisk → [confirmReconfigure?] → confirmSave → [startNow?]
  vi.mocked(clack.confirm).mockResolvedValueOnce(r.confirmRisk ?? true)
  if (r.confirmReconfigure !== undefined) {
    vi.mocked(clack.confirm).mockResolvedValueOnce(r.confirmReconfigure)
  }
  vi.mocked(clack.confirm).mockResolvedValueOnce(r.confirmSave ?? true)
  if (r.confirmSave !== false) {
    vi.mocked(clack.confirm).mockResolvedValueOnce(r.startNow ?? false)
  }
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

let tmpDir: string

beforeEach(() => {
  tmpDir = makeTmpDir()
  vi.clearAllMocks()
  vi.mocked(clack.isCancel).mockImplementation(() => false)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ─── Pure unit tests ──────────────────────────────────────────────────────────

describe('buildEnvFile', () => {
  it('substitutes a known key', () => {
    const tmpl = 'ANTHROPIC_API_KEY=\nDISCORD_BOT_TOKEN=\n'
    expect(buildEnvFile(tmpl, { ANTHROPIC_API_KEY: 'sk-x' })).toContain('ANTHROPIC_API_KEY=sk-x')
  })

  it('leaves unspecified keys blank', () => {
    const tmpl = 'ANTHROPIC_API_KEY=\nDISCORD_BOT_TOKEN=\n'
    const result = buildEnvFile(tmpl, { ANTHROPIC_API_KEY: 'sk-x' })
    expect(result).toContain('DISCORD_BOT_TOKEN=')
    expect(result).not.toContain('DISCORD_BOT_TOKEN=sk')
  })

  it('leaves comment lines untouched', () => {
    const tmpl = '# comment\nANTHROPIC_API_KEY=\n'
    expect(buildEnvFile(tmpl, { ANTHROPIC_API_KEY: 'val' })).toContain('# comment')
  })

  it('does not inject keys not present in template', () => {
    const tmpl = 'ANTHROPIC_API_KEY=\n'
    const result = buildEnvFile(tmpl, { ANTHROPIC_API_KEY: 'val', ROGUE_KEY: 'evil' })
    expect(result).not.toContain('ROGUE_KEY')
  })
})

describe('readExistingEnv', () => {
  it('parses key=value pairs', () => {
    expect(readExistingEnv('FOO=bar\nBAZ=qux\n')).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('handles values containing =', () => {
    expect(readExistingEnv('KEY=a=b=c\n')).toEqual({ KEY: 'a=b=c' })
  })

  it('skips blank lines and comments', () => {
    expect(readExistingEnv('# comment\n\nFOO=bar\n')).toEqual({ FOO: 'bar' })
  })

  it('returns empty object for empty string', () => {
    expect(readExistingEnv('')).toEqual({})
  })
})

// ─── Integration tests ────────────────────────────────────────────────────────

describe('runSetup', () => {
  it('happy path: saves .env and config.json', async () => {
    queueResponses({ llmProvider: 'anthropic', apiKey: 'sk-ant-test' })
    const deps = makeDeps(tmpDir)
    const result = await runSetup(deps)

    expect(result.aborted).toBe(false)
    expect(result.secrets['ANTHROPIC_API_KEY']).toBe('sk-ant-test')
    expect(result.secrets['LLM_PROVIDER']).toBe('anthropic')

    const envContent = fs.readFileSync(deps.paths.envFile, 'utf8')
    expect(envContent).toContain('ANTHROPIC_API_KEY=sk-ant-test')
    expect(envContent).toContain('LLM_PROVIDER=anthropic')
  })

  it('LLM key retry: prompts for new key and retries validation', async () => {
    queueResponses({ llmRetryDecision: 'retry', retryApiKey: 'sk-good' })
    const execSync = vi.fn()
      .mockImplementationOnce(() => { throw Object.assign(new Error('fail'), { stderr: Buffer.from('invalid key') }) })
      .mockImplementationOnce(() => { /* success */ })

    const result = await runSetup(makeDeps(tmpDir, { execSync }))

    expect(execSync).toHaveBeenCalledTimes(2)
    expect(result.secrets['ANTHROPIC_API_KEY']).toBe('sk-good')
  })

  it('LLM key failure: skip continues with unvalidated key', async () => {
    queueResponses({ llmRetryDecision: 'skip' })
    const execSync = vi.fn().mockImplementation(() => { throw new Error('fail') })

    const result = await runSetup(makeDeps(tmpDir, { execSync }))
    expect(result.aborted).toBe(false)
  })

  it('Discord verify + retry: re-prompts and uses new credentials', async () => {
    queueResponses({
      channels: ['discord'],
      discordToken: 'bad-token',
      discordRetryDecision: 'retry',
      retryDiscordToken: 'good-token',
      retryDiscordChannelId: '999888777',
    })

    const mockFetch = vi.fn()
      // First verification attempt: token invalid
      .mockResolvedValueOnce({ ok: false, status: 401 } as Response)
      // Retry: both /users/@me and /channels succeed
      .mockResolvedValueOnce({ ok: true, json: async () => ({ username: 'Bot', discriminator: '0' }) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ name: 'general' }) } as unknown as Response)
      // Embedding key check (openai, separate from anthropic LLM)
      .mockResolvedValueOnce({ ok: true } as Response)

    const result = await runSetup(makeDeps(tmpDir, { fetch: makeFetchMock(mockFetch) }))

    expect(result.secrets['DISCORD_BOT_TOKEN']).toBe('good-token')
    expect(result.secrets['DISCORD_CHANNEL_ID']).toBe('999888777')
  })

  it('Discord verify: skip continues with unverified credentials', async () => {
    queueResponses({
      channels: ['discord'],
      discordToken: 'unverified-token',
      discordRetryDecision: 'skip',
    })
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401 } as Response)
      // Embedding key check fires after Discord section
      .mockResolvedValueOnce({ ok: true } as Response)

    const result = await runSetup(makeDeps(tmpDir, { fetch: makeFetchMock(mockFetch) }))

    expect(result.aborted).toBe(false)
    expect(result.secrets['DISCORD_BOT_TOKEN']).toBe('unverified-token')
  })

  it('search key retry: re-prompts and uses new key', async () => {
    queueResponses({ searchProvider: 'tavily', searchRetryDecision: 'retry', retrySearchApiKey: 'search-good' })
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 403 } as Response)  // search check fails
      .mockResolvedValueOnce({ ok: true } as Response)                 // search check passes on retry

    const result = await runSetup(makeDeps(tmpDir, { fetch: makeFetchMock(mockFetch) }))

    expect(result.aborted).toBe(false)
    expect(result.secrets['TAVILY_API_KEY']).toBe('search-good')
  })

  it('search key skip: continues with unverified key', async () => {
    queueResponses({ searchProvider: 'tavily', searchRetryDecision: 'skip' })
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 403 } as Response)  // search check fails → user skips

    const result = await runSetup(makeDeps(tmpDir, { fetch: makeFetchMock(mockFetch) }))

    expect(result.aborted).toBe(false)
    expect(result.secrets['TAVILY_API_KEY']).toBe('search-key')
  })

  it('abort at save: returns aborted and does not write files', async () => {
    queueResponses({ confirmSave: false })
    const deps = makeDeps(tmpDir)

    const result = await runSetup(deps)

    expect(result.aborted).toBe(true)
    expect(fs.existsSync(deps.paths.envFile)).toBe(false)
    expect(fs.existsSync(deps.paths.workspaceConfig)).toBe(false)
  })

  it('no channels: completes without channel secrets', async () => {
    queueResponses({ channels: [] })
    const result = await runSetup(makeDeps(tmpDir))

    expect(result.aborted).toBe(false)
    expect(result.secrets['DISCORD_BOT_TOKEN']).toBeUndefined()
    expect(result.secrets['TELEGRAM_BOT_TOKEN']).toBeUndefined()
  })

  it('risk warning declined: returns aborted without prompting further', async () => {
    vi.mocked(clack.confirm).mockResolvedValueOnce(false)  // confirmRisk = false
    const deps = makeDeps(tmpDir)
    const result = await runSetup(deps)

    expect(result.aborted).toBe(true)
    // Only the risk confirm should have fired — no selects, no passwords
    expect(clack.select).not.toHaveBeenCalled()
    expect(clack.password).not.toHaveBeenCalled()
  })

  it('cancel: throws SetupCancelledError', async () => {
    const CANCEL_SYMBOL = Symbol('clack-cancel')
    vi.mocked(clack.isCancel).mockImplementation(v => v === CANCEL_SYMBOL)
    vi.mocked(clack.confirm).mockResolvedValueOnce(true)  // confirmRisk passes — wizard must reach the select
    vi.mocked(clack.select).mockResolvedValueOnce(CANCEL_SYMBOL as unknown as string)

    await expect(runSetup(makeDeps(tmpDir))).rejects.toThrow(SetupCancelledError)
    expect(clack.cancel).toHaveBeenCalledWith('Setup cancelled.')
  })

  it('re-run with existing config: prompts for reconfigure and preserves existing values as defaults', async () => {
    // Pre-seed existing config
    const existingEnvContent = 'LLM_PROVIDER=anthropic\nANTHROPIC_API_KEY=sk-existing\n'
    fs.writeFileSync(path.join(tmpDir, '.env'), existingEnvContent, 'utf8')
    fs.mkdirSync(path.join(tmpDir, 'workspace'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, 'workspace', 'config.json'),
      JSON.stringify({}),
      'utf8',
    )

    queueResponses({
      confirmReconfigure: true,
      llmProvider: 'anthropic',
      apiKey: '',           // user hits enter without changing — should preserve existing
      confirmSave: true,
    })

    const deps = makeDeps(tmpDir)
    const result = await runSetup(deps)

    expect(result.aborted).toBe(false)
    // Existing key preserved when user submits empty string
    expect(result.secrets['ANTHROPIC_API_KEY']).toBe('sk-existing')

    // Now test that a changed value overwrites
    vi.clearAllMocks()
    vi.mocked(clack.isCancel).mockImplementation(() => false)
    queueResponses({ confirmReconfigure: true, llmProvider: 'anthropic', apiKey: 'sk-new', confirmSave: true })
    const result2 = await runSetup(makeDeps(tmpDir))
    expect(result2.secrets['ANTHROPIC_API_KEY']).toBe('sk-new')
  })

})
