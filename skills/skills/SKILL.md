---
name: skills
description: How Shrok skills work — structure, conventions, and best practices. Read this when installing, creating, editing, or reasoning about skills.
---

## Installing skills

Before creating a skill from scratch, check if it already exists in the community repo. List available skills:

```bash
gh api /repos/getshrok/skills/contents --jq '[.[] | select(.type=="dir") | .name]'
```

To install one, fetch its files and write them to `$SHROK_SKILLS_DIR/{skill-name}/`:

```bash
mkdir -p "$SHROK_SKILLS_DIR/calendar"
gh api /repos/getshrok/skills/contents/calendar --jq '.[] | .name' | while read f; do
  gh api "/repos/getshrok/skills/contents/calendar/$f" --jq '.content' | base64 -d > "$SHROK_SKILLS_DIR/calendar/$f"
done
```

To update an installed skill, do the same but never overwrite `MEMORY.md` or a real `.<service>-credentials.json` (that's the user's data — the repo only ships a placeholder example of the latter). If a local file has been modified, show the diff before replacing.

## Structure

A skill is a directory with:
- `SKILL.md` — frontmatter (YAML) + instructions (markdown)
- `MEMORY.md` — persistent **non-secret, instance-specific** state: configuration, resolved IDs, watermarks. **Secrets do NOT go here** — see [Credentials](#credentials). MEMORY.md holds only data specific to *this* install, never generic how-to (that belongs in SKILL.md). Not a log; overwrite stale values.
- `.<service>-credentials.json` (when the skill needs secrets) — the credential store; see [Credentials](#credentials)
- Scripts (optional) — self-documenting via `--help`, output JSON to stdout, errors to stderr

Use `$SHROK_SKILLS_DIR` in all paths. Resolve it via `bash` before using in file tools.

## Frontmatter

```yaml
---
name: my-skill
description: What the skill does and when to use it.
skill-deps:
  - other-skill
---
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Skill name (kebab-case) |
| `description` | yes | What the skill does and when to reach for it — not how it works internally |
| `skill-deps` | no | Other skills whose instructions are auto-included when this skill is read |
| `mcp-capabilities` | no | MCP capability names this skill requires |
| `npm-deps` | no | npm packages installed at fire time |
| `max-per-month-usd` | no | Monthly spend cap; scheduled runs are skipped once exceeded |

(The `model` field is task-only — see the `tasks` skill. It is parsed but ignored on a SKILL.md.)

## Guiding principles

**Don't teach the model what it already knows.** It knows how to write bash, parse JSON, make HTTP requests, use npm packages, follow API docs, etc. The SKILL.md should only contain things the model doesn't know: what scripts exist, where credentials are, how to get started, helpful patterns, etc.

## Scripts

Prefer built in tools over scripts. If the task is a single API call or a short shell pipeline, put it directly in SKILL.md — a script adds indirection for no benefit.

Create a script when: the operation has fiddly logic the model would get slightly wrong each time (pagination, auth token refresh, output parsing), or when the same operation runs frequently enough that a stable interface saves tokens over re-deriving it.

Scripts should be self-contained (`--help`, JSON to stdout, errors to stderr) so the agent never needs to read the source to use them.

## Credentials

**Secrets never go in MEMORY.md, and the model should never have to type them.** Long opaque values (OAuth refresh tokens, API keys) get mis-copied even by capable models. A skill that needs credentials keeps them in a per-skill **`.<service>-credentials.json`** store, keyed by a short **account alias**, and the script reads them itself.

Conventions:
- **Use by alias.** Normal commands take `--account <alias>` (with `-a` short form); the script loads the secret. The model only handles the short alias, never the secret value.
- **Ship an example shape.** Commit a *placeholder* `.<service>-credentials.json` (values as `XXXX` / `sk-XXXX`) so the agent reads the structure instead of inventing one. Shape: `{ "accounts": { "<alias>": { ...fields } }, "default": "<alias>|null" }`.
- **A `creds` CLI** for management: `list` (masked fingerprints — last 4 chars + length, never the full secret), `set <alias> --<field> ...` (plus `--stdin` to read a JSON entry), `set-default <alias>`, `remove <alias>`. For a single-file CLI add a `creds` subcommand; for a multi-script skill put the store helpers in `_shared.mjs` and add a `creds.mjs` entry point.
- **Account selection order:** explicit `--account` → stored `default` → the sole account if only one exists → else error listing the aliases. Strip `--account`/`-a` out of `argv` before entry scripts parse their own args (so strict parsers don't choke on it).
- **OAuth:** `auth-exchange --account <alias>` should write the new refresh token **straight into the store**, so even at setup the token is never copied by hand.
- **Token cache:** key any cached access token by a hash of `client_id + refresh_token`, not `client_id` alone — two accounts can share one client_id with different-scoped refresh tokens and must not collide.
- **Escape hatch:** env vars (e.g. `GMAIL_CLIENT_ID`/`..._SECRET`/`..._REFRESH_TOKEN`) may override the store for one-off testing, but the normal path is the store.
- **Non-secret config** (org IDs, hostnames, from-addresses) can live in the account entry too, so an account is self-contained.
- **Gitignore** real stores and token caches (`*/.token-cache`); only the placeholder example `.<service>-credentials.json` is committed.

## MEMORY.md patterns

- **Don't pre-create MEMORY.md.** Only create it when there's a real non-secret value to store.
- **Config, not secrets** — resolved user IDs, workspace URLs, non-secret settings. API keys and tokens go in the credential store (above), never in MEMORY.md.
- **Instance data only** — facts specific to this install. No generic how-to instructions (those belong in SKILL.md, where they apply to every install).
- **Watermarks over item lists** — For skills retrieving new items from a service each time, track `lastChecked: 2026-04-04T03:00:00-04:00` instead of a growing list of processed item IDs. Prevents bloat over time.
- **Not a history** — Overwrite stale values, don't append.
