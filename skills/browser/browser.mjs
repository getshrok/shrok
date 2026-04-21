#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, unlinkSync, mkdirSync, openSync } from 'node:fs'
import { execSync, spawn } from 'node:child_process'
import { join } from 'node:path'

const SKILL_DIR = import.meta.dirname
const SESSION_FILE = join(SKILL_DIR, '.browser-session.json')
const SIDECAR_LOG = join(SKILL_DIR, '.browser-sidecar.log')

// Pin Playwright's browser cache to a skill-local directory so version drift in
// the global ~/.cache/ms-playwright folder can't trigger re-downloads on every
// run, and so the check below is cross-platform (no $HOME dependency).
const BROWSERS_DIR = join(SKILL_DIR, '.playwright-browsers')
process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_DIR

// ─── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs(args) {
  const opts = {}
  const positional = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2)
      opts[key] = args[++i]
    } else {
      positional.push(args[i])
    }
  }
  return { opts, positional }
}

const HELP = `Usage: browser.mjs <command> [options]

Most commands require an LLM API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, or
GEMINI_API_KEY). Deterministic commands (snapshot/click/type/press/scroll/
highlight/screenshot/close) do NOT need one.

Chromium's browser binary auto-installs on first run. On Linux, you may also
need its system libraries once — if the first run exits with code 127, run:
  sudo node node_modules/playwright-core/cli.js install-deps chromium

Two grounding modes, use either/both:

  (A) Semantic — hand the LLM a goal, let it decide:
      browse     --url <url> --task <instruction>                      Multi-step agent loop
      act        [--url <url>] --action <instruction>                  Single LLM-driven action
      extract    [--url <url>] --query <instruction> [--schema <json>] Data extraction

  (B) Deterministic — snapshot the page, target elements by ref:
      snapshot   [--url <url>]                                         AX-tree refs of interactive elements
      click      --ref <N>                                             Click element by ref
      type       --ref <N> --text <str>                                Type into element by ref
      press      --ref <N> --key <key>                                 Press key on element by ref
      scroll     [--ref <N>] [--direction up|down|top|bottom]          Scroll page or to element
      highlight  --ref <N> [--output <path>]                           Outline element for debugging

Shared:
  screenshot [--url <url>] --output <path>                             Capture page screenshot
  close                                                                Shut down browser session

IMPORTANT about refs: \`snapshot\` assigns refs via data-browser-ref attributes
in the live DOM. Refs stay valid as long as the page hasn't navigated. Any
click/type/press that triggers navigation INVALIDATES all refs — the response
will include { "navigated": true, "snapshot_invalidated": true }. Call
\`snapshot\` again before targeting elements on the new page.`

const [cmd, ...args] = process.argv.slice(2)

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(HELP)
  process.exit(0)
}

// ─── Post-help: deps required ─────────────────────────────────────────────────

// Auto-install npm dependencies on first run. Skill is shipped without
// node_modules/ — too large and platform-specific to ship.
if (!existsSync(join(SKILL_DIR, 'node_modules'))) {
  console.error('[browser] first run — installing npm dependencies…')
  execSync('npm install', { cwd: SKILL_DIR, stdio: 'inherit' })
}

// Auto-install Chromium via Playwright if not already cached in the skill-local
// browsers directory. Since we pinned playwright-core + PLAYWRIGHT_BROWSERS_PATH,
// the cached version stays in sync with the installed library and no longer
// re-downloads on every invocation.
if (!existsSync(BROWSERS_DIR)) mkdirSync(BROWSERS_DIR, { recursive: true })
const hasChromium = readdirSync(BROWSERS_DIR).some(d => d.startsWith('chromium-'))
if (!hasChromium) {
  console.error('[browser] first run — downloading Chromium…')
  execSync(`node ${join(SKILL_DIR, 'node_modules/playwright-core/cli.js')} install chromium`, {
    stdio: 'inherit',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS_DIR },
  })
}

// Kept in sync with the project's preferred model — update when the base repo
// moves. SHROK_LLM_PROVIDER + these defaults pair to produce a provider-prefixed
// model string for Stagehand. BROWSER_MODEL env overrides everything.
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929'
const DEFAULT_OPENAI_MODEL = 'gpt-4o'
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash'

