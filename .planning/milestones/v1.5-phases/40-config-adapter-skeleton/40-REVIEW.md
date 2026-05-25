---
phase: 40-config-adapter-skeleton
reviewed: 2026-05-24T00:00:00Z
depth: standard
files_reviewed: 6
files_reviewed_list:
  - src/config.ts
  - src/config.test.ts
  - src/channels/home-assistant/adapter.ts
  - src/channels/home-assistant/adapter.test.ts
  - src/index.ts
  - src/dashboard/routes/heads.ts
findings:
  critical: 0
  warning: 2
  info: 4
  total: 6
status: issues_found
---

# Phase 40: Code Review Report

**Reviewed:** 2026-05-24
**Depth:** standard
**Files Reviewed:** 6
**Status:** issues_found

## Summary

Reviewed the Phase 40 Home Assistant channel "skeleton": the Zod discriminated-union
addition for the `home-assistant` vendor (`src/config.ts`), the stub adapter
(`src/channels/home-assistant/adapter.ts`), the startup wiring in `src/index.ts`, the
masked dashboard surfacing in `src/dashboard/routes/heads.ts`, and the two test files.

The intentional skeleton scope was respected during review: the loud-but-safe `send()`
(D-05), the absence of HTTP/REST (Phases 41/42), the test-only `injectMessage()` helper,
and keeping the HA token out of `config.json` (D-04) were all treated as design, not bugs.

Correctness of the core wiring is solid: `npx tsc --noEmit` passes, so the `never`
exhaustiveness guard in `src/index.ts:329` and the exhaustive `switch` in
`extractSecretValues`/`maskChannel` all confirm the 6-vendor union is fully covered. The
`haVoiceSatelliteEntityId` regex is correctly anchored (`^...$`) and rejects wrong-domain,
no-domain, uppercase, hyphenated, and newline-injected variants. The `exactOptionalPropertyTypes`
and `noUncheckedIndexedAccess` constraints are honored throughout (conditional spread of
`senderName`, indexed-access guards in tests).

Two latent security gaps are the substantive findings. Both are forward-looking: they do
not exploit anything in the Phase 40 stub itself, but they are baked into config-layer code
shipping NOW and will bite the moment Phase 41/42 reads `haBaseUrl` / `HA_ACCESS_TOKEN`.
Flagging them now is cheaper than re-litigating the schema after the HTTP client lands.

## Warnings

### WR-01: `HA_ACCESS_TOKEN` is allowlisted for writing but is never read or registered for log redaction

**File:** `src/config.ts:510` (allowlist), `src/config.ts:331-352` (secrets read), `src/config.ts:406-409` (`extractSecretValues`)

**Issue:**
`HA_ACCESS_TOKEN` is in `ENV_KEY_ALLOWLIST` (line 510), so the dashboard settings API can
write it into `.env` today. But:
1. `loadConfig()` never reads `process.env['HA_ACCESS_TOKEN']` into the `secrets` object
   (lines 331-352) — unlike every other credential, it has no entry there.
2. `extractSecretValues()` explicitly skips it: `case 'home-assistant': break  // token is
   global (HA_ACCESS_TOKEN), not per-channel` (line 408).

The only path that feeds `registerSecrets()` is `extractSecretValues(config)`
(`src/index.ts:95`). Since the HA token reaches neither the config object nor
`extractSecretValues`, it will **never be registered for log redaction**
(`src/logger.ts:31`). The adapter test at `adapter.test.ts:61-67` guards that the *stub's*
warn line contains no token — but that only works because the stub literally has no token
reference. Once Phase 41/42 constructs an `Authorization: Bearer <HA_ACCESS_TOKEN>` header
and any request error / debug line includes it, the token will be logged in cleartext to
`process-latest.log` and the console, because the redaction set does not contain it.

This is filed as WARNING (not BLOCKER) because no Phase 40 code path logs the token today —
there is no live exposure yet. But the gap is shipping in config-layer code now and is
invisible until the consumer lands, so it should be closed before/with Phase 41.

**Fix:** Register the HA token for redaction at load time. Read it in `loadConfig`'s
`secrets` block and have `extractSecretValues` pick it up (it is process-global, so register
it once, independent of the per-channel walk):

