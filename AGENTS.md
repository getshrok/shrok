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

**Push conflicts in `dashboard/dist/`:** Because CI rebuilds and commits `dashboard/dist/` on every passing run, pushing local commits that also touch `dashboard/dist/` will often be rejected. Always `git pull --rebase` before pushing. If a rebase conflict lands in `dashboard/dist/index.html` or `dashboard/dist/assets/`, resolve it by keeping the version from your commit (the incoming side) — it corresponds to the JS asset file your commit staged. The remote's dist will be overwritten again by the next CI run anyway.

## TypeScript

- `moduleResolution: bundler` — import paths use `.js` extensions that resolve to `.ts` files
- `src/icw/*.js` files are ignored by tsc (no `allowJs`); their `.d.ts` files provide types
- Run `npx tsc --noEmit` to type-check without emitting
- `noUncheckedIndexedAccess` is enabled — array indexing always returns `T | undefined`, null-check `arr[0]` before use
- `exactOptionalPropertyTypes` is enabled — you cannot set an optional property to `undefined` explicitly; omit the key or use `delete`

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
