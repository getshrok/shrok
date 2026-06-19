---
phase: 45
plan: "03"
subsystem: ring-delivery-layer
tags: [ring, media-route, express, home-assistant, host-capture, RING-06, RING-08]
dependency_graph:
  requires: [45-01]
  provides: [assets/ring.mp3, /media/ring.mp3 route, adapter.cacheBaseUrl wiring]
  affects: [src/dashboard/server.ts, src/channels/home-assistant/router.ts]
tech_stack:
  added: [ffmpeg-generated MP3 (static asset)]
  patterns: [literal-match unauthenticated Express route, Host-header capture behind Bearer auth, loopback skip guard]
key_files:
  created:
    - assets/ring.mp3
    - src/dashboard/ring-media.test.ts
  modified:
    - src/dashboard/server.ts
    - src/channels/home-assistant/router.ts
    - src/channels/home-assistant/router.test.ts
decisions:
  - "D-45-03-FETCH-HOST: Node fetch treats Host as a forbidden header — ring-08 tests use node:http request() to inject arbitrary Host header values"
  - "D-45-03-LITERAL-ROUTE: ring.mp3 served as literal GET /media/ring.mp3 with no :filename param (T-45-03-TRAV mitigated)"
  - "D-45-03-LOOPBACK-GUARD: startsWith guards cover 127.*, localhost* — ::1 uses exact-match and [::1] prefix"
metrics:
  duration: "~4min"
  completed: "2026-05-26"
  tasks_completed: 3
  files_changed: 5
---

# Phase 45 Plan 03: Bundled Beep Asset + /media/ring.mp3 Route + Host-Capture Summary

**One-liner:** Bundled 880Hz pulsing MP3 beep served unauthenticated at `/media/ring.mp3`; authenticated HA turns now cache the device-reachable base URL from the Host header (loopback-skipped).

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Bundle beep asset | b997edd | assets/ring.mp3 |
| 2 | Unauthenticated /media/ring.mp3 route + test | a0e87c4 | src/dashboard/server.ts, src/dashboard/ring-media.test.ts |
| 3 (RED) | Add failing RING-08 Host-capture tests | c5751fa | src/channels/home-assistant/router.test.ts |
| 3 (GREEN) | Host/X-Forwarded-Proto capture in router.ts | 3f3e09d | src/channels/home-assistant/router.ts, router.test.ts |

## What Was Built

### Task 1 — `assets/ring.mp3`

Generated with ffmpeg: 880Hz sine wave with tremolo (f=8, d=0.7) — pulsing ~1.5s beep, mono, 64kbps, 12 KB. Valid MP3 with ID3v2.4 header. Not git-ignored. Committed as a static binary asset with no build step.

### Task 2 — `/media/ring.mp3` route in `src/dashboard/server.ts`

- Literal `app.get('/media/ring.mp3', ...)` with no `:filename` path param
- No `requireAuth`, no session middleware (unauthenticated per RING-06)
- `ringAssetPath` resolved from `import.meta.url` (works in both `tsx src/` and `dist/`)
- Mounted at line 252, before `express.static(distPath)` at line 319 (T-45-03-MOUNT mitigated)
- `src/dashboard/ring-media.test.ts`: 3 tests assert HTTP 200 + `Content-Type: audio/mpeg` + non-empty body with no auth header set

### Task 3 — Host/X-Forwarded-Proto capture in `src/channels/home-assistant/router.ts`

Immediately after Bearer auth passes (line 1b block), the router:
1. Derives `proto` from `req.headers['x-forwarded-proto']` ?? `req.secure ? 'https' : 'http'`
2. Reads `host = req.headers['host']`
3. Skips if host starts with `127.`, `localhost`, `[::1]`, or equals `::1`
4. Calls `adapter.cacheBaseUrl(\`${proto}://${host}\`)` for non-loopback hosts

5 new RING-08 tests in `router.test.ts` covering all four cases (non-loopback http, https via X-Forwarded-Proto, loopback 127.0.0.1, loopback localhost, unauthenticated). All 23 router tests pass.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Node fetch cannot override Host header — tests use node:http instead**
- **Found during:** Task 3 GREEN — initial test implementation used `fetch()` with `headers: { Host: ... }`, but Node's undici-based fetch treats `Host` as a forbidden header and ignores the override
- **Issue:** All `postWithHost()` calls sent `Host: 127.0.0.1:<port>` (the actual connection host) regardless of the header object passed, causing the loopback guard to always skip and non-loopback tests to fail
- **Fix:** Rewrote `postWithHost()` helper to use `node:http`'s `request()` which allows arbitrary `Host` header overrides; redesigned the options from positional to an `opts` object to cleanly handle `omitAuth`, `proto`, and `bearerKey` variants
- **Files modified:** `src/channels/home-assistant/router.test.ts`
- **Commit:** 3f3e09d

## TDD Gate Compliance

- RED gate: commit c5751fa — `test(45-03): add failing RING-08 Host-capture tests`
- GREEN gate: commit 3f3e09d — `feat(45-03): Host/X-Forwarded-Proto base-URL capture in HA router`
- All gates present; 23/23 router tests green

## Verification

- `npx tsc --noEmit` — clean
- `npx vitest run src/dashboard/ring-media.test.ts src/channels/home-assistant/router.test.ts` — 26/26 passed
- `file assets/ring.mp3` → `Audio file with ID3 version 2.4.0, contains: MPEG ADTS, layer III`
- Ring route at line 252 < express.static at line 319 — confirmed

## Known Stubs

None — all plan artifacts are fully wired.

## Threat Flags

None — the threat mitigations from the plan's threat model are all implemented:
- T-45-03-TRAV: literal-match route, no path param, no traversal possible
- T-45-03-HOST: capture gated behind Bearer auth; loopback skipped
- T-45-03-MOUNT: ring route mounted before express.static + SPA catch-all

## Self-Check: PASSED

- `assets/ring.mp3` — exists (12 KB, valid MP3)
- `src/dashboard/server.ts` — contains `/media/ring.mp3` and `../../assets/ring.mp3`
- `src/dashboard/ring-media.test.ts` — exists
- `src/channels/home-assistant/router.ts` — contains `adapter.cacheBaseUrl`, `x-forwarded-proto`, loopback guards
- Commits b997edd, a0e87c4, c5751fa, 3f3e09d — all present in git log
