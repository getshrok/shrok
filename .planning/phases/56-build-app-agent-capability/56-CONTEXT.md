# Phase 56: `build_app` Agent Capability - Context

**Gathered:** 2026-06-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Give the agent the **guidance and capability** to author a new VMS app (logic module + metadata) in response to a user request, **smoke-test** it before declaring done, and **update or remove** an app it previously created. Maps BUILDAPP-01..04.

The host-side serving machinery already exists (Phase 55): discovery, the `/apps/<slug>/{,api,api/action}` routes, the request/response adapter, the per-app error boundary, the `/apps/_pkg/*` bundle, the `/apps/_skill.md` VMS manual, and the workspace `@ashley-shrok/viewmodel-shell` symlink. Agents already have the file primitives (`write_file`, `create_directory`, `edit_file`, `read_file`, `bash`). **So this phase is fundamentally a GUIDANCE + WORKFLOW layer, not new tool primitives.**

**In scope:** the `build-app` skill (bundled in the repo, seeded to the workspace), its golden example app, the author→smoke-test→done workflow, the update/remove workflow, and the workspace-git allowlist change that makes apps recoverable.
**Out of scope (later phase):** the dashboard "Apps" sidebar section + launcher (Phase 57). Also out: per-head apps, an app registry/DB, multipart apps (all rejected/deferred in Phase 55).
</domain>

<decisions>
## Implementation Decisions

### Delivery Mechanism
- **D-01 (Skill-only — no `create_app` tool).** The capability ships as a single repo-bundled skill `skills/build-app/` (SKILL.md + a golden example), seeded into the workspace like every other shrok skill. The agent uses its **existing** `write_file`/`create_directory`/`edit_file`/`bash` primitives to author the app folder. **No new registered tool.** Rationale: a `create_app` tool would be new surface to register in the Phase 46 tag registry + allowlists and maintain, while the agent still hand-writes the real logic anyway — a skill is simpler and matches how every shrok capability (configure-*, tasks, sensors, skills) already ships. (`create_app` and "both" were considered and rejected.)
- **D-02 (Delegated sub-agent is the author).** The skill is written for the **sub-agent's POV**: the head delegates "build me an app" to a sub-agent, which reads the build-app skill, authors `app.ts` + `meta.json`, runs the verification, and reports back; the head then tells the user it's live at `/apps/<slug>/`. Matches shrok's default "head delegates, agents execute" posture; sub-agents already have `write_file`/`bash`. (The skill should still read sensibly if a Phase-47 head with agent-tools-opted-in runs it directly, but the default and primary framing is delegation.)

### Guidance Content
- **D-03 (Golden example app — copy-and-adapt).** The skill ships a **complete, runnable reference app** at `skills/build-app/example/` (a real `app.ts` with store + `get()` → `{vm, state}` + a `createAction`-wrapped `action`, plus `meta.json`). SKILL.md instruction is "copy the example, rename the slug, change the store + views to fit the ask." Copy-and-modify is far more reliable for a Sonnet-class model than assembling from abstract fragments, and mirrors the existing vms-apps reference apps. The example carries the load-bearing patterns from Phase 55: per-app `node:sqlite` via `new URL("./data.sqlite", import.meta.url)`, the `import { createAction } from "@ashley-shrok/viewmodel-shell/server"` shape (resolves through the D-11 workspace symlink), and the module contract (`get`, `action`, optional `meta`).
- **D-04 (ViewNode catalog: point at the live `/apps/_skill.md`, don't embed).** The example covers the common shape; for the full ViewNode catalog (tables, modals, forms, tabs, charts, etc.) the skill tells the agent to read the **host-served** `/apps/_skill.md` (the VMS framework's own `createAgentSkillHandler` manual). No duplicated/curated ViewNode reference in the skill → it can never drift from the installed `@ashley-shrok/viewmodel-shell` version. (A curated in-skill cheat-sheet and "both" were considered and rejected in favor of zero-drift.)
- **D-05 (Overridable store path — required by the example).** Because every app ships a standard in-process test (D-06), the example's `node:sqlite` store helper MUST support a **DB-path override** (env var or param) so a test runs against a temp sqlite instead of the app's real `data.sqlite`. This is part of the example template, not an afterthought.

### Verification ("done" gate)
- **D-06 (Standard in-process test file is a permanent app artifact).** Every app the agent builds ships a standard `app.test.ts` (adapted from the example's test), kept in the app folder permanently. It drives `get()` and **each** action **in-process** (import the module, call `get`, POST-shape each `action` with `{name, state}`, assert `ok:true` + the expected state delta) against a **temp DB** (via D-05). This is stronger than a curl check — VMS's whole point is that every user flow is exercisable in unit-test/in-process style with no HTTP server or browser. The agent runs it via `tsx`.
- **D-07 (HTTP integration check too — both gate "done").** In-process tests prove the app's *logic*; they do NOT prove the host *discovered and served* it (symlink resolution, the adapter, the route). So before declaring done the agent ALSO does an HTTP `GET /apps/<slug>/api` and confirms `ok:true` (BUILDAPP-03's literal bar). **Both the test-file run AND the HTTP check must pass** before the app is "done." On failure the agent iterates (fix → re-verify).
- **D-08 (Re-verify after updates).** The skill requires re-running the test-file + HTTP check after **any** update/edit, so an edit can't silently break the app.

