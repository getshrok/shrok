---
phase: 20-vite-build-configuration
plan: "01"
subsystem: dashboard-build
tags:
  - vite
  - build-config
  - websocket-proxy
  - static-copy
  - vad
dependency_graph:
  requires: []
  provides:
    - VAD runtime assets at dashboard/dist root (5 files)
    - WebSocket proxy for /api/voice in Vite dev server
  affects:
    - dashboard build output
    - Phase 21 (React Voice UI) can now use MicVAD.new() without 404s
tech_stack:
  added:
    - "@ricky0123/vad-web@0.0.30 (runtime dep, exact pin)"
    - "vite-plugin-static-copy@3.4.0 (dev dep, exact pin)"
    - "onnxruntime-web@1.24.3 (transitive, via @ricky0123/vad-web)"
  patterns:
    - "viteStaticCopy with absolute path.resolve() src paths for npm workspace hoisting"
    - "Vite proxy insertion-order: /api/voice (ws: true) before /api"
key_files:
  created: []
  modified:
    - dashboard/package.json
    - package-lock.json
    - dashboard/vite.config.ts
decisions:
  - "Used path.resolve(__dirname, '../node_modules/...') for viteStaticCopy src paths due to npm workspace hoisting — modules live at root node_modules, not dashboard/node_modules"
  - "Both ONNX models included (legacy + v5) even though DEFAULT_MODEL is legacy — future-proofs the config"
metrics:
  duration: "~8 minutes"
  completed: "2026-04-23"
  tasks_completed: 2
  files_modified: 3
---

# Phase 20 Plan 01: Vite Build Configuration Summary

**One-liner:** Configured viteStaticCopy to copy 5 VAD/ORT runtime assets to dist root and added /api/voice WebSocket proxy with ws:true ahead of the /api HTTP proxy.

## What Was Built

Two tasks executed to configure the dashboard build for browser VAD support:

**Task 1 — Install dependencies:**
- `@ricky0123/vad-web@0.0.30` installed as runtime dependency (exact pin, no caret) in `dashboard/package.json` `dependencies`
- `vite-plugin-static-copy@3.4.0` installed as dev dependency (exact pin, no caret) in `dashboard/package.json` `devDependencies`
- `onnxruntime-web@1.24.3` pulled in transitively
- All 5 VAD source asset files confirmed present in root `node_modules/`

**Task 2 — Vite config:**
- `viteStaticCopy` plugin wired with 5 targets, each using `dest: ''` (dist root)
- `/api/voice` proxy entry with `ws: true` added BEFORE existing `/api` entry
- Existing `/api` HTTP proxy entry preserved unchanged (no `ws: true`)

## Files Modified

| File | Purpose |
|------|---------|
| `dashboard/package.json` | Added `@ricky0123/vad-web@0.0.30` to dependencies, `vite-plugin-static-copy@3.4.0` to devDependencies, both exact pins |
| `package-lock.json` | Locked dependency graph including vad-web, vite-plugin-static-copy, onnxruntime-web@1.24.3 |
| `dashboard/vite.config.ts` | Added viteStaticCopy plugin for 5 VAD assets + /api/voice WS proxy entry |

## Verified Installed Versions

- `@ricky0123/vad-web`: `0.0.30` (exact)
- `vite-plugin-static-copy`: `3.4.0` (exact)
- `onnxruntime-web`: `1.24.3` (transitive, locked in package-lock.json)

## Build Output: 5 VAD Files at dist Root

After `cd dashboard && npm run build` (output: "Copied 5 items."):

| File | Size | Status |
|------|------|--------|
| `dashboard/dist/vad.worklet.bundle.min.js` | present | OK |
| `dashboard/dist/silero_vad_legacy.onnx` | present | OK |
| `dashboard/dist/silero_vad_v5.onnx` | present | OK |
| `dashboard/dist/ort-wasm-simd-threaded.wasm` | ~12 MB (12,361,745 bytes) | OK |
| `dashboard/dist/ort-wasm-simd-threaded.mjs` | present | OK |

## Manual Verification

**VOICE-UI-04 (VAD assets at dist root):** Verified automatically — `npm run build` produces all 5 files at `dashboard/dist/` root with correct file sizes.

**VOICE-UI-05 (WebSocket proxy smoke):** Deferred to Phase 21. The `/api/voice` proxy entry with `ws: true` is in place in `vite.config.ts`. Full end-to-end test (`npx wscat -c ws://localhost:5173/api/voice/ws`) requires the Phase 19 backend running — this cannot be automated in Phase 20. Will be verified during Phase 21 React Voice UI smoke testing.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] npm workspace hoisting required absolute src paths in viteStaticCopy**

- **Found during:** Task 2
- **Issue:** The plan specified bare relative paths (`node_modules/@ricky0123/vad-web/dist/...`) for viteStaticCopy targets. In this npm workspace setup, `dashboard/` has no local `node_modules/` — packages are hoisted to the root `node_modules/` at `/home/ubuntu/shrok/node_modules/`. Using bare relative paths would cause glob to look in `dashboard/node_modules/` (which doesn't exist), finding nothing and copying 0 files.
- **Fix:** Used `path.resolve(__dirname, '../node_modules/@ricky0123/vad-web/dist/...')` for all 5 src paths. Since `__dirname` in `dashboard/vite.config.ts` is `/home/ubuntu/shrok/dashboard`, `../node_modules/` correctly resolves to `/home/ubuntu/shrok/node_modules/`.
- **Verification:** Build output confirmed "Copied 5 items." and all 5 files present in dist.
- **Files modified:** `dashboard/vite.config.ts`
- **Commit:** `70721a3`

## Known Stubs

None. This plan only configures the build pipeline — no React components or data flows introduced.

## Threat Flags

None. The security controls described in the plan's threat model are all in place:
- T-20-01: Exact version pins confirmed (`0.0.30`, `3.4.0`) — no caret in package.json
- T-20-02: WS proxy is dev-only (Vite dev server only)
- T-20-03: Large WASM file is intentional — accepted
- T-20-04: WS proxy targets loopback only — accepted
- T-20-05: vite-plugin-static-copy pinned to `3.4.0` exactly — mitigated

## Commits

| Hash | Message |
|------|---------|
| `4ace50e` | chore(20-01): install @ricky0123/vad-web@0.0.30 and vite-plugin-static-copy@3.4.0 |
| `70721a3` | feat(20-01): wire viteStaticCopy for VAD assets and /api/voice WS proxy |

## Self-Check: PASSED

Files verified:
- dashboard/package.json: FOUND
- dashboard/vite.config.ts: FOUND
- dashboard/dist/vad.worklet.bundle.min.js: FOUND
- dashboard/dist/silero_vad_legacy.onnx: FOUND
- dashboard/dist/silero_vad_v5.onnx: FOUND
- dashboard/dist/ort-wasm-simd-threaded.wasm: FOUND (12 MB)
- dashboard/dist/ort-wasm-simd-threaded.mjs: FOUND

Commits verified:
- 4ace50e: FOUND
- 70721a3: FOUND
