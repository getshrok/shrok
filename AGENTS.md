# Shrok

Shrok is a self-hosted personal AI agent that maintains a single persistent identity across channels (Discord, Telegram, Slack, WhatsApp, Zoho Cliq, web dashboard). Its core design principle: **the head never does work directly** — it delegates to asynchronous sub-agents. The head handles routing, memory, and coordination; agents handle execution.

## Project layout

- `src/` — TypeScript source for the main shrok agent server
- `src/icw/` — **Vendored compiled output** from the `infinite-context-window` sibling repo (see below)
- `dashboard/` — React frontend (npm workspace)
- `sql/` — SQLite migrations
- `skills/` — bundled skill files shipped with the repo

## Vendored ICW dependency

`src/icw/` contains pre-compiled JavaScript + TypeScript declaration files copied from the
`infinite-context-window` repo that lives as a sibling directory (`../infinite-context-window/`).

**Why vendored instead of an npm dependency:** users clone shrok and run it directly — no
separate install step for a private GitHub package.

**What NOT to do:** never edit `src/icw/*.js` or `src/icw/*.d.ts` directly.

**How to sync after changing infinite-context-window:**

```bash
# from the shrok root
npm run sync:icw
git add src/icw/
git commit -m "chore: sync icw from infinite-context-window"
```

`sync:icw` builds the sibling repo, copies `dist/` into `src/icw/`, and deletes all `.map`
files. The map deletion is mandatory — sourcemap paths in the ICW build contain relative
references that Vite follows into shrok's own `src/` tree, crawling the entire app and
inflating the test heap to 4 GB+.

**Never commit `.map` files to `src/icw/`.** The `sync:icw` script handles this automatically;
if you copy files manually, run `find src/icw -name '*.map' -delete` before committing.

## Tests

Tests are split into 6 parallel shards on CI (see `.github/workflows/ci.yml`). Each shard
runs in its own VM with a fresh Vite module graph. If a future shard starts OOMing, increase
the shard count in `.github/workflows/ci.yml` — do not raise the heap limit as the first move.

## CI structure

Six test jobs run in parallel after `lint`:

| Job | What it does |
|-----|-------------|
| `lint` | BOM check on `.ps1` files + `tsc --noEmit` |
| `test (1/6)` … `test (6/6)` | vitest shards, 4 GB heap each |
| `build` | dashboard build, commit rebuilt `dashboard/dist`, security audit |

`build` only runs after all six test shards and lint pass.

**Do not commit `dashboard/dist/` locally.** CI is the sole writer of dist on `origin/main` — the `build` job rebuilds and commits the dist artifacts (`chore(ci): rebuild dashboard dist [skip ci]`) on every passing push. If you need the dashboard SPA to serve from your local checkout (e.g. running shrok against your branch), build the assets on disk but leave them unstaged:

```bash
cd dashboard && npm run build
```

The Express server reads from the working tree, so the running shrok picks up your fresh assets immediately. Do not `git add dashboard/dist/`. CI will produce its own canonical commit when you push your source changes.

**Recovery if you have already committed dist locally** (perhaps as a side-effect of a merge, or from an older workflow): the push will be rejected by CI's parallel commit. The fully-clean path is to drop your dist commit before pulling:

```bash
git reset --hard HEAD~1   # if your dist commit is the tip
git pull --ff-only origin main
```

If that's not feasible (your dist commit is buried under other commits), `git pull --rebase` will conflict on `dashboard/dist/index.html` and `dashboard/dist/assets/`. Resolve by keeping the version from your replayed commit (the incoming side — it matches the JS source files your commit staged). The remote's dist will be overwritten again by the next CI run anyway.

## Changelog

`CHANGELOG.md` is the user-facing record of what shipped. Update it **whenever a notable user-facing change** lands on `main` — bug fixes that close issues, new tools or skills, channel additions, behavior changes the user should know about. Internal refactors, planning-doc churn, CI noise, and internal scaffolding (phase numbers, planning-framework milestones, requirement IDs) do not belong there.

- **File shape**: Keep-a-Changelog format. The top section uses the **next planned release version** as its header (e.g. `## [0.3.0]`), no date until the version is tagged. Below that, the prior numbered release sections in reverse chronological order (`## [0.2.0] — 2026-05-13`, `## [0.1.0] — 2026-04-22`).
- **Entry shape**: subsections by change type — `### Added`, `### Changed`, `### Fixed`. One bullet per delivered capability, written in user language, not engineering language. Reference GitHub issues/PRs in parentheses (`closes #14`) — but **never** reference internal planning artifacts (no `(GSD v1.7, Phase 45)`, no requirement IDs like `RING-F-01`, no `.planning/` paths). Do not add a "Deferred" section — what's *not* shipped isn't a user-facing changelog concern.
- **On version bump** (`chore: bump version to 0.X.Y` + `git tag v0.X.Y`): add the release date to the in-flight section's header (e.g. `## [0.3.0] — 2026-06-15`) and start a new `## [0.X.Y+1]` section above it for the next round of work.

