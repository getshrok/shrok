---
phase: quick-260526-mdd
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/util/model-time.ts
  - src/util/model-time.test.ts
  - src/sub-agents/registry.ts
  - src/sub-agents/registry.test.ts
  - src/head/index.ts
  - AGENTS.md
autonomous: true
requirements:
  - QUICK-260526-MDD: "Stop exposing models to UTC (issue #18)"

must_haves:
  truths:
    - "No model-facing tool input description in registry.ts or head/index.ts contains a `Z`-suffixed example or the literal text `ISO`/`UTC` as a format prescription."
    - "create_reminder.triggerAt, create_schedule.runAt, update_schedule.runAt, and get_usage.since (both copies in registry.ts AND head/index.ts) accept the canonical `YYYY-MM-DD HH:MM` workspace-local format and reject any string containing `Z`, `+HH:MM`, `-HH:MM`, or an IANA suffix token."
    - "When the agent supplies a parsed time more than 30 seconds in the past, the tool returns a structured error string containing BOTH the parsed local time and the workspace `now` (in canonical format) and the literal phrase `pick a time in the future`."
    - "list_schedules, list_reminders, and get_file_info output JSON renders every time field via formatModelTime — no `Z`, no `T` separator, no numeric offset in any time value."
    - "parseModelTime throws on the spring-forward gap (non-existent local time) and picks the FIRST occurrence on fall-back ambiguous times, documented in its JSDoc."
    - "AGENTS.md contains a subsection titled `Model-facing time invariant (no UTC ever reaches the model)` naming the canonical format and the two helpers."
  artifacts:
    - path: "src/util/model-time.ts"
      provides: "formatModelTime, parseModelTime, formatPastTimeError"
      exports: ["formatModelTime", "parseModelTime", "formatPastTimeError"]
    - path: "src/util/model-time.test.ts"
      provides: "Round-trip, rejection, DST, and past-time-error coverage"
      contains: "describe('parseModelTime'"
    - path: "src/sub-agents/registry.ts"
      provides: "4 rewritten input descriptions + parse/guard at each tool boundary + 3 fixed output renderers"
    - path: "src/sub-agents/registry.test.ts"
      provides: "Sentinel tests that grep descriptions for `Z\"` (count must be 0), assert Z-input rejection through each execute() path, assert output renderers emit no `T`/`Z`/offset, and assert past-time guard message shape."
    - path: "src/head/index.ts"
      provides: "Duplicate get_usage.since description rewritten in matching canonical form (line 97)"
    - path: "AGENTS.md"
      provides: "Invariant subsection documenting the boundary rule and helpers"
      contains: "Model-facing time invariant"
  key_links:
    - from: "src/sub-agents/registry.ts (create_reminder.execute)"
      to: "src/util/model-time.ts (parseModelTime, formatPastTimeError)"
      via: "import { parseModelTime, formatPastTimeError } from '../util/model-time.js'"
      pattern: "parseModelTime\\("
    - from: "src/sub-agents/registry.ts (list_schedules, list_reminders, get_file_info)"
      to: "src/util/model-time.ts (formatModelTime)"
      via: "import { formatModelTime } from '../util/model-time.js'"
      pattern: "formatModelTime\\("
---

<objective>
Close GitHub issue #18 (`create_reminder` UTC bug) by enforcing a project invariant:
no model-facing surface in shrok ever shows or accepts a UTC instant. All model↔time
boundaries render and parse the canonical workspace-local format `YYYY-MM-DD HH:MM`
(24-hour, no `Z`, no offset, no IANA suffix in the value).

Purpose: Models reliably mis-handle UTC↔local conversion. The current
`create_reminder.triggerAt` description literally says `"2026-04-01T09:00:00Z"`, which
trains the LLM to hand back a `Z`-suffixed instant interpreted as the user's local clock
time — the documented bug. The fix is structural: rewrite every model-facing description
to demand the canonical local format, parse it through a single chokepoint helper, render
all model-facing outputs through a paired formatter, and guard against past-time inputs.

