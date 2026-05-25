# Phase 43: End-to-End Smoke Test & Setup Docs - Pattern Map

**Mapped:** 2026-05-24
**Files analyzed:** 4 (1 new doc, 1 cross-link edit, 2 conditional code edits)
**Analogs found:** 4 / 4

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `docs/user-guide/home-assistant.md` | docs (operator guide) | n/a | `docs/user-guide/manual-uninstall.md` | exact (same taxonomy, D-07) |
| `docs/internals/channel-integrations.md` | docs (cross-link edit) | n/a | itself (lines 124–128) | exact (extend existing "Related docs" section) |
| `src/channels/home-assistant/router.ts` | config constant (bounded tuning, D-01) | request-response | itself (line 13) | exact (one-line constant change) |
| `src/channels/home-assistant/adapter.ts` | service (bounded tuning, D-01) | event-driven | itself (lines 104–141) + test analog `adapter.test.ts` Block D | exact (extend existing try block; test follows Block D pattern) |

---

## Pattern Assignments

---

### `docs/user-guide/home-assistant.md` (NEW — HADOC-01 operator guide)

**Analog:** `docs/user-guide/manual-uninstall.md`

**Style conventions extracted (full file, 42 lines):**

- H1 title: plain noun phrase, no leading emoji, no front-matter YAML block (the file starts directly with `# Manual Uninstall`)
- Intro paragraph: 1–3 sentences of plain prose immediately under H1, no section heading for the intro
- H2 sections: OS/platform or logical groupings; no H3 nesting in this file (deeper nesting is acceptable per `channel-integrations.md` which uses H3)
- Fenced code blocks: language tag always present (`bash`, `powershell`); copy-paste complete — no ellipsis or "..." placeholders inside blocks
- No screenshots, no emojis (the warning uses `⚠️` inline in bold prose, not as decoration — acceptable if used sparingly for genuine warnings)
- Inline bold for key terms / filenames (`**⚠️ `~/.shrok`**`)
- Cross-references: plain Markdown links in prose, not a "See also" section
- Tone: imperative ("Remove the install"), no "you should" hedging

**Exact heading/structure excerpt** (`docs/user-guide/manual-uninstall.md` lines 1–11):
```markdown
# Manual Uninstall

The uninstall scripts (...) are the recommended way to remove Shrok. If they won't run
for some reason, here's what they do so you can run the pieces by hand.

Installing Shrok places four things on your system:
- the install at `~/shrok`
- the workspace at `~/.shrok`
...

**⚠️ `~/.shrok` contains your memories, credentials, and conversation history. Once it's
gone, it's gone. Back it up first if you might want it later. ⚠️**

## macOS
```

**Fenced block pattern** (lines 15–20):
```bash
launchctl bootout "gui/$(id -u)/com.shrok.agent" 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.shrok.agent.plist
...
```
(complete, no omissions, language-tagged, immediately follows section heading with no preamble sentence)

**HADOC-01 must match this style:** H1 title → prose intro → H2 sections → fenced copy-paste blocks, no screenshots, imperative tone. RESEARCH.md § "HADOC-01 Operator Guide Structure" supplies the full required section list; copy the style from this file.

---

### `docs/internals/channel-integrations.md` (EDIT — cross-link only)

**Analog:** itself

**Target section** (lines 124–128 — the complete "Related docs" section):
```markdown
## Related docs

- [architecture.md](./architecture.md) — how adapters sit in the full message flow
- [mcp.md](./mcp.md) — MCP tool integration
```

**The edit:** append one line to this list. No other change. The new line must follow the same format as the existing entries: `- [filename.md](relative-path) — one-sentence description`.

**Exact line to append:**
```markdown
- [home-assistant.md](../user-guide/home-assistant.md) — operator setup guide for the HA voice integration (HACS, base URL, entity ID, Apache bypass)
```

**Anchor note:** The Apache `/v1` bypass snippet lives at lines 103–122 (the `### Apache /v1 auth-bypass configuration` subsection under `## Home Assistant`). The cross-link edit is at lines 124–128 only — the bypass subsection is not touched.

---

### `src/channels/home-assistant/router.ts` (POSSIBLE EDIT — D-01 bounded tuning only)