## TypeScript

- `moduleResolution: bundler` — import paths use `.js` extensions that resolve to `.ts` files
- `src/icw/*.js` files are ignored by tsc (no `allowJs`); their `.d.ts` files provide types
- Run `npx tsc --noEmit` to type-check without emitting
- `noUncheckedIndexedAccess` is enabled — array indexing always returns `T | undefined`, null-check `arr[0]` before use
- `exactOptionalPropertyTypes` is enabled — you cannot set an optional property to `undefined` explicitly; omit the key or use `delete`

## Model-facing time invariant (no UTC ever reaches the model)

No model-facing surface in shrok ever shows or accepts a UTC instant; all model-facing times are workspace-local in `YYYY-MM-DD HH:MM` format (24-hour, no `Z`, no offset, no IANA suffix in the value).

**Helpers** (both in `src/util/model-time.ts`):
- `formatModelTime(date, tz)` — converts any Date to the canonical local string for a given IANA zone. Use this on every tool output that returns a time to the model.
- `parseModelTime(s, tz)` — parses the canonical local string back to a Date. Rejects any input containing `Z`, a UTC offset, or a trailing IANA/abbreviation token. Use this at every tool input boundary.
- `formatPastTimeError(parsed, now, tz)` — helper for the past-time guard message.

**Boundary rule:** internal storage always stays ISO UTC (`.toISOString()`). Rendering and parsing happen only at the tool boundary — never deeper in the stack.

**Past-time guard:** `create_reminder` and `create_schedule` reject parsed times more than 30 seconds in the past via `formatPastTimeError` (30-second skew window accounts for clock drift / activation latency).

**DST:** spring-forward gap inputs (non-existent local times) throw; fall-back ambiguous inputs (clock-repeat hour) return the first occurrence (earlier UTC instant). Both behaviors are documented in the `parseModelTime` JSDoc.

**Already-correct surfaces (do NOT modify):** system-prompt `Current time:` line, reminder-fire `currentTime`, sub-agent system-prompt `Current time:`, `cronTimezone` descriptions, internal `.toISOString()` writes to DB, `nextRunAfter(...).toISOString()` in scheduler. These are operator-facing or internal storage — only model-facing *input descriptions* and *output renderers* are governed by this invariant.

Closes #18.

## Architecture: queue and activation loop

All inbound events flow through a priority queue. When adding a new trigger type, follow this path:

```
ChannelAdapter → QueueStore (priority queue) → ActivationLoop (polls, claims atomically)
  → ContextAssembler → runToolLoop → LocalAgentRunner (async worker per agent)
```

Priority order (highest first):

| Priority | Event type |
|----------|-----------|
| 100 | `user_message` |
| 50 | `agent_question` |
| 30 | `agent_completed`, `agent_failed`, `agent_response` |
| 20 | `webhook` |
| 10 | `schedule_trigger`, `reminder_trigger` |

Queue claims use an atomic `UPDATE ... RETURNING *` pattern. Stale `processing` rows are reset to `pending` on startup.

## Database conventions

The project uses **`node:sqlite`** (Node 22+ built-in, synchronous `DatabaseSync`).

**Schedules and reminders are JSON files**, not SQLite rows — stored in `{workspacePath}/data/schedules/` and `{workspacePath}/data/reminders/` via `src/db/file-store.ts`.

## System markers

`src/markers.ts` defines XML-style builders used to inject system content into the LLM conversation.

## Skills structure

A skill is a **directory** under `~/.shrok/workspace/skills/` containing:
- `SKILL.md` (required) — YAML frontmatter + markdown instructions
- `MEMORY.md` (optional) — persistent state agents can read and write
- Optional helper scripts (`.mjs`, `.sh`, etc.)

`SKILL.md` frontmatter fields: `name` (kebab-case, no slashes), `description`, `skill-deps` (array of skill names whose instructions are auto-bundled), `mcp-capabilities`, `max-per-month-usd`.

`MEMORY.md` is auto-injected into an agent's history as a synthetic `read_file` result when it reads the skill — agents always see it without explicitly requesting it.

Use `write-file-atomic` for all skill and identity file writes — plain `fs.writeFileSync` is not used for these files.

## Config vs env vars

Secrets and provider choices go in `.env`; behavioral settings go in `config.json`. `config.json` merges — the base repo `./config.json` is overlaid by `{workspacePath}/config.json`. `ENV_KEY_ALLOWLIST` in `src/config.ts` is the definitive list of keys that the settings API is allowed to write to `.env`.

## Real-time updates: SSE not WebSocket

Server-to-client updates use SSE (`EventSource` at `/api/stream`), not WebSockets.