Output:
- `src/util/model-time.ts` (new helper module, the single chokepoint)
- `src/util/model-time.test.ts` (TDD coverage for round-trip, rejection, DST, past-time)
- Edits to `src/sub-agents/registry.ts` (4 inputs + 3 outputs)
- Edit to `src/head/index.ts` (duplicate `get_usage.since` description)
- Edits to `src/sub-agents/registry.test.ts` (sentinel + boundary tests)
- New invariant subsection in `AGENTS.md`
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/home/thenasty/shrok/AGENTS.md
@/home/thenasty/shrok/src/util/time.ts
@/home/thenasty/shrok/src/sub-agents/registry.ts
@/home/thenasty/shrok/src/head/index.ts
@/home/thenasty/shrok/src/head/assembler.ts
@/home/thenasty/shrok/src/scheduler/cron.ts

<interfaces>
<!-- Anchors extracted from the read pass. Use these directly — do not re-grep. -->

From src/util/time.ts (mirror the safeZone fallback shape, do NOT modify this file):
- export function formatIanaTimeLine(date: Date, tz: string): string
- export function formatInTz(iso: string | Date, tz: string, opts?: {...}): string
- internal: function safeZone(tz: string): string  // catches invalid IANA → 'UTC'

From src/sub-agents/registry.ts — model-facing surfaces:
- GET_USAGE_DEF (lines ~715-724): inputSchema.properties.since.description currently
  says `'ISO timestamp to filter from (e.g. "2026-04-15T00:00:00Z" for today UTC). Omit for all-time.'`
- buildUsageTool() execute() at line 729: reads `input['since']` and passes straight to
  `usageStore.getSummary(since)`. Must parse via parseModelTime first, then convert to
  ISO before handing to the store. Echoes `since ?? 'all-time'` in the JSON response —
  that echo must also be the canonical local string, not the raw input.
- buildScheduleTools(scheduleStore, timezone, …) at line 745: closure has `timezone` —
  use it as the `tz` arg to parseModelTime/formatModelTime/formatPastTimeError.
- create_schedule inputSchema.properties.runAt (line 773): currently
  `'ISO datetime for one-time schedules.'` — rewrite + parse in execute() (line 807,
  `const runAtArg = input['runAt']`). The store ultimately receives ISO (line 823:
  `createOpts.runAt = runAtArg`) — keep that internal ISO storage; just convert at the
  boundary.
- update_schedule inputSchema.properties.runAt (line 840): currently bare
  `{ type: 'string' }` — add canonical-format description + parse in execute() (line 880,
  `patch.runAt = input['runAt'] as string`).
- list_schedules execute() at line 758: currently
  `JSON.stringify(scheduleStore.list())` — wrap with a mapper that converts `runAt`,
  `nextRun`, `createdAt` (and any other time field on the stored row) via formatModelTime.
- list_reminders mapper at line 924: currently echoes raw `runAt`, `createdAt`, etc. —
  same treatment (convert each time field via formatModelTime). buildReminderTools()
  also receives the `timezone` closure at line 911.
- create_reminder inputSchema.properties.triggerAt (lines 948-951): the headline bug —
  description literally `'... ISO 8601 datetime (e.g. "2026-04-01T09:00:00Z")...'`.
  Rewrite + parse in execute() at lines 1058-1062 (when `cronArg && triggerAtArg`) AND
  lines 1074-1078 (when only `triggerAtArg`). Both call sites currently do
  `new Date(triggerAtArg)` + `isNaN` check — replace with parseModelTime + past-time
  guard. Internal `triggerAt = d.toISOString()` storage stays.
- executeGetFileInfo (lines 625-638): returns
  `created: stat.birthtime.toISOString(), modified: stat.mtime.toISOString(),
   accessed: stat.atime.toISOString()`. These are model-facing — convert via
  formatModelTime. Needs the workspace `timezone` — note executeGetFileInfo is currently
  called from the OPTIONAL_TOOLS map (line 705) as
  `execute: async (input, _ctx) => executeGetFileInfo(input)`. The agent `ctx` has access
  to config; thread `timezone` through executeGetFileInfo's signature
  (`executeGetFileInfo(input, timezone)`) and read it from `ctx` at the call site, OR
  read it from a module-level config accessor if one already exists for OPTIONAL_TOOLS.
  Inspect the surrounding registry to pick whichever matches existing conventions; do not
  introduce a new accessor pattern if one already exists.

From src/head/index.ts — model-facing surface (DUPLICATE of registry.ts get_usage):
- Line 91-100: HeadTool definition with `name: 'get_usage'` whose
  `since.description` literally repeats `'ISO timestamp to filter from (e.g.
  "2026-04-15T00:00:00Z" for today UTC). Omit for all-time.'`. Rewrite identically.