```ts
// in extractSecretValues(), after the flat SECRET_FIELDS loop:
const haToken = process.env['HA_ACCESS_TOKEN']
if (typeof haToken === 'string' && haToken.length >= 8) out.push(haToken)
```

(Keep the `case 'home-assistant': break` comment, but make it point at this global
registration so the next reader knows the token IS redacted, just not per-channel.)

### WR-02: `haBaseUrl` accepts dangerous URL schemes (`javascript:`, `file:`, `gopher:`, `ftp:`)

**File:** `src/config.ts:54`

**Issue:**
`haBaseUrl: z.string().url()` validates only that the string is a parseable URL, not that it
is an HTTP(S) URL. Verified empirically against the project's Zod version:

```
PASS  "javascript:alert(1)"
PASS  "file:///etc/passwd"
PASS  "gopher://x"
PASS  "ftp://x"
```

The HA adapter is documented to make REST/SSE calls to `haBaseUrl` in Phases 41/42. An
operator (or anyone who can reach the authenticated `POST /api/heads/:id/channels` endpoint,
which runs the same `ChannelConfigSchema.safeParse`, `heads.ts:437`) can persist a
`file://` or `gopher://` base URL that a future HTTP client will dereference — a
config-injected SSRF / local-file-read primitive. Constraining the scheme now, in the
schema that is the single validation chokepoint, is far cheaper than auditing every future
call site.

Filed as WARNING because no Phase 40 code dereferences `haBaseUrl` yet; the value only sits
in `config.json`. But it is a validation gap shipping now in security-relevant config code.

**Fix:** Restrict the scheme in the schema (so both `loadConfig` and the `/channels` route
inherit it):

```ts
haBaseUrl: z.string().url().refine(
  (u) => { try { const p = new URL(u).protocol; return p === 'http:' || p === 'https:' } catch { return false } },
  'haBaseUrl must be an http(s) URL',
),
```

## Info

### IN-01: `home-assistant` `id` is not regex-validated at schema level (relies on route-layer guard)

**File:** `src/config.ts:51-59`

**Issue:** Every channel variant's `id` is `z.string().min(1)` — kebab-case enforcement
lives only in the dashboard route (`HEAD_ID_REGEX`, `heads.ts:421`). A `home-assistant`
channel loaded directly from a hand-edited `config.json` (bypassing the route) can have an
arbitrary `id` (e.g. with spaces or `:`), which becomes the `ChannelRouter.register()` key
and the `channel` field on inbound events. This is pre-existing behavior shared by all six
vendors, not new to Phase 40 — noting it for completeness, not as a regression.

**Fix:** Optional hardening — apply a shared `id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)`
to all union members so config-file and API paths validate identically. Out of scope for the
skeleton; consider when the channel schema is next touched.

### IN-02: `start()` says "Phase 41", `send()` says "Phase 42" — verify the split is intentional

**File:** `src/channels/home-assistant/adapter.ts:21` and `:29`

**Issue:** The two log lines reference different phases (41 for the HTTP listener, 42 for
`send()`). The `send()` test asserts `/Phase 42/` (`adapter.test.ts:58`), so the strings are
internally consistent and test-locked. Confirm the inbound-listener (41) / outbound-send (42)
phase split matches the roadmap; if either phase number shifts, the test string and these two
log lines must move together. No action if the split is correct — just a maintenance note.

### IN-03: `injectMessage()` test helper is a public method on a production class

**File:** `src/channels/home-assistant/adapter.ts:35-41`

**Issue:** `injectMessage()` is documented "Do NOT call from production code paths" but is a
plain public method, so nothing prevents a future caller from invoking it in production. The
JSDoc is the only guardrail. Acceptable for the skeleton (it is the only inbound test seam
until Phase 41 wires the real listener), but worth a follow-up: once the real HTTP inbound
path exists, consider gating this behind a test-only export or removing it.

**Fix:** No change required for Phase 40. Track for Phase 41 cleanup.

### IN-04: `extractSecretValues` per-channel `home-assistant` branch is a documented no-op

**File:** `src/config.ts:408`

**Issue:** The empty `case 'home-assistant': break` is correct *if* the global token is
registered elsewhere — but per WR-01, it currently is not registered anywhere. Once WR-01 is
fixed, update the comment to point at the global registration so the no-op reads as
intentional rather than as a missed case. Tracked as part of WR-01.

---

_Reviewed: 2026-05-24_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
