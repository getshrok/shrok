# Shrok — Agent Guide

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

**What NOT to do:** never edit `src/icw/*.js` or `src/icw/*.d.ts` directly. Changes belong
in the source repo (`../infinite-context-window/src/`).

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

## Running tests

```bash
npm test                        # full suite (runs all shards sequentially locally)
npm test -- --shard=1/6         # run only shard 1 of 6 (mirrors CI)
```

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

## TypeScript

- `moduleResolution: bundler` — import paths use `.js` extensions that resolve to `.ts` files
- `src/icw/*.js` files are ignored by tsc (no `allowJs`); their `.d.ts` files provide types
- Run `npx tsc --noEmit` to type-check without emitting