- Line 395: `nextRunAfter(schedule.cron, new Date(), tz).toISOString()` — this is the
  WRITE path into `scheduleStore.update(..., { nextRun: resumeAt })`. INTERNAL storage
  only; not model-facing. DO NOT TOUCH.

From src/head/assembler.ts — verify-only (line 178-179):
- `this.messages.getRecent(this.headId, historyBudget)` returns Message[] which
  flow through `getMessageContent()` (line 278-289) when rendered. None of the
  Message variants (text/tool_call/tool_result/summary) include `createdAt` in the
  rendered output — only `content`/`toolCalls`/`toolResults` text is concatenated.
  CONCLUSION: assembler does NOT leak `createdAt` to the model. Document this
  finding in the SUMMARY; no code change to assembler.ts.

From src/scheduler/cron.ts (read-only context — DO NOT modify):
- export function nextRunAfter(expression: string, after: Date, tz: string): Date
- Always returns Date; callers `.toISOString()` for internal storage.
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Create model-time helper module with TDD</name>
  <files>src/util/model-time.ts, src/util/model-time.test.ts</files>
  <read_first>
    - /home/thenasty/shrok/src/util/time.ts (mirror safeZone fallback shape — do not import private functions; re-implement the same defensive pattern inline since safeZone is not exported)
    - /home/thenasty/shrok/AGENTS.md (project rules: node:sqlite, bundler `.js` imports, noUncheckedIndexedAccess, exactOptionalPropertyTypes, vitest)
  </read_first>
  <behavior>
    - formatModelTime(date, tz): given any Date and a valid IANA zone, returns the canonical string `YYYY-MM-DD HH:MM` (24-hour) representing that instant in `tz`. Falsy/invalid `tz` falls back to `UTC`. Never throws.
    - formatModelTime round-trips with parseModelTime in the same `tz` for any non-DST-edge minute.
    - parseModelTime(s, tz): accepts ONLY strings matching `^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$`. Rejects (Error) any input containing `Z`, a `+HH:MM`/`-HH:MM` offset, or any trailing alphabetic token (e.g. ` EDT`, ` America/New_York`). Returns a Date.
    - parseModelTime DST spring-forward (e.g. `America/New_York` `2026-03-08 02:30`): the local clock skips 02:00→03:00, so 02:30 does not exist — throws Error with a message naming the gap.
    - parseModelTime DST fall-back (e.g. `America/New_York` `2026-11-01 01:30`): the local clock repeats 01:00→02:00 twice — picks the FIRST occurrence (i.e. the earlier UTC instant, before the offset shift). Document in JSDoc.
    - parseModelTime happy paths: round-trips correctly in `UTC`, `America/New_York`, `Asia/Tokyo`, `Europe/London` for non-edge minutes.
    - parseModelTime bad format: short strings, missing fields, extra fields, non-numeric → Error with a clear "expected YYYY-MM-DD HH:MM" message.
    - formatPastTimeError(parsed, now, tz): returns a single line containing the parsed time formatted via formatModelTime, the `now` time formatted via formatModelTime, the IANA `tz` name, and the literal phrase `pick a time in the future`.
  </behavior>
  <action>
    Write `src/util/model-time.test.ts` FIRST (RED) covering every case in the behavior block above. Use vitest's `describe`/`it`/`expect`. For DST cases, construct expected behavior using explicit `Date.UTC(...)` anchors so the test does not depend on the host's local timezone. Run `npx vitest run src/util/model-time.test.ts` and confirm the suite fails because the implementation file does not exist.

    Then write `src/util/model-time.ts` (GREEN) exporting `formatModelTime`, `parseModelTime`, and `formatPastTimeError`.

    Implementation guidance:
    - `formatModelTime` uses `Intl.DateTimeFormat([], { timeZone: safeZone(tz), year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false })` then `.formatToParts(date)` and assembles `${y}-${m}-${d} ${h}:${min}`. Guard against the `hour12:false` host bug where some Node versions emit `"24"` for midnight by normalizing `"24"` → `"00"`.
    - `parseModelTime` step 1: regex `/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/`. Reject if the raw input contains `/[Z]/i`, `/[+\-](?:\d{2}):?\d{2}$/`, or any trailing `\s+[A-Za-z]/`. Step 2: resolve local→UTC by constructing the candidate as if UTC (`Date.UTC(y, mo-1, d, h, min, s ?? 0)`), then compute the offset that zone applies AT that candidate (using `Intl.DateTimeFormat` parts on the candidate), then subtract the offset to get the correct UTC instant. Step 3: re-format the resulting UTC instant back through formatModelTime in the same `tz` and compare — if it does NOT match the input's `YYYY-MM-DD HH:MM` slice, the input named a non-existent local time (spring-forward gap), throw. Step 4: for ambiguity (fall-back), the algorithm above naturally returns the FIRST (earlier-UTC) occurrence — document that in the JSDoc.
    - `formatPastTimeError` template (single line, no Date objects in the string):
      `Parsed time "${formatModelTime(parsed, tz)}" is in the past (workspace now is "${formatModelTime(now, tz)}" in ${tz}). Pick a time in the future and retry.`
    - Mirror the safeZone helper as a private `function safeZone(tz: string): string` exactly as in `src/util/time.ts` (defensive try/catch around `new Intl.DateTimeFormat([], { timeZone: tz })`, fallback `'UTC'`).
    - Respect `noUncheckedIndexedAccess`: when destructuring regex match groups, null-check before use. Respect `exactOptionalPropertyTypes`: do not pass `undefined` for optional Intl options — omit the key.
    - All imports must use `.js` extensions per project bundler mode (helper has no internal imports, so this only matters for the test file if it imports from `./model-time.js`).

    Iterate test → impl → test until all cases pass.
  </action>
  <verify>
    <automated>cd /home/thenasty/shrok &amp;&amp; npx vitest run src/util/model-time.test.ts &amp;&amp; npx tsc --noEmit</automated>
  </verify>
  <done>
    `src/util/model-time.ts` exports `formatModelTime`, `parseModelTime`, `formatPastTimeError`. `src/util/model-time.test.ts` passes (round-trip, rejection of Z/+/-/IANA, DST gap throws, DST ambiguous picks first, past-time error contains both timestamps and the literal phrase). `npx tsc --noEmit` is clean.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Rewrite 4 input descriptions + parse/guard at each tool boundary</name>
  <files>src/sub-agents/registry.ts, src/head/index.ts, src/sub-agents/registry.test.ts</files>
  <read_first>
    - /home/thenasty/shrok/src/sub-agents/registry.ts lines 715-724 (GET_USAGE_DEF), 745-907 (buildScheduleTools), 909-1100 (buildReminderTools — focus on create_reminder execute paths around lines 1058 and 1074)
    - /home/thenasty/shrok/src/head/index.ts lines 91-100 (duplicate get_usage definition)
    - /home/thenasty/shrok/src/util/model-time.ts (the new helpers from Task 1)
  </read_first>
  <behavior>
    - Every rewritten description states the canonical format `YYYY-MM-DD HH:MM` (24-hour) and explicitly states the time is interpreted in the workspace timezone (interpolating the closure's `timezone` for the schedule/reminder tools; literally naming "workspace timezone" for the head/registry get_usage variants where there is no closure timezone — read from config at the execute() boundary).
    - No rewritten description contains the substring `Z"` (the smoking-gun pattern in the old text) or the words `ISO` / `UTC` as a format prescription.
    - When the agent calls create_reminder/create_schedule/update_schedule/get_usage with a string containing `Z`, the tool returns a JSON error string whose `message` includes the parser's rejection reason (so the agent self-corrects), not a silent misinterpretation.
    - When the agent supplies a parsed `triggerAt` or `runAt` more than 30 seconds in the past, the tool returns a JSON error string whose `message` is the output of `formatPastTimeError` (contains both timestamps and `pick a time in the future`). 30-second skew window allows for clock drift / activation latency.
    - Internal storage (`createOpts.runAt`, `patch.runAt`, `triggerAt`, `nextRun`, `usageStore.getSummary(sinceIso)`) continues to receive ISO UTC strings — the conversion happens at the boundary.
    - get_usage in BOTH registry.ts and head/index.ts: the JSON response field `since` echoes the canonical local string (e.g. `"2026-04-15 00:00"`), not the raw ISO that gets passed to the store.
  </behavior>
  <action>
    First, extend `src/sub-agents/registry.test.ts` (RED) with these new assertions (if the file does not exist, create it):
    - A sentinel test that imports the registry module and walks the four tool definitions (build them via `buildUsageTool`, `buildScheduleTools`, `buildReminderTools` with a stub store + a fixed `timezone: 'America/New_York'`), then asserts that NONE of the four target descriptions (get_usage.since, create_schedule.runAt, update_schedule.runAt, create_reminder.triggerAt) contains the substring `Z"`, the regex `/\bISO\b/`, or the regex `/\bUTC\b/`. Also assert each description contains the canonical format token `YYYY-MM-DD HH:MM`.
    - A boundary test for each of the four inputs: invoke the tool's `execute({ ...Z-suffixed value... }, ctx)` and assert the returned JSON parses to `{ error: true, message: <string> }` whose `message` mentions the format. Use the smallest possible stub stores (the create_reminder/create_schedule paths require a `scheduleStore` with a `create` method; for the Z-rejection test the rejection short-circuits before any store call, so a stub whose methods throw is fine and proves no DB write occurred).
    - A past-time guard test: feed `create_reminder` a `triggerAt` that is 60 seconds in the past (in workspace tz) and assert the returned error `message` contains both `pick a time in the future` and the local-format echo of `now`.
    - A separate sentinel test that imports `HEAD_TOOL_DEFINITIONS` (or whatever the array at src/head/index.ts:80 is exported as — inspect the file) and asserts the `get_usage` entry's `since.description` likewise lacks `Z"`/`ISO`/`UTC` and includes `YYYY-MM-DD HH:MM`.

    Run `npx vitest run src/sub-agents/registry.test.ts` and confirm the new tests fail.

    Then make them pass (GREEN):
    - Rewrite `GET_USAGE_DEF.since.description` (src/sub-agents/registry.ts:721) to a sentence naming the canonical format `YYYY-MM-DD HH:MM` and noting the time is in the workspace timezone.
    - In `buildUsageTool().execute`, parse `input['since']` via `parseModelTime(sinceRaw, workspaceTimezone)` — but note `buildUsageTool` currently has no `timezone` argument. Update its signature to `buildUsageTool(usageStore: UsageStore, timezone: string)` and update its single caller (grep for `buildUsageTool(` in `src/`) to pass the workspace timezone. Convert the parsed Date to ISO for `usageStore.getSummary(parsed.toISOString())`. Wrap parsing in try/catch and return `{ error: true, message: (e as Error).message }` on failure. Echo `since: parsed ? formatModelTime(parsed, timezone) : 'all-time'` in the response JSON.
    - Rewrite `create_schedule.runAt.description` (src/sub-agents/registry.ts:773) similarly. In execute() (line 807), when `runAtArg` is present: parse with parseModelTime in `effectiveTz` (cronTimezoneArg ?? timezone — match the existing cron timezone resolution), past-time guard with a 30s skew window, return error JSON on failure, and assign `createOpts.runAt = parsed.toISOString()` AND `nextRun = parsed.toISOString()` (preserving the existing logic: the original code assigns `nextRun = runAtArg` raw when no cron is provided — replace with the parsed ISO).
    - Rewrite `update_schedule.runAt.description` (src/sub-agents/registry.ts:840) to the canonical-format string. In execute() (line 880), when `input['runAt']` is present: parse, guard, error-on-failure, then `patch.runAt = parsed.toISOString()`. (No `cronTimezone` resolution issue here because `update_schedule` does not recompute `nextRun` from runAt — confirm by re-reading the surrounding code before editing.)
    - Rewrite `create_reminder.triggerAt.description` (src/sub-agents/registry.ts:948-951) — this is the headline #18 bug. New description: explicitly states canonical format and workspace timezone, removes the `2026-04-01T09:00:00Z` example, gives an example in canonical format.
    - In create_reminder execute(), replace the two `new Date(triggerAtArg)` / `isNaN` patterns (around line 1058-1062 and 1074-1078) with `parseModelTime(triggerAtArg, timezone)` followed by past-time guard. On parse failure, return `{ error: true, message }`. On past-time, return `{ error: true, message: formatPastTimeError(parsed, new Date(), timezone) }`. Internal `triggerAt = parsed.toISOString()` storage stays.
    - In `src/head/index.ts:91-100` rewrite the duplicate `get_usage.since.description` to match the registry.ts text exactly (same canonical format, same workspace-timezone language). Do NOT modify line 395 (`nextRunAfter(...).toISOString()` is internal storage, not model-facing).

    Re-run vitest until green. The 30-second skew window: a parsed time is "in the past" iff `parsed.getTime() < now.getTime() - 30_000`.

    `exactOptionalPropertyTypes`: when augmenting `CreateScheduleOptions` / `SchedulePatch`, continue using the existing `if (x !== undefined) opts.x = x` pattern — do not introduce explicit `undefined` assignments.
  </action>
  <verify>
    <automated>cd /home/thenasty/shrok &amp;&amp; npx vitest run src/sub-agents/registry.test.ts &amp;&amp; npx tsc --noEmit</automated>
  </verify>
  <done>
    All four model-facing input descriptions (3 in registry.ts + 1 in head/index.ts) use the canonical `YYYY-MM-DD HH:MM` format; none contain `Z"`, `ISO`, or `UTC`. Each execute() path parses through `parseModelTime` and rejects Z-suffixed input with a structured error. `create_reminder` and `create_schedule` past-time guard returns `formatPastTimeError`'s message. `get_usage` echoes `since` in canonical local format. `npx tsc --noEmit` is clean. New tests pass.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Fix 3 output renderers (list_schedules, list_reminders, get_file_info)</name>
  <files>src/sub-agents/registry.ts, src/sub-agents/registry.test.ts</files>
  <read_first>
    - /home/thenasty/shrok/src/sub-agents/registry.ts lines 625-638 (executeGetFileInfo), 758 (list_schedules execute), 920-926 (list_reminders mapper)
    - /home/thenasty/shrok/src/util/model-time.ts (the helpers from Task 1)
  </read_first>
  <behavior>
    - list_schedules output: each row's `runAt`, `nextRun`, `createdAt`, `updatedAt` (if present on the row), and any other top-level time field is a canonical `YYYY-MM-DD HH:MM` string. Null / missing fields stay null / missing.
    - list_reminders output: same treatment for `runAt`, `createdAt` (and any other time field already in the existing mapper — preserve all non-time fields exactly: `id`, `message`, `cron`, `requiresAck`, `nagIntervalMinutes`).
    - get_file_info output: `created`, `modified`, `accessed` are canonical local strings, not `.toISOString()` output. The `size`, `type`, `permissions`, `isFile`, `isDirectory` fields are unchanged.
    - Pure-output transformation: parsing is NOT involved (the inputs are trusted internal Dates / ISO strings, not model-supplied), so no past-time guard applies here.
  </behavior>
  <action>
    First, extend `src/sub-agents/registry.test.ts` (RED) with output-shape assertions:
    - list_schedules: seed a stub `scheduleStore.list()` returning rows with known ISO `runAt`/`nextRun`/`createdAt`, invoke the tool's execute, parse the JSON, and assert each time field matches `/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/` and contains no `T`, `Z`, `+`, or trailing `-` after position 9 (the date dashes).
    - list_reminders: same shape assertion across the mapper output's time fields, AND assert non-time fields (`id`, `message`, `cron`, `requiresAck`, `nagIntervalMinutes`) are preserved bit-for-bit from the stub.
    - get_file_info: stat a file the test creates in a tmpdir (use `node:fs` + `node:os`), invoke executeGetFileInfo, parse the JSON, assert `created`/`modified`/`accessed` match the canonical regex and that `size`/`type`/`isFile` are preserved.

    Run vitest and confirm RED.

    Then implement (GREEN):
    - list_schedules execute() (line 758): replace `JSON.stringify(scheduleStore.list())` with `JSON.stringify(scheduleStore.list().map(s => renderScheduleForModel(s, timezone)))`. Define a module-private `renderScheduleForModel(row, tz)` that returns a shallow copy with every time field converted via `formatModelTime(new Date(row.field), tz)` when present, leaving non-time fields untouched. Apply to: `runAt`, `nextRun`, `createdAt`, `updatedAt` (and any other Date-like field on the row — inspect the ScheduleStore row type before editing).
    - list_reminders mapper (line 924): pipe `runAt` and `createdAt` through `formatModelTime(new Date(value), timezone)` when non-null. Preserve all other fields exactly. (`cron` is a cron expression string, not a time — leave alone.)
    - executeGetFileInfo (line 625): change signature to `executeGetFileInfo(input, timezone: string)`. Replace each `.toISOString()` call with `formatModelTime(stat.birthtime, timezone)` etc. Update the call site in OPTIONAL_TOOLS (line 705) to thread `timezone` — since OPTIONAL_TOOLS is a top-level `const Map` and has no closure access to per-head timezone, inspect how `ctx` is built (the existing `execute: async (input, ctx) => ...` shape) and pull timezone from `ctx`. If `AgentContext` lacks a `timezone` field, add it (read the type definition and add the field with proper `exactOptionalPropertyTypes`-friendly defaulting) and update the AgentContext construction sites to populate it from config. If threading via ctx is too invasive, the fallback is to convert OPTIONAL_TOOLS from a static `const Map` into a `buildOptionalTools(timezone: string)` factory (mirroring buildScheduleTools/buildReminderTools) and update its single caller. Pick the lower-impact path after reading both options.

    Sentinel grep test (add to registry.test.ts): after invoking each of the three tools, assert `JSON.stringify(output)` contains NO `Z"`, no ISO-8601 `T`-separator pattern `/\d{4}-\d{2}-\d{2}T/`, and no offset pattern `/\d{2}:\d{2}[+\-]\d{2}/`.

    Re-run vitest until green.
  </action>
  <verify>
    <automated>cd /home/thenasty/shrok &amp;&amp; npx vitest run src/sub-agents/registry.test.ts &amp;&amp; npx tsc --noEmit</automated>
  </verify>
  <done>
    list_schedules, list_reminders, and get_file_info all render time fields in canonical `YYYY-MM-DD HH:MM` format. Non-time fields are preserved unchanged. Sentinel test confirms zero `T`/`Z`/offset patterns in any output. `npx tsc --noEmit` is clean.
  </done>
</task>

<task type="auto">
  <name>Task 4: Document invariant in AGENTS.md + final-sweep sentinel test</name>
  <files>AGENTS.md, src/sub-agents/registry.test.ts</files>
  <read_first>
    - /home/thenasty/shrok/AGENTS.md (find an appropriate insertion point — near "TypeScript" section or after the project-rules block)
    - /home/thenasty/shrok/src/sub-agents/registry.ts (final state after Tasks 1-3)
    - /home/thenasty/shrok/src/head/index.ts (final state after Task 2)
  </read_first>
  <action>
    Add a new subsection to `AGENTS.md` titled exactly:

    `## Model-facing time invariant (no UTC ever reaches the model)`

    Place it after the existing `## TypeScript` section. The subsection must (1) state the invariant in one sentence ("no model-facing surface in shrok ever shows or accepts a UTC instant; all model-facing times are workspace-local in `YYYY-MM-DD HH:MM` format, 24-hour, no `Z`, no offset, no IANA suffix in the value"); (2) name the two helpers and their file (`formatModelTime` and `parseModelTime` in `src/util/model-time.ts`); (3) state the boundary rule ("internal storage stays ISO UTC; rendering and parsing happen at every tool boundary"); (4) link the bug it closes ("Closes #18"); (5) call out the past-time guard ("`create_reminder` / `create_schedule` reject parsed times more than 30 seconds in the past via `formatPastTimeError`").

    Add a final sentinel test to `src/sub-agents/registry.test.ts` that does a literal-string sweep:
    - Read both `src/sub-agents/registry.ts` and `src/head/index.ts` from disk (via `node:fs`).
    - For each file, extract every line that matches the regex `/description:\s*['"`]/` (model-facing tool descriptions). The intent of this test is "no description string contains a `Z`-suffixed ISO example" — so for each matched line, assert the line does NOT match `/"[^"]*Z"/` (the smoking-gun pattern `..."...Z"...`). Document this filter clearly in a test comment because grep on the whole file would false-positive on comments and timezone-related prose.
    - Assert each of the four target descriptions (search by tool name nearby) contains the literal `YYYY-MM-DD HH:MM`.
  </action>
  <verify>
    <automated>cd /home/thenasty/shrok &amp;&amp; npx vitest run src/sub-agents/registry.test.ts &amp;&amp; npx vitest run src/util/model-time.test.ts &amp;&amp; npx tsc --noEmit &amp;&amp; grep -n 'Model-facing time invariant' /home/thenasty/shrok/AGENTS.md</automated>
  </verify>
  <done>
    AGENTS.md contains the new subsection with all five required elements. Sentinel test passes proving zero `Z`-suffixed quoted strings appear inside `description:` lines in registry.ts or head/index.ts, and all four target descriptions name the canonical format. All previously written tests still pass. `npx tsc --noEmit` is clean.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| LLM → tool execute() | Model-supplied strings (triggerAt/runAt/since) cross into shrok's scheduler/usage internals — untrusted format, must be parsed at the boundary |