### Update / Remove Safety
- **D-09 (Any app by slug — no provenance tracking).** The agent can update or remove ANY app by slug; there is no `created_by`/ownership marker. Apps are global shared artifacts, exactly like skills/sensors/tasks (any agent can edit any of those). "Previously created" (BUILDAPP-04) is satisfied because the agent can act on any app, including ones it made. (Provenance tracking was considered and rejected — it would add the tracking mechanism the global filesystem model deliberately avoided in Phase 55.) The agent lists apps by scanning `apps/*/meta.json`.
- **D-10 (Leverage the workspace recovery git repo — `apps/` joins the allowlist).** The shrok workspace (`{workspace}`) is an **allowlist-based git recovery repo** (`src/workspace/git.ts`): everything is gitignored except explicitly allowlisted dirs (`identity/`, `tasks/`, `skills/`, `sub-agents/`, `topics/`), and agent activity auto-commits. `apps/` is ignored **only because Phase 55 never added it to the allowlist.** This phase adds `!/apps/` to `WORKSPACE_GITIGNORE` so app create/update/remove ride the existing auto-commit → free version history, diffable/revertable updates, and recoverability of a deleted app. Apps simply join skills/tasks/identity in the same recovery layer.
- **D-11 (Track app code AND `data.sqlite`, consistently; never `-wal`/`-shm`).** The allowlist tracks app **code** (`app.ts`, `meta.json`, `app.test.ts`) AND the per-app **`data.sqlite`** (the user data is the valuable part; cost is trivial at this scale — small personal-app DBs, light write volume, one blob per agent-run commit). To avoid stale snapshots (recent committed rows can sit in the WAL, unflushed to the main file), snapshots must be **consistent** — e.g. `PRAGMA wal_checkpoint(TRUNCATE)` on the app DB before the workspace auto-commit, or run app DBs in a rollback-journal mode so the single file is always authoritative (exact mechanism = research/planning detail). **`apps/*/data.sqlite-wal` and `apps/*/data.sqlite-shm` are ALWAYS gitignored** (transient; meaningless without exact matching state) — mirror the existing `skills/*/.venv` etc. exclusions.
- **D-12 (Confirm before remove; no confirm to update).** Removing an app deletes its folder. Even with D-11 making it git-recoverable, the agent must **confirm with the user before a remove** (the head surfaces it / the sub-agent asks) — git turns this into an "are you sure?" rather than the sole line of defense. **Updates need no confirmation** (revertable via git + re-verified via D-08). The agent should commit a removal so it's a clean revert point.

### Claude's Discretion
- **Slug-collision handling** when the agent picks a slug that already exists (suffix, ask, or refuse — implementation choice).
- Exact SKILL.md prose/structure, the example app's domain (pick something small and illustrative), and the precise shape of the in-process test harness helper.
- The exact D-11 consistency mechanism (checkpoint-before-commit vs. journal mode) — a planning/research call.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### This milestone's prior phase (the host contract this skill targets)
- `.planning/phases/55-app-serving-subsystem/55-CONTEXT.md` — the locked app model: D-04 module contract (`get`/`action`/`meta`), D-03 self-contained folder + co-located `node:sqlite`, D-11 workspace `@ashley-shrok/viewmodel-shell` symlink + `new URL("./data.sqlite", import.meta.url)`, the `apps/<slug>/` layout the agent authors into.

