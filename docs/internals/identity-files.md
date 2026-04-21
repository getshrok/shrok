# Identity Files

Shrok's personality, your info, and its operational directives all live in plain markdown files. These get assembled into the system prompt at runtime, with variations for sub-agents.

## Where they live

The defaults ship in `src/identity/defaults/` inside the source tree. The live copies for your install live in `~/.shrok/workspace/identity/`, created on first run. You can edit them directly on disk, through the dashboard's Identity section (some files only visible in developer mode), or by asking Shrok to edit them via `write_identity`.

Steward and proactive prompts follow the same workspace-override pattern. Defaults live in `src/head/prompts/` and `src/scheduler/prompts/`, and edits made through the dashboard go to `~/.shrok/workspace/stewards/` and `~/.shrok/workspace/proactive/` respectively.

## The files

Filenames are uppercase with `.md`. The loader is case-sensitive.

### `BOOTSTRAP.md`

The onboarding file. It has instructions that cause Shrok to ask you a few questions the first time you chat with it.

This file is special: **it clears itself after onboarding runs.** Once your initial answers have been captured into `USER.md` and `SOUL.md`, `BOOTSTRAP.md` gets emptied and the onboarding questions won't repeat. The `bootstrapSteward` (see [stewards.md](./stewards.md)) nudges the head if it wraps up onboarding without making all the right calls.

You generally don't edit this file directly. It's only present until onboarding runs.

### `SOUL.md`

Who Shrok is. Name, tone, personality, voice. This is what makes your Shrok feel like *yours* rather than a generic assistant.

Ships with a stub. Onboarding seeds it based on your answers; you can edit it anytime. Changes take effect on the next activation.

Used by: the head, sub-agents, and several stewards (relay, preference) that check the identity the assistant is supposed to project.

### `USER.md`

What Shrok knows about you. Long-standing facts: your name, your work, people in your life, formatting preferences, standing corrections. Things that don't change often.

Ships with a one-line stub; onboarding replaces it. This is distinct from the memory system, which handles evolving conversational context. The `runIdentityFilterSteward` runs on every `write_identity` call targeting `USER.md` to split off skill-specific content (credentials, integration rules) that belongs in a skill's `MEMORY.md` rather than here.

Used by: the head, sub-agents, and several stewards.

### `SYSTEM.md`

The base operational directives for the head. Delegation rules ("spawn an agent, don't do heavy work yourself"), honesty, safety, credentials, how to present results, how skills work.

Used by: **head only.** Sub-agents explicitly exclude `SYSTEM.md` (it's head-flow-specific and confuses agents); they get their own directives from `src/identity/sub-agents/SYSTEM.md` instead.

### `ROUTING.md`

A pattern-match guide for the head: "user gave a fact, write it to `USER.md`", "user wants a time-based nudge, `create_reminder`", "user wants recurring automation, create a task and schedule", etc. It's the head's quick reference for matching intents to the right capability.

Used by: the head, via the identity loader like any other `.md` file.

## How the loader works

`src/identity/loader.ts`'s `FileSystemIdentityLoader` reads every `.md` file from the defaults dir, then every `.md` from the workspace dir, sorts alphabetically, and concatenates them with `\n\n---\n\n` between files.

Two rules follow from that:

1. **Workspace overrides defaults by filename.** If both dirs have `SOUL.md`, the workspace copy wins entirely.
2. **New files are auto-loaded.** Drop any `.md` into `~/.shrok/workspace/` and it gets picked up in alphabetical position on the next assembly. No code change needed. This is why `ROUTING.md` works without any special wiring.

After the loader produces that block, `src/head/assembler.ts` appends the dynamic blocks (optional `AMBIENT.md` from the workspace, agent-tool capabilities, available skills, system environment, current time).

## Other prompt sources (not identity files)

A few things that look like they might be identity files but aren't:

- **Steward prompts** are in `src/head/prompts/*.md` and `src/scheduler/prompts/*.md`, loaded directly by `steward.ts`. Not via the identity loader, not overrideable from the workspace. Placeholders are `{UPPERCASE}` and get filled in at call time.
- **Sub-agent directives** (`SYSTEM.md`, `SKILLS.md`) live in `src/identity/sub-agents/` and are loaded by a second identity loader wired to sub-agents only.

## How files compose into a turn

**Head turn:**
- All workspace + defaults `.md` files (workspace overriding by name), concatenated alphabetically
- Plus: optional `AMBIENT.md`, agent-tool capabilities, available skills, system environment, current time
- Plus: retrieved memory block (if any)
- Plus: token-budgeted recent history

**Sub-agent turn:**
- All identity files **except** `SYSTEM.md` (so: `BOOTSTRAP.md`, `ROUTING.md`, `SOUL.md`, `USER.md`, plus anything else you've added)
- Plus: optional `AMBIENT.md`, current time, skills listing
- Plus: sub-agent directives from `src/identity/sub-agents/` (`SYSTEM.md` + `SKILLS.md`)
- Plus: the agent's spawn prompt (and optionally a snapshot of head history up to `snapshotTokenBudget`)

**Steward call:**
- That steward's prompt file with placeholders filled in
- Some stewards also read `USER.md` / `SOUL.md` / `BOOTSTRAP.md` via the identity loader

The same `SOUL.md` and `USER.md` flowing into every call is what keeps Shrok feeling like one entity across the whole system. An agent running a scheduled task in the background has the same understanding of who it is and who it's working for as the head you're chatting with.

## Editing identity files

Three ways:

1. **Ask Shrok.** "Update `SOUL.md` to make you more concise" or "add a note to `USER.md` that I prefer metric units." The head has `write_identity` and will overwrite the file for you.
2. **Dashboard.** The Identity section exposes the main files; developer mode exposes the rest plus new-file creation.
3. **On disk.** They're just markdown files. Edit, save, done. Changes are picked up on the next assembly.

## Things to be careful about

- **`SYSTEM.md` and `ROUTING.md` are load-bearing.** These contain directives the head depends on. Editing is fine, but sweeping rewrites can make the head behave unpredictably. Prefer additions over rewrites.
- **`write_identity` can only overwrite existing files.** It will error on a non-existent filename. Use `list_identity_files` first to see what exists.
- **Steward prompts include placeholders.** If you edit one in source and break a placeholder like `{TRIGGER_TEXT}` or `{USER_MD}`, the steward will fail at runtime. Most stewards fail open.
- **Back up before big edits.** A simple `cp -r ~/.shrok/workspace ~/.shrok/workspace.bak` before experimenting saves you if something goes wrong.

## Related docs

- [architecture.md](./architecture.md) -- the big picture of how files become system prompts
- [stewards.md](./stewards.md) -- the steward prompts (separate from identity files) and what each one reads