| Tool execute() → ScheduleStore / UsageStore | Internal storage layer expects ISO UTC; conversion is the tool boundary's responsibility |
| Tool execute() → LLM response JSON | Outputs that go back to the model must be canonical local format; ISO UTC would re-train the model on the wrong format |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-mdd-01 | Tampering | parseModelTime input | mitigate | Strict regex + explicit `Z`/offset/IANA-suffix rejection in parseModelTime (Task 1) prevents the model from sneaking a UTC instant past the boundary by formatting it as local-looking text. |
| T-mdd-02 | Repudiation | create_reminder past-time silent firing | mitigate | Past-time guard (30s skew) returns structured error with both timestamps so the agent self-corrects rather than scheduling a reminder that fires immediately or never (Task 2). |
| T-mdd-03 | Information disclosure | get_file_info output leaking UTC | accept | Filesystem times are not sensitive; the concern is correctness/format consistency, not confidentiality. Mitigated by Task 3 for the format invariant, not the disclosure axis. |
| T-mdd-04 | Denial of service | parseModelTime DST gap throw → tool error → agent retry loop | accept | DST gap inputs are vanishingly rare (one hour per year per zone) and the agent retry budget will halt any infinite loop. Documented in JSDoc so future maintainers don't "fix" the throw. |
</threat_model>