function pickModel() {
  const override = process.env.BROWSER_MODEL
  if (override) {
    if (override.startsWith('anthropic/') || override.startsWith('openai/') || override.startsWith('google/')) return override
    if (process.env.ANTHROPIC_API_KEY) return `anthropic/${override}`
    if (process.env.OPENAI_API_KEY) return `openai/${override}`
    if (process.env.GEMINI_API_KEY) return `google/${override}`
  }
  const shrokProvider = process.env.SHROK_LLM_PROVIDER
  if (shrokProvider === 'anthropic' && process.env.ANTHROPIC_API_KEY) return `anthropic/${DEFAULT_ANTHROPIC_MODEL}`
  if (shrokProvider === 'openai' && process.env.OPENAI_API_KEY) return `openai/${DEFAULT_OPENAI_MODEL}`
  if (shrokProvider === 'gemini' && process.env.GEMINI_API_KEY) return `google/${DEFAULT_GEMINI_MODEL}`
  if (process.env.ANTHROPIC_API_KEY) return `anthropic/${DEFAULT_ANTHROPIC_MODEL}`
  if (process.env.OPENAI_API_KEY) return `openai/${DEFAULT_OPENAI_MODEL}`
  if (process.env.GEMINI_API_KEY) return `google/${DEFAULT_GEMINI_MODEL}`
  throw new Error('No LLM API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY.')
}

async function getOrCreateSession() {
  if (existsSync(SESSION_FILE)) {
    try {
      const session = JSON.parse(readFileSync(SESSION_FILE, 'utf8'))
      const resp = await fetch(`http://127.0.0.1:${session.port}/status`)
      if (resp.ok) {
        const status = await resp.json()
        return { cdpWsUrl: status.cdpWsUrl, sidecarPort: session.port }
      }
    } catch {
      try { unlinkSync(SESSION_FILE) } catch {}
    }
  }

  // Capture sidecar stdio to a log file so we can surface diagnostics if the
  // sidecar fails to write its session file in time (previously "Timed out
  // waiting for browser sidecar" was opaque — now we tail the log on failure).
  try { unlinkSync(SIDECAR_LOG) } catch {}
  const logFd = openSync(SIDECAR_LOG, 'a')
  const child = spawn(process.execPath, [join(SKILL_DIR, 'server.mjs')], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS_DIR },
  })
  child.unref()

  // 45s covers cold Chromium startup on slow disks / Windows where headless
  // launch + CDP port parsing can take 10–20s on first run.
  const deadline = Date.now() + 45000
  let lastErr = null
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300))
    if (existsSync(SESSION_FILE)) {
      try {
        const session = JSON.parse(readFileSync(SESSION_FILE, 'utf8'))
        const resp = await fetch(`http://127.0.0.1:${session.port}/status`)
        if (resp.ok) {
          const status = await resp.json()
          return { cdpWsUrl: status.cdpWsUrl, sidecarPort: session.port }
        }
      } catch (e) { lastErr = e }
    }
  }

  let logTail = ''
  try {
    const full = readFileSync(SIDECAR_LOG, 'utf8')
    logTail = full.split('\n').slice(-20).join('\n')
  } catch {}
  const detail = logTail ? `\n--- sidecar log (last 20 lines) ---\n${logTail}` : ''
  throw new Error(`Timed out waiting for browser sidecar to start${lastErr ? ` (last probe: ${lastErr.message})` : ''}${detail}`)
}

async function createStagehand(cdpWsUrl) {
  const { Stagehand } = await import('@browserbasehq/stagehand')
  const stagehand = new Stagehand({
    env: 'LOCAL',
    verbose: 0,
    model: pickModel(),
    localBrowserLaunchOptions: {
      cdpUrl: cdpWsUrl,
      headless: true,
      viewport: { width: 1280, height: 720 },
    },
  })
  await stagehand.init()
  return stagehand
}

/** Playwright-only browser attach — for commands that don't need an LLM. */
async function createRawBrowser(cdpWsUrl) {
  const { chromium } = await import('playwright-core')
  return await chromium.connectOverCDP(cdpWsUrl)
}

async function getRawPage(browser) {
  const contexts = browser.contexts()
  const context = contexts[0] ?? await browser.newContext()
  const pages = context.pages()
  return pages[0] ?? await context.newPage()
}