**Analog:** itself

**The only tunable constant** (lines 9–13):
```typescript
// Conservative internal deadline well below the device's ~5s firmware timeout.
// Exact tuning is a Phase-43 live-test concern.  Set conservatively to allow
// near-boundary replies to miss the HTTP slot and ride the Phase-42 announce path
// instead of racing a socket the device may have already abandoned.
export const REPLY_DEADLINE_MS = 3_000
```

**Style for any tuning:** change the numeric literal on line 13 only. The comment on lines 9–12 should be updated to reflect the new rationale if the value changes. No other lines in this file need touching for a deadline bump. The constant is `export const` (module-level, named export) — preserve the export keyword; `router.test.ts` imports it directly.

**How other module-level constants are defined in this file:** `REPLY_DEADLINE_MS` is the only module-level constant in `router.ts`. Compare to `adapter.ts` line 8 for the parallel pattern:
```typescript
const ANNOUNCE_TIMEOUT_MS = 30_000
```
(module-private, no export, numeric literal with underscore separator — same style, different visibility because the test file declares its own copy of `ANNOUNCE_TIMEOUT_MS` rather than importing it)

**Trip wire (from RESEARCH.md):** tune only if Scenario C shows the head regularly misses the 3s window. Safe ceiling: 4000 ms. Increment in 500 ms steps. Do not change if Scenario A+C confirm the deadline is met consistently.

---

### `src/channels/home-assistant/adapter.ts` (POSSIBLE EDIT — D-01 P6 busy-satellite skip only)

**Analog:** itself

**Announce call site where a P6 guard would attach** (lines 104–141, the full `announceOrStartConversation` private method):

The guard inserts inside the existing `try` block at `adapter.ts` lines 115–128, BEFORE the `fetch` call. The existing try/catch/finally structure must be preserved:

```typescript
private async announceOrStartConversation(text: string, wantsReply = false): Promise<void> {
  const token = process.env['HA_ACCESS_TOKEN']
  if (!token) {
    throw new Error('[home-assistant] HA_ACCESS_TOKEN is required for outbound announce — set it in .env')
  }
  const service = wantsReply ? 'start_conversation' : 'announce'
  const url = `${this.config.haBaseUrl}/api/services/assist_satellite/${service}`
  const body = JSON.stringify({ entity_id: this.config.haVoiceSatelliteEntityId, message: text })

  const ac = new AbortController()
  const timeout = setTimeout(() => ac.abort(), ANNOUNCE_TIMEOUT_MS)
  try {
    // ← P6 guard would attach HERE (before the fetch call):
    // const stateRes = await fetch(`${this.config.haBaseUrl}/api/states/${this.config.haVoiceSatelliteEntityId}`, { headers: { Authorization: `Bearer ${token}` } })
    // const stateData = await stateRes.json() as { state?: string }
    // if (stateData?.state !== 'idle') { log.info('[home-assistant] satellite not idle — skipping announce'); return }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: ac.signal,
    })
    if (!res.ok) {
      throw new Error(`[home-assistant] announce failed: HTTP ${res.status}`)
    }
    log.info(`[home-assistant] announce delivered via ${service} (${text.length} chars)`)
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      log.warn('[home-assistant] announce timed out after 30s (satellite stuck in RESPONDING?) — continuing')
      return
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}
```

**Logging idiom** (from this file): `log.info('[home-assistant] <past-tense description>')` and `log.warn('[home-assistant] <description>?')`. The `[home-assistant]` prefix is on every log call. Token value is NEVER passed to any `log.*` call (D-05, verified at lines 105–108 and 119).

**Trip wire (from RESEARCH.md):** add ONLY if the smoke test demonstrates an actual P6 collision. Do not add speculatively.

---

### `src/channels/home-assistant/adapter.test.ts` (test block to add IF P6 guard is implemented)

**Analog:** itself — Block D (lines 386–549), which covers the announce path

**Test block structure to follow for P6 "state != idle → skip" test:**

The new block belongs after Block D (after line 549). It follows the same `describe` + `beforeEach`/`afterEach` envelope as Block D:

```typescript
// ─── Block E: P6 busy-satellite skip ─────────────────────────────────────────

describe('HomeAssistantChannelAdapter — P6 busy-satellite skip', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    process.env['HA_INBOUND_API_KEY'] = TEST_INBOUND_KEY
    process.env['HA_ACCESS_TOKEN'] = TEST_HA_TOKEN
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    delete process.env['HA_INBOUND_API_KEY']
    delete process.env['HA_ACCESS_TOKEN']
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('skips announce and logs when satellite state is not idle', async () => {
    // First fetch: GET /api/states/... → state: 'responding'
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ state: 'responding' }), { status: 200 }))
    const adapter = makeAdapter()
    await expect(adapter.send('should be skipped')).resolves.toBeUndefined()
    // Only the state-check fetch was called; announce POST was NOT
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0]?.[0]).toMatch(/\/api\/states\//)
  })

  it('proceeds with announce when satellite state is idle', async () => {
    // First fetch: GET /api/states/... → state: 'idle'
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ state: 'idle' }), { status: 200 }))
    // Second fetch: POST /api/services/... → 200
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))
    const adapter = makeAdapter()
    await expect(adapter.send('go ahead')).resolves.toBeUndefined()
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})
```

**Key test idioms from Block D:**
- Constants `TEST_INBOUND_KEY`, `TEST_HA_TOKEN`, `TEST_BASE_URL`, `TEST_ENTITY_ID` (lines 10–13) — reuse these, do not duplicate
- `makeAdapter()` helper (lines 16–21) — always use this to construct the adapter
- `vi.stubGlobal('fetch', mockFetch)` + `vi.unstubAllGlobals()` in `afterEach` — required for fetch mocking
- `mockFetch.mock.calls[0]?.[0]` with optional chain + null-guard before access (required by `noUncheckedIndexedAccess`)

---

## Shared Patterns

### Docs style (applies to HADOC-01)
**Source:** `docs/user-guide/manual-uninstall.md` (entire file, 42 lines)
- No YAML front-matter
- H1 immediately followed by prose intro (no H2 for the intro)
- All code blocks are language-tagged and self-contained
- No screenshots
- Imperative tone

### Log prefix convention (applies to any D-01 code additions)
**Source:** `src/channels/home-assistant/adapter.ts` throughout
- Every `log.*` call uses `'[home-assistant]'` prefix as the first argument token
- Token values are NEVER embedded in log arguments (D-05)
- Use `log.info` for success/delivery confirmations, `log.warn` for timeouts/skip paths, `log.error` for unexpected rejections

### ENV_KEY_ALLOWLIST key names (reference for HADOC-01 `.env` block)
**Source:** `src/config.ts` lines 514–515
```typescript
  'HA_ACCESS_TOKEN',
  'HA_INBOUND_API_KEY',   // Phase 41: bearer key HA presents on /v1/* (D-02)
```
HADOC-01's `.env` copy-paste block must use exactly these key names.

### Test constant reuse (applies to any new test block in adapter.test.ts)
**Source:** `src/channels/home-assistant/adapter.test.ts` lines 8–21
```typescript
const ANNOUNCE_TIMEOUT_MS = 30_000
const TEST_INBOUND_KEY = 'test-inbound-key'
const TEST_HA_TOKEN = 'test-ha-token-12345678'
const TEST_BASE_URL = 'http://ha.test:8123'
const TEST_ENTITY_ID = 'assist_satellite.test_speaker'

function makeAdapter(id = 'home-assistant', headId = 'default') {
  return new HomeAssistantChannelAdapter(id, headId, {
    haBaseUrl: TEST_BASE_URL,
    haVoiceSatelliteEntityId: TEST_ENTITY_ID,
  })
}
```
New test blocks must reuse these — do not redeclare them.

---

## No Analog Found

None. Every file in scope has a direct in-codebase analog.

---

## Metadata

**Analog search scope:** `docs/user-guide/`, `docs/internals/`, `src/channels/home-assistant/`, `src/config.ts`
**Files read:** 6 (`manual-uninstall.md`, `channel-integrations.md`, `router.ts`, `adapter.ts`, `adapter.test.ts`, `config.ts` lines 508–520)
**Pattern extraction date:** 2026-05-24