<verification>
After all four tasks:
- `cd /home/thenasty/shrok && npx vitest run src/util/model-time.test.ts src/sub-agents/registry.test.ts` — all new tests pass.
- `cd /home/thenasty/shrok && npx tsc --noEmit` — clean.
- `grep -rn '"[^"]*Z"' src/sub-agents/registry.ts src/head/index.ts` — should return NO matches inside `description:` lines (comments / cron prose / non-description literals are acceptable).
- `grep -c 'YYYY-MM-DD HH:MM' src/sub-agents/registry.ts` — should be ≥ 3 (create_reminder.triggerAt, create_schedule.runAt, update_schedule.runAt, get_usage.since).
- `grep -c 'YYYY-MM-DD HH:MM' src/head/index.ts` — should be ≥ 1 (duplicate get_usage.since).
- `grep -n 'Model-facing time invariant' AGENTS.md` — returns the new subsection heading.
- Manual end-to-end smoke: a model calling `create_reminder({ message: "ping", triggerAt: "2030-01-01T09:00:00Z" })` returns a structured error; a model calling `create_reminder({ message: "ping", triggerAt: "2030-01-01 09:00" })` succeeds.
</verification>

<success_criteria>
- Issue #18 is closed: `create_reminder` no longer accepts UTC-shaped input and the description no longer trains the model to produce one.
- All four model-facing time inputs (3 in registry.ts + 1 in head/index.ts) parse through `parseModelTime` and reject `Z` / offsets / IANA suffixes.
- All three model-facing time outputs (list_schedules, list_reminders, get_file_info) render through `formatModelTime` and emit only canonical-format strings.
- Past-time guard (30s skew) on create_reminder and create_schedule returns a structured error containing both the parsed and `now` timestamps in canonical format plus the literal phrase "pick a time in the future".
- Conversation-history `createdAt` does NOT leak to the model (verified by reading the assembler — no code change needed; documented in SUMMARY).
- `AGENTS.md` documents the invariant under the subsection `Model-facing time invariant (no UTC ever reaches the model)`.
- All new tests pass; `npx tsc --noEmit` is clean.
- No new npm dependencies added.
- "Already correct" surfaces (system prompt `Current time:`, reminder fire `currentTime`, sub-agent system prompt `Current time:`, `cronTimezone`, internal `.toISOString()` writes to DB) are NOT touched.
</success_criteria>

<output>
Create `.planning/quick/260526-mdd-stop-exposing-models-to-utc-issue-18/260526-mdd-SUMMARY.md` when done, recording:
- The four input descriptions before/after (one-line diff each)
- Confirmation that the assembler does not leak `createdAt` to the model (cite the line in `getMessageContent` where rendering is content-only)
- The DST disposition (gap throws, ambiguous picks first)
- Any signature changes (buildUsageTool, executeGetFileInfo, OPTIONAL_TOOLS factory if that path was taken) and the call sites updated
- Test run output (vitest pass count + tsc clean)
</output>