async function getStagehandPage(stagehand) {
  return await stagehand.context.activePage()
}

/** Detect if the page navigated during an action by comparing URLs. */
async function withNavDetection(page, fn) {
  const urlBefore = page.url()
  const result = await fn()
  // Give the page a tick to settle navigation if it's happening.
  await Promise.race([
    page.waitForLoadState('domcontentloaded', { timeout: 1500 }).catch(() => {}),
    new Promise(r => setTimeout(r, 100)),
  ])
  const urlAfter = page.url()
  const navigated = urlBefore !== urlAfter
  return { ...result, navigated, ...(navigated ? { snapshot_invalidated: true, url: urlAfter } : {}) }
}

// ─── Snapshot / ref-targeting helpers ─────────────────────────────────────────
//
// snapshot: walks the DOM, assigns data-browser-ref="<N>" to every interactive
// or landmark element, returns [{ref, role, name, value?, url?, type?}, ...].
// Refs are valid until the page navigates. Elements added after snapshot have
// no ref — call snapshot again after dynamic changes to get a fresh set.
//
// The script runs inside the page. Playwright's accessibility snapshot is
// role-based but doesn't preserve DOM identity; we walk the DOM directly so
// we can tag and later target by attribute selector.

const SNAPSHOT_SCRIPT = `(() => {
  // Remove any prior tags from earlier snapshots so ref numbers reset.
  for (const el of document.querySelectorAll('[data-browser-ref]')) {
    el.removeAttribute('data-browser-ref')
  }

  const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY', 'DETAILS'])
  const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'tab', 'menuitem', 'switch', 'searchbox'])

  function isVisible(el) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return false
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    return true
  }

  function accessibleName(el) {
    const aria = el.getAttribute('aria-label')
    if (aria) return aria.trim()
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const t = labelledBy.split(/\\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim()
      if (t) return t
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (el.labels?.[0]?.textContent) return el.labels[0].textContent.trim()
      if (el.placeholder) return el.placeholder
      if (el.name) return el.name
    }
    const text = (el.innerText || el.textContent || '').trim()
    if (text) return text.slice(0, 120)
    const title = el.getAttribute('title')
    if (title) return title
    return ''
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    switch (el.tagName) {
      case 'A': return el.href ? 'link' : ''
      case 'BUTTON': return 'button'
      case 'INPUT': {
        const t = (el.getAttribute('type') || 'text').toLowerCase()
        if (t === 'checkbox' || t === 'radio') return t
        if (t === 'submit' || t === 'button') return 'button'
        if (t === 'search') return 'searchbox'
        return 'textbox'
      }
      case 'TEXTAREA': return 'textbox'
      case 'SELECT': return 'combobox'
      case 'SUMMARY': return 'button'
      case 'DETAILS': return 'group'
      default: return ''
    }
  }

  function isInteresting(el) {
    if (INTERACTIVE_TAGS.has(el.tagName)) return true
    const role = el.getAttribute('role')
    if (role && INTERACTIVE_ROLES.has(role)) return true
    if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return true
    return false
  }

  const entries = []
  let nextRef = 1
  const all = document.querySelectorAll('*')
  for (const el of all) {
    if (!isInteresting(el) || !isVisible(el)) continue
    const ref = nextRef++
    el.setAttribute('data-browser-ref', String(ref))
    const entry = { ref, role: roleOf(el) || el.tagName.toLowerCase(), name: accessibleName(el) }
    if (el.tagName === 'A' && el.href) entry.url = el.href
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value) entry.value = el.value.slice(0, 120)
    if (el.tagName === 'INPUT') entry.type = (el.getAttribute('type') || 'text').toLowerCase()
    entries.push(entry)
  }
  return { url: location.href, title: document.title, count: entries.length, refs: entries }
})()`

async function snapshotPage(page) {
  return await page.evaluate(SNAPSHOT_SCRIPT)
}

function refLocator(page, ref) {
  return page.locator(`[data-browser-ref="${ref}"]`)
}

async function ensureRefExists(page, ref) {
  const count = await refLocator(page, ref).count()
  if (count === 0) throw new Error(`ref ${ref} not found — page may have navigated or re-rendered; call snapshot again`)
}

// ─── Command dispatch ─────────────────────────────────────────────────────────

