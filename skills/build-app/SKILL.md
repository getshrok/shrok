---
name: build-app
description: How to author, smoke-test, update, and remove a VMS app served at /apps/<slug>/ — copy the seeded example, pick a slug, edit app.ts (+ optional sibling modules for bigger apps) + meta.json + app.test.ts, verify with tsx + the in-process loadApp probe, and report "live". Read this when the user asks for a small custom app, tool, or dashboard.
---

## What an app is and what you author

A VMS app is a server-driven UI served at `/apps/<slug>/`. The host (shrok's Express server)
owns the HTML shell, the `/_pkg` browser bundle, routing, the `createAction`↔Express adapter,
hot discovery, and per-app error isolation. **You author these files in `apps/<slug>/`:**

- `app.ts` — the app **entry module**: it must export `get(): ShellResponseBody`, a `createAction`-wrapped
  `action`, and `meta`. No HTML, no frontend build. A small app can be one self-contained file; for a **bigger
  app, split the logic across co-located sibling modules** (e.g. `state.ts`, `views.ts`, `systems.ts`) that
  `app.ts` imports — exactly like the `vms-apps` apps. **Prefer several normal-sized files over one giant
  `app.ts`:** a single very large `write_file` can be truncated at the output-token limit (you'll get a
  "no `content` / file too large" error — if that happens, split the file or use `edit_file`). `app.ts` is the
  only entry the host looks for; sibling files are never mistaken for separate apps.
- `meta.json` — three fields: `{ "title": "...", "icon": "...", "desc": "..." }`.
- `app.test.ts` — the permanent per-app verification harness (adapted from the example); kept in the app
  folder. It imports `app.ts` (which pulls in any sibling modules), so multi-file apps need no special test
  wiring.
- `package.json` — copied verbatim from the example: a one-line `{ "type": "module" }` that marks the app
  folder as ESM so `npx tsx app.test.ts` runs (see the copy step below). Do not edit it.

**Editing existing files:** use `edit_file` (precise `oldText`→`newText` edits) to change a file you've already
written — reserve `write_file` for creating new files, so you never re-send a whole large file through one call.

Each app lives at `$SHROK_WORKSPACE_PATH/apps/<slug>/` alongside its own co-located
`data.sqlite` (created on first run).

For every ViewNode type the VMS framework supports (tables, modals, forms, tabs, charts,
images, etc.) read the host-served catalog at **`/apps/_skill.md`** — do NOT guess ViewNode
shapes and do NOT expect an embedded catalog here.

## Path discovery

Always resolve workspace paths via `bash` **before** using them in file tools:

```bash
echo "$SHROK_WORKSPACE_PATH"   # apps dir is $SHROK_WORKSPACE_PATH/apps/
echo "$SHROK_ROOT"             # repo root — needed for the loadApp serving probe
echo "$SHROK_SKILLS_DIR"       # the seeded example is $SHROK_WORKSPACE_PATH/skills/build-app/example/
```

The example resides at `$SHROK_WORKSPACE_PATH/skills/build-app/example/`. All three env vars
are set for agent bash by the daemon; they are in `SAFE_PATH_VARS` and always available.

## Slug rules and collision check

The slug becomes the URL path component and the filesystem folder name. It must:
- match `^[a-z0-9][a-z0-9-]*$` (lowercase letters, digits, and hyphens only)
- NOT start with `_` (reserved for `_pkg`, `_skill.md`, and other host paths)

Good examples: `my-tracker`, `notes`, `budget2026`, `status-board`.

**Before authoring**, list what already exists:

```bash
ls "$SHROK_WORKSPACE_PATH/apps/"   # or: scan apps/*/meta.json
```

If the slug already exists, **ask the user** whether they want to update that app or choose a
different slug — never silently suffix the slug or overwrite another app's `app.ts`/`data.sqlite`.
A collision is ambiguous (update vs. new app) and must be a user decision.

## Authoring workflow

### 1. Copy the seeded example

```bash
WORKSPACE="$SHROK_WORKSPACE_PATH"
mkdir -p "$WORKSPACE/apps/<slug>"
cp "$WORKSPACE/skills/build-app/example/app.ts"        "$WORKSPACE/apps/<slug>/app.ts"
cp "$WORKSPACE/skills/build-app/example/meta.json"     "$WORKSPACE/apps/<slug>/meta.json"
cp "$WORKSPACE/skills/build-app/example/app.test.ts"   "$WORKSPACE/apps/<slug>/app.test.ts"
cp "$WORKSPACE/skills/build-app/example/package.json"  "$WORKSPACE/apps/<slug>/package.json"
```

⚠️ **Copy the `package.json` too — do not skip it.** It is a one-line `{ "type": "module" }`
that marks the app folder as ESM. Without it, `npx tsx app.test.ts` (Gate 1 below) runs the
test as CommonJS and the harness's top-level `await import("./app.ts")` fails with a
top-level-await / ESM error — even though your code is fine. The host already loads apps as ESM
at serve time, so this just makes test-time match serve-time. Copy it as-is; do not edit it, and
do NOT instead add a `package.json` at the workspace root (that pollutes every app and the
workspace itself).

### 2. Edit to fit the ask

In `app.ts`:
- Change the `CREATE TABLE` schema and DB helpers to match the app's domain.
- Rewrite `get()` / `buildVm()` / `action` cases to implement the requested behaviour.
- Keep the `APP_DB_PATH` env override (D-05) — the test harness depends on it.
- Keep `PRAGMA journal_mode=DELETE` (NOT WAL) — this keeps `data.sqlite` as the single
  authoritative file at rest so the workspace auto-commit always captures a consistent snapshot.
  Do NOT switch to WAL.
- Keep the `createAction` + `UnknownActionError` re-throw pattern for protocol errors.

In `meta.json`:
- Set `title`, `icon`, and `desc` to describe the new app.

In `app.test.ts`:
- Adapt the test cases to match the new store schema and actions (open/close/add/del or
  whatever the domain uses).
- The test must still exit 0 on success and 1 on failure (no vitest; standalone tsx).

For ViewNode shapes you haven't used before, read `/apps/_skill.md` — it's the live,
version-matched VMS catalog served by the running host.

### 3. Set APP_DB_PATH before importing the module (D-05)

The app module opens its `DatabaseSync` at the top level on first import. The test harness
sets `process.env.APP_DB_PATH` to a temp path **before** the dynamic `import("./app.ts")`
so the store is redirected to a throwaway file. Keep this pattern intact in every adapted
`app.test.ts`.

## Verify gate — both must pass before "done"

Do NOT declare the app live until BOTH checks pass. On failure, iterate (fix → re-verify).

### Gate 1: Logic gate — `tsx app.test.ts`

Run the standalone test harness from the app directory:

```bash
cd "$SHROK_WORKSPACE_PATH/apps/<slug>"
npx tsx app.test.ts
```

This drives `get()` and every `action` in-process against a temp DB and prints `PASS` on
success. It proves the store schema, the action controller, and validation logic are all
correct.

### Gate 2: Serving gate — in-process `loadApp` probe

The logic gate proves the app's code; it does NOT prove the host discovered and loaded the
app (symlink resolution, dynamic import, module-contract check). The serving gate covers this
gap — and it is **auth-free**:

```bash
npx tsx --tsconfig "$SHROK_ROOT/tsconfig.json" -e "
import { loadApp } from '$SHROK_ROOT/src/apps/discovery.ts'
const appsDir = '$SHROK_WORKSPACE_PATH/apps'
const loaded = await loadApp(appsDir, '<slug>')
if (!loaded || loaded.error) { console.error('FAIL: serving error:', loaded?.error ?? 'not found'); process.exit(1) }
const payload = { ok: true, ...loaded.mod.get() }
if (!payload.ok || !payload.vm) { console.error('FAIL: get() did not return vm'); process.exit(1) }
console.log('SERVING OK')
"
```

This runs the production load-time error boundary + dynamic import and produces the exact
`{ ok: true, vm, state }` payload that `GET /apps/<slug>/api` returns.

⚠️ **Do NOT use a bare `curl GET /apps/<slug>/api` as the verification gate.** That route
is protected by `requireAuth` — a sub-agent's curl from bash receives `401 Unauthorized`
because there is no `shrok_session` cookie and no loopback bypass. The in-process probe
above is the correct auth-free serving gate.

## Update an existing app

To update an app (change the schema, add an action, fix a bug):

1. Edit `app.ts` and/or `meta.json` and/or `app.test.ts` with file tools.
2. Re-run **both** verify gates (logic gate + serving gate) — **required after every change**.
3. No user confirmation needed for updates (the workspace git repo records every agent run as
   a commit, so all edits are diffable and revertable).

## Remove an app

Removing an app deletes its folder and all its data. Even though the workspace git repo makes
removal a recoverable operation, you **must confirm with the user first**.

1. **End your turn by asking the user**, e.g.:
   > Delete app `<slug>`? It's recoverable from git, but all data will be removed from the
   > working tree — yes or no?
2. Wait for a "yes" response (the head will surface the question; reply via `message_agent`).
3. On confirmation:
   ```bash
   rm -rf "$SHROK_WORKSPACE_PATH/apps/<slug>"
   ```
4. The workspace auto-commit records the deletion as a clean revert point — note this in
   your completion message.

Do NOT delete without a yes. Do NOT ask repeatedly after a no.

## Report

Once both verify gates pass, end your turn with:
> App `<slug>` is live at `/apps/<slug>/`. (Stand-alone page at `/apps/<slug>/`; agent wire at
> `/apps/<slug>/api` and `/apps/<slug>/api/action`.)

The head will surface this to the user.