### Phase 55 shipped code (the host the agent's apps run on)
- `src/apps/discovery.ts` — how apps are discovered/loaded (the loader the smoke-test exercises end-to-end); shows what a valid app module must export.
- `src/apps/router.ts` — the `/apps/:slug/{,api,api/action}` routes the HTTP check (D-07) hits and the standalone page.
- `src/apps/shell.ts` — the host-generated HTML shell (the agent does NOT author HTML — context for what's host-owned).
- `src/apps/db.ts` — the host's `node:sqlite` + WAL helper; the example's overridable store (D-05) should be consistent with this pattern (apps open their OWN co-located DB, not import this).
- `src/apps/adapter.ts` — the `createAction`↔Express request/response adapter (explains how POST `…/api/action` maps to the app's web-native `action`, i.e. what an in-process test must emulate).

### Workspace recovery repo (D-10 / D-11 change site)
- `src/workspace/git.ts` — the `WORKSPACE_GITIGNORE` allowlist constant + `ensureWorkspaceRepo` (allowlist migration logic) + the auto-commit mechanism. Add `!/apps/` here and the `apps/*/data.sqlite-wal|-shm` exclusions; verify how/when the auto-commit fires and where a consistency checkpoint (D-11) would hook in.

### Skill packaging (how `build-app` ships + seeds)
- `skills/` (repo) + `src/skills/loader.ts` — the bundled-skill convention (`SKILL.md` frontmatter `name`/`description`, optional helper files) and how repo skills are discovered/seeded into the workspace. The new `skills/build-app/` follows this; confirm the seed/copy path so the example app + SKILL.md land in the workspace.
- A simple existing bundled skill (e.g. `skills/sensors/` or `skills/tasks/`) — structural template for SKILL.md + bundled assets.

### VMS reference (the agent manual + example apps the golden example mirrors)
- `/home/thenasty/vms-apps/node_modules/@ashley-shrok/viewmodel-shell/agent-skill.md` — the VMS agent manual; served live by the host at `/apps/_skill.md` (D-04). Authoritative ViewNode catalog.
- `/home/thenasty/vms-apps/apps/shopping/{store,state,views,controller}.ts` — canonical app structure to model the golden example on (Bun-flavored — the example is `node:sqlite`).

### Requirements / roadmap
- `.planning/ROADMAP.md` (Phase 56 section) — goal, BUILDAPP-01..04, success criteria.
- `.planning/REQUIREMENTS.md` (BUILDAPP block) — the four requirements.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Agents already have all the file/exec primitives** (`write_file`, `create_directory`, `edit_file`, `read_file`, `bash` with net) — no new tools needed; the phase is guidance + workflow.
- **`/apps/_skill.md`** is already served (VMS `createAgentSkillHandler`) → the ViewNode reference (D-04) is free and version-matched.
- **Phase 55's `src/apps/*`** is the live host the skill targets — the smoke-test/HTTP check (D-07) and the discovery loader are already built and verified.
- **`src/workspace/git.ts` allowlist + auto-commit** is an existing recovery mechanism apps just opt into (D-10/D-11) — no new persistence layer.

### Established Patterns
- **Bundled-skill convention** (`skills/<name>/SKILL.md` + assets, seeded to workspace) — `build-app` mirrors it; the golden example rides along as a bundled asset.
- **Global shared artifacts** (skills/sensors/tasks all editable by any agent) — apps follow the same trust model (D-09).
- **Workspace allowlist git repo** — "track only content worth recovering, exclude large/runtime artifacts" — apps add code+DB, exclude `-wal`/`-shm` (D-11).
- **`node:sqlite` + WAL** is shrok's standard; the example's store must support a path override for testability (D-05).

### Integration Points
- `src/workspace/git.ts` — `WORKSPACE_GITIGNORE` (+ migration in `ensureWorkspaceRepo`) gets the `!/apps/` allowlist rule + `data.sqlite-wal/-shm` exclusions, and a D-11 consistency hook before commit.
- `skills/build-app/` (new repo dir) + the skill seed path — ship SKILL.md + `example/`.
- The sub-agent runtime — needs the dashboard base URL/port for the HTTP check (D-07): **research item** (read from config/env, or document a known default; the sub-agent runs inside the shrok process environment).
</code_context>

<specifics>
## Specific Ideas

- **VMS apps are unit-testable in-process by design** — this drove D-06: "all user flows testable in unit-test style" is the natural verification unit, not curl. The standard `app.test.ts` is a permanent artifact, not a throwaway check.
- **Lean on the host, not the skill, for anything that can drift** — D-04 (ViewNode catalog → live `/apps/_skill.md`) over an embedded copy.
- **The git recovery repo is the safety story** — the user explicitly wanted to exploit the fact that the workspace is a git repo; D-10/D-11 make remove "are you sure?" instead of "permanent loss."
- Keep the agent's authoring surface tiny (carried from Phase 55): the agent writes only `app.ts` + `meta.json` (+ the adapted `app.test.ts`); the host owns HTML/`_pkg`/routing/adapter/discovery/error-isolation.
</specifics>

<deferred>
## Deferred Ideas

- **Dashboard "Apps" section + launcher** — Phase 57 (lists built apps, links out to each standalone app). Not this phase.
- **Per-head apps / app registry in DB / multipart apps** — rejected or deferred in Phase 55 (D-01/D-02 there); not revisited here.
- **Full action-sweep verification of every action over HTTP** — the in-process test (D-06) already covers all actions; the HTTP check (D-07) is deliberately a single `GET /api` integration probe, not an exhaustive HTTP sweep.
- **A `create_app` registered tool** — rejected (D-01); revisit only if skill-driven authoring proves unreliable for the target model.

None of these are in Phase 56 scope.
</deferred>

---

*Phase: 56-build-app-agent-capability*
*Context gathered: 2026-06-26*