try {
  const { opts } = parseArgs(args)

  switch (cmd) {

    case 'browse': {
      if (!opts.url || !opts.task) {
        console.error('Usage: browser.mjs browse --url <url> --task <instruction>')
        process.exit(1)
      }
      const session = await getOrCreateSession()
      const stagehand = await createStagehand(session.cdpWsUrl)
      try {
        const page = await getStagehandPage(stagehand)
        await page.goto(opts.url)
        const agent = stagehand.agent({ model: pickModel() })
        const result = await agent.execute({ instruction: opts.task, maxSteps: 20 })
        console.log(JSON.stringify({ success: result.completed ?? true, actions: result.actions?.length ?? 0, message: result.message ?? null }, null, 2))
      } finally {
        await stagehand.close()
      }
      break
    }

    case 'act': {
      if (!opts.action) {
        console.error('Usage: browser.mjs act [--url <url>] --action <instruction>')
        process.exit(1)
      }
      const session = await getOrCreateSession()
      const stagehand = await createStagehand(session.cdpWsUrl)
      try {
        if (opts.url) {
          const page = await getStagehandPage(stagehand)
          await page.goto(opts.url)
        }
        const result = await stagehand.act(opts.action)
        console.log(JSON.stringify(result, null, 2))
      } finally {
        await stagehand.close()
      }
      break
    }

    case 'extract': {
      if (!opts.query) {
        console.error('Usage: browser.mjs extract [--url <url>] --query <instruction> [--schema <json>]')
        process.exit(1)
      }
      const session = await getOrCreateSession()
      const stagehand = await createStagehand(session.cdpWsUrl)
      try {
        if (opts.url) {
          const page = await getStagehandPage(stagehand)
          await page.goto(opts.url)
        }
        let data
        if (opts.schema) {
          const { z } = await import('zod')
          const schemaDef = JSON.parse(opts.schema)
          const zodSchema = jsonToZod(schemaDef, z)
          data = await stagehand.extract(opts.query, zodSchema)
        } else {
          data = await stagehand.extract(opts.query)
        }
        console.log(JSON.stringify(data, null, 2))
      } finally {
        await stagehand.close()
      }
      break
    }

    case 'snapshot': {
      const session = await getOrCreateSession()
      const browser = await createRawBrowser(session.cdpWsUrl)
      try {
        const page = await getRawPage(browser)
        if (opts.url) await page.goto(opts.url)
        const data = await snapshotPage(page)
        console.log(JSON.stringify(data, null, 2))
      } finally {
        await browser.close()
      }
      break
    }

    case 'click': {
      if (!opts.ref) { console.error('Usage: browser.mjs click --ref <N>'); process.exit(1) }
      const session = await getOrCreateSession()
      const browser = await createRawBrowser(session.cdpWsUrl)
      try {
        const page = await getRawPage(browser)
        await ensureRefExists(page, opts.ref)
        const result = await withNavDetection(page, async () => {
          await refLocator(page, opts.ref).click()
          return { clicked: opts.ref }
        })
        console.log(JSON.stringify(result, null, 2))
      } finally {
        await browser.close()
      }
      break
    }

    case 'type': {
      if (!opts.ref || opts.text === undefined) { console.error('Usage: browser.mjs type --ref <N> --text <str>'); process.exit(1) }
      const session = await getOrCreateSession()
      const browser = await createRawBrowser(session.cdpWsUrl)
      try {
        const page = await getRawPage(browser)
        await ensureRefExists(page, opts.ref)
        const result = await withNavDetection(page, async () => {
          const loc = refLocator(page, opts.ref)
          await loc.fill(opts.text)
          return { typed: opts.ref, text: opts.text }
        })
        console.log(JSON.stringify(result, null, 2))
      } finally {
        await browser.close()
      }
      break
    }

    case 'press': {
      if (!opts.ref || !opts.key) { console.error('Usage: browser.mjs press --ref <N> --key <key>'); process.exit(1) }
      const session = await getOrCreateSession()
      const browser = await createRawBrowser(session.cdpWsUrl)
      try {
        const page = await getRawPage(browser)
        await ensureRefExists(page, opts.ref)
        const result = await withNavDetection(page, async () => {
          await refLocator(page, opts.ref).press(opts.key)
          return { pressed: opts.ref, key: opts.key }
        })
        console.log(JSON.stringify(result, null, 2))
      } finally {
        await browser.close()
      }
      break
    }

    case 'scroll': {
      const direction = (opts.direction ?? 'down').toLowerCase()
      const session = await getOrCreateSession()
      const browser = await createRawBrowser(session.cdpWsUrl)
      try {
        const page = await getRawPage(browser)
        if (opts.ref) {
          await ensureRefExists(page, opts.ref)
          await refLocator(page, opts.ref).scrollIntoViewIfNeeded()
          console.log(JSON.stringify({ scrolledTo: opts.ref }, null, 2))
        } else {
          await page.evaluate((dir) => {
            if (dir === 'top') window.scrollTo({ top: 0, behavior: 'instant' })
            else if (dir === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })
            else if (dir === 'up') window.scrollBy({ top: -window.innerHeight * 0.8, behavior: 'instant' })
            else window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'instant' })
          }, direction)
          console.log(JSON.stringify({ scrolled: direction }, null, 2))
        }
      } finally {
        await browser.close()
      }
      break
    }

    case 'highlight': {
      if (!opts.ref) { console.error('Usage: browser.mjs highlight --ref <N> [--output <path>]'); process.exit(1) }
      const outputPath = opts.output ?? join(SKILL_DIR, `.highlight-${opts.ref}.png`)
      const session = await getOrCreateSession()
      const browser = await createRawBrowser(session.cdpWsUrl)
      try {
        const page = await getRawPage(browser)
        await ensureRefExists(page, opts.ref)
        await page.evaluate((ref) => {
          const el = document.querySelector(`[data-browser-ref="${ref}"]`)
          if (!el) return
          el.__savedOutline = el.style.outline
          el.__savedOutlineOffset = el.style.outlineOffset
          el.style.outline = '3px solid red'
          el.style.outlineOffset = '2px'
        }, opts.ref)
        await refLocator(page, opts.ref).scrollIntoViewIfNeeded()
        await page.screenshot({ path: outputPath })
        await page.evaluate((ref) => {
          const el = document.querySelector(`[data-browser-ref="${ref}"]`)
          if (!el) return
          el.style.outline = el.__savedOutline ?? ''
          el.style.outlineOffset = el.__savedOutlineOffset ?? ''
        }, opts.ref)
        console.log(JSON.stringify({ ref: opts.ref, path: outputPath }, null, 2))
      } finally {
        await browser.close()
      }
      break
    }

    case 'screenshot': {
      if (!opts.output) {
        console.error('Usage: browser.mjs screenshot [--url <url>] --output <path>')
        process.exit(1)
      }
      const session = await getOrCreateSession()
      const browser = await createRawBrowser(session.cdpWsUrl)
      try {
        const page = await getRawPage(browser)
        if (opts.url) await page.goto(opts.url)
        await page.screenshot({ path: opts.output })
        console.log(JSON.stringify({ path: opts.output }, null, 2))
      } finally {
        await browser.close()
      }
      break
    }

    case 'close': {
      if (existsSync(SESSION_FILE)) {
        try {
          const session = JSON.parse(readFileSync(SESSION_FILE, 'utf8'))
          await fetch(`http://127.0.0.1:${session.port}/close`, { method: 'POST' })
          console.log(JSON.stringify({ closed: true }))
        } catch {
          try { unlinkSync(SESSION_FILE) } catch {}
          console.log(JSON.stringify({ closed: true, note: 'session was already dead' }))
        }
      } else {
        console.log(JSON.stringify({ closed: true, note: 'no active session' }))
      }
      break
    }

    default:
      console.error(`Unknown command: ${cmd}. Run browser.mjs --help`)
      process.exit(1)
  }
} catch (err) {
  console.error(JSON.stringify({ error: err.message }))
  process.exit(1)
}

/** Convert a simple JSON schema object to a Zod schema. */
function jsonToZod(schema, z) {
  if (schema.type === 'array') return z.array(jsonToZod(schema.items ?? { type: 'string' }, z))
  if (schema.type === 'object' && schema.properties) {
    const shape = {}
    for (const [key, val] of Object.entries(schema.properties)) shape[key] = jsonToZod(val, z)
    return z.object(shape)
  }
  switch (schema.type) {
    case 'number': return z.number()
    case 'boolean': return z.boolean()
    default: return z.string()
  }
}
