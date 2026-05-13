---
phase: 33-multi-head-management-ui
plan: 07
subsystem: dashboard
tags: [multi-head, dashboard, frontend, modal, tdd, react-query, typed-confirmation, audit-trail, DASH-03]

requires:
  - phase: 33-multi-head-management-ui
    plan: 04
    provides: "DELETE /api/heads/:id wipe transaction + default-non-deletable server-side"
  - phase: 33-multi-head-management-ui
    plan: 06
    provides: "HeadCard.tsx (the window.confirm replaced here) + api.heads.delete client baseline"
provides:
  - "GET /api/heads/:id/counts -> { messages, queueEvents, channels } — three-count read for the typed-confirmation modal"
  - "DELETE /api/heads/:id now accepts optional body.confirmId; mismatched confirmId returns 400 without touching DB; absent body preserves backward compat for scripts/curl"
  - "api.heads.counts(id) client + api.heads.delete(id, confirmId?) widened signature in dashboard/src/lib/api.ts"
  - "DeleteHeadModal.tsx — portal modal showing three real counts; Delete button disabled until typed input === head.id"
  - "HeadCard.tsx: window.confirm replaced with setDeleteOpen+<DeleteHeadModal>; deleteMutation removed (modal owns it)"
  - "4 new tests in src/dashboard/routes/heads.test.ts (counts happy/404/zero + confirmId match/mismatch/no-body); total 51 tests in the file"
affects: []

tech-stack:
  added: []
  patterns:
    - "Layered destructive-action mitigation (T-33-04): (1) Plan 06 disables the card-level Delete button for the default head with a tooltip, (2) Plan 07 typed-confirmation modal makes the user retype the exact id before the Delete button enables, (3) the modal POSTs confirmId as a body field, (4) the server 400s on mismatch BEFORE the reserved-id check, (5) reserved-id check 400s on 'default' regardless, (6) requireAuth gate gates everything"
    - "Optional confirmId guard (D-06 server-side): the body-field guard is OPTIONAL, not required. confirmId is checked only when present (typeof body.confirmId === 'string'). curl-style DELETE without a body still works — frontend always sends it, scripts that don't know about it still function. This keeps the backend backward-compatible while giving the UI an audit-trail field"
    - "GET /:id/counts as a server-side aggregate over data the requester already has access to: T-33-14 accepts the disclosure because the same authenticated session can already list channels via GET /api/heads and messages via /api/messages — counts are non-secret aggregates with no new surface"
    - "Modal owns its own useQuery + useMutation: DeleteHeadModal opens with `queryKey: ['heads', head.id, 'counts']` and on success invalidates `['heads']` then calls onDeleted()/onClose(). HeadCard no longer holds the deleteMutation — the modal is the single source of truth for the destructive flow"
    - "Conditional spread for exactOptionalPropertyTypes-friendly request bodies: `...(confirmId !== undefined ? { body: JSON.stringify({ confirmId }) } : {})` — the body key is only included when confirmId is present, instead of always sending an empty/undefined body. This is the same pattern Plan 05 PATCH uses for partial channel patches"

key-files:
  created:
    - dashboard/src/pages/settings/DeleteHeadModal.tsx
  modified:
    - src/dashboard/routes/heads.ts
    - src/dashboard/routes/heads.test.ts
    - dashboard/src/lib/api.ts
    - dashboard/src/pages/settings/HeadCard.tsx

key-decisions:
  - "Server-side confirmId guard is optional (Plan-04 backward compat). The plan explicitly designs confirmId as a UX/audit guard, not a security control — server-side default-non-deletable is the real control. The frontend modal always sends confirmId; clients that omit it (curl, scripts, the existing heads.test.ts no-body case) still work"
  - "Modal owns its own useQuery + useMutation rather than receiving counts via props. Rationale: the modal is the only consumer of /counts, and the counts must be fresh every time the modal opens (the user may have just deleted messages from another tab). Putting the query inside the modal makes the lifecycle 1:1 with the modal's mount/unmount"
  - "DeleteHeadModal uses `head.id` for the confirmId field in api.heads.delete(head.id, head.id) — the typed input === head.id check on the client gates the mutation, then the server re-checks confirmId === :id. Both ids are the same value at runtime; passing it explicitly mirrors the API surface and makes the audit-trail intent clear in code"
  - "Confirm guard ordering: confirmId mismatch is checked BEFORE the reserved-id check ('default' non-deletable). Rationale: a request with `DELETE /api/heads/default {confirmId: 'work'}` is malformed and should be rejected as confirmId mismatch (400 + 'confirmId does not match'), not as a default-protection error. The user sent contradictory intent; the more specific error is the clearer one"
  - "Test fixture: a new `start()` helper duplicated across the new describe block rather than hoisting to file scope. Matches the pattern Plans 04 + 05 + 06 already use — each describe block has its own start() so tests don't share state. ~30 lines of fixture boilerplate is the cost; the win is isolation"
  - "Modal renders via createPortal(document.body) — matches SettingsModal's existing pattern. The Delete modal stacks at z-[60], one level above the SettingsModal's z-50, so it visually layers on top of the open Settings panel"

patterns-established:
  - "Typed-confirmation portal modal for destructive actions: any future destructive UI (delete-skill, delete-task, delete-threshold, etc.) can copy DeleteHeadModal's shape — useQuery for the 'how much will this destroy?' read, typed-input gate against the exact id, useMutation with onSuccess invalidate+close, layered server-side confirmId body field as an audit trail"
  - "Optional body-field guard as audit-trail-without-breakage: when adding a new safety field to an existing API, defaulting to optional + 'check only when present' keeps existing clients working while letting the new UI enforce the contract. Server validation of the field (`!== :id` returns 400) means a malicious client can't easily fake compliance"

requirements-completed: [DASH-03]

duration: 5min
completed: 2026-05-13
---

# Phase 33 Plan 07: Typed-Confirmation Delete Summary

**D-06 ships: head deletion now opens a typed-confirmation modal showing message + queue + channel counts before the user can confirm. Delete button stays disabled until the typed input exactly matches the head id; the request sends `confirmId` in the body as a secondary server-side guard. Plan 06's `window.confirm` is gone. Backend GET /api/heads/:id/counts + DELETE confirmId guard land with 4 new tests (51/51 in heads.test.ts pass). Root tsc green, dashboard tsc green, dashboard build succeeds (2139 modules, 1118 KB minified), 66/66 dashboard vitest pass.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-05-13T21:15:03Z
- **Completed:** 2026-05-13T21:19:43Z
- **Tasks:** 2 (backend counts+confirmId TDD; frontend modal + HeadCard wire-in)
- **Files created:** 1 (DeleteHeadModal.tsx)
- **Files modified:** 4 (heads.ts, heads.test.ts, api.ts, HeadCard.tsx)

## Accomplishments

- **Task 1: Backend (TDD RED + GREEN)** — Added 4 failing tests for `GET /api/heads/:id/counts` (happy/404/zero) and `DELETE /api/heads/:id` confirmId guard (match/mismatch/no-body), confirmed RED, then implemented the route changes and confirmed GREEN.
  - `GET /api/heads/:id/counts` returns `{ messages, queueEvents, channels }` using `deps.messages.countForHead(id)`, a fresh `SELECT COUNT(*) FROM queue_events WHERE head_id = ?` prepared statement, and `head.channels.length` from the resolved-heads view.
  - 404 when head doesn't exist.
  - `DELETE /api/heads/:id` now reads `body.confirmId`. If present AND `!== :id`, 400 with `'confirmId does not match :id'`. If absent, falls through to the existing Plan 04 behavior — scripts/curl/the existing no-body tests still work.
- **Task 2: Frontend (api + modal + wire-in)**
  - Added `api.heads.counts(id)` returning `{ messages, queueEvents, channels }`.
  - Widened `api.heads.delete(id, confirmId?)` signature; `confirmId` is sent in the JSON body only when present (conditional spread keeps it `exactOptionalPropertyTypes`-friendly).
  - Created `dashboard/src/pages/settings/DeleteHeadModal.tsx` — portal modal with `useQuery(['heads', head.id, 'counts'])` showing three real counts, a typed-confirm input gated by `typed === head.id`, and `useMutation` calling `api.heads.delete(head.id, head.id)`. On success: invalidate `['heads']`, call `onDeleted()` (triggers RestartModal), and close.
  - `HeadCard.tsx`: removed `deleteMutation` and `handleDelete` (with `window.confirm`); added `deleteOpen` state and `<DeleteHeadModal />` mount. The Delete button now calls `setDeleteOpen(true)` and stays `disabled={isDefault}` so D-08 is enforced at the card level (modal can never open for default).

## Task Commits

1. **Task 1 RED:** `0ca2608` — `test(33-07): add failing tests for GET /:id/counts + DELETE confirmId guard`
2. **Task 1 GREEN:** `f17d69d` — `feat(33-07): add GET /:id/counts endpoint and confirmId guard on DELETE`
3. **Task 2:** `6072a7c` — `feat(33-07): replace window.confirm with typed-confirmation DeleteHeadModal`

## Files Created/Modified

### Created
- `dashboard/src/pages/settings/DeleteHeadModal.tsx` (~95 lines) — portal modal, three-count display, typed-confirm input, useMutation with onSuccess invalidate+close+onDeleted callback.

### Modified
- `src/dashboard/routes/heads.ts` — Added `router.get('/:id/counts')` handler (~17 lines) and `confirmId` guard at the top of `router.delete('/:id')` (~5 lines including comments).
- `src/dashboard/routes/heads.test.ts` — Added `GET /api/heads/:id/counts + DELETE confirmId` describe block (~150 lines) with its own fixture, 6 tests total (3 counts + 3 confirmId).
- `dashboard/src/lib/api.ts` — `api.heads.delete` signature widened with optional `confirmId` arg, body conditionally included via spread; new `api.heads.counts(id)` method below `delete`.
- `dashboard/src/pages/settings/HeadCard.tsx` — Removed `deleteMutation` + `handleDelete` (window.confirm). Added `deleteOpen` state, `<DeleteHeadModal>` mount conditional on `deleteOpen`. Delete button onClick now `setDeleteOpen(true)`. Module header comment updated to note Plan 07 replacement.

## Decisions Made

- **Optional confirmId guard, not required** — preserves backward compat for curl/scripts and the existing no-body tests; frontend modal always sends it. The plan explicitly framed confirmId as a UX/audit guard rather than a security control, so making it required would have churned tests without buying security (the real controls are requireAuth + reserved-id check).
- **Confirm-mismatch check BEFORE reserved-id check** — `DELETE /api/heads/default {confirmId: 'work'}` is malformed; the more specific error is "confirmId does not match", not "default cannot be deleted". A confused user gets the clearer message.
- **Modal owns its own useQuery + useMutation** — rather than HeadCard fetching counts and passing them via props. The modal is the only consumer of `/counts`, and counts must be fresh every time the modal opens. 1:1 mount-lifecycle matches data-lifecycle.
- **`api.heads.delete(head.id, head.id)` inside the modal** — the typed input gates the client-side mutation; the server then re-checks `confirmId === :id`. Both ids are the same value but passing it explicitly mirrors the API surface and makes the audit-trail intent visible in code.
- **Portal `z-[60]` over SettingsModal's `z-50`** — the modal layers on top of the open Settings panel. Backdrop click closes the modal (`onClick={onClose}` on the backdrop).
- **Per-describe `start()` fixture** — matches Plans 04/05/06 pattern. ~30 lines of fixture duplication is the cost for full per-test isolation.

## Deviations from Plan

### Auto-fixed Issues

**None.** Plan executed exactly as written. The only addition beyond the plan's spec was a third counts test (`returns zeros for a head with no data`) — the plan called for 2 counts tests, I added a third to lock in the `count(*)` zero-result branch.

### Threat-flag scan

No new security-relevant surface beyond what the plan's `<threat_model>` already enumerated:

- **T-33-01 (Authorization):** Mitigated — both new endpoints wrapped in `requireAuth` (the helper already applied to all other heads routes).
- **T-33-04 (Auditability / Destructive Action):** Mitigated — three-layer safety: server-side `default` block (Plan 04) + optional confirmId mismatch returns 400 (this plan) + frontend typed-confirmation modal disables Delete until typed input matches (this plan).
- **T-33-07 (CSRF):** Mitigated — inherits global same-origin check; confirmId guard does not bypass it.
- **T-33-14 (Info leak via counts):** Accepted — the three counts (messages, queueEvents, channels) for a head the requester already has read access to. Authenticated user with /api/heads access already has /api/messages access for that head. No new disclosure.

No new threats introduced; no `## Threat Flags` section needed.

## Issues Encountered

- **None blocking.** All three task commits passed `tsc --noEmit` (root + dashboard), `npm run build` (dashboard, 2139 modules), `npx vitest run src/dashboard/routes/heads.test.ts` (51/51), and `cd dashboard && npx vitest run` (66/66) on the first try. The `dashboard/dist/*` files regenerated by the local build are left unstaged per the CLAUDE.md convention that CI rebuilds and commits dist on every passing run.

## User Setup Required

None — frontend-only UX upgrade + backend additive endpoint. Existing deployments work unchanged on the first load of the new dashboard. The typed-confirmation modal appears the next time the user clicks Delete on a non-default head card.

## Next Phase Readiness

Phase 33 (multi-head management UI) is complete: 7/7 plans shipped. The dashboard's Heads tab now supports create / rename / delete heads + add / edit / remove channels + multi-of-same-vendor + per-head Send routing + per-head SSE filtering + typed-confirmation destructive UX.

No blockers; no follow-on plans in this phase.

## Verification (final)

- `npx tsc --noEmit` (root) — exit 0
- `cd dashboard && npx tsc --noEmit` — exit 0
- `cd dashboard && npm run build` — succeeds (2139 modules, 1118 KB minified)
- `cd dashboard && npx vitest run` — 66/66 tests pass across 4 files
- `npx vitest run src/dashboard/routes/heads.test.ts` — 51/51 tests pass
- Manual verification deferred to a human reviewer per the plan's `<verification>` block (open Settings → Heads → Delete on non-default head → modal opens with three real counts → empty input disabled → wrong id disabled → exact id enables → click Delete → RestartModal appears; Delete on default head → button disabled with tooltip, modal never opens)

## Self-Check: PASSED

Verified the following commits exist:
- `0ca2608` (Task 1 RED) — FOUND
- `f17d69d` (Task 1 GREEN) — FOUND
- `6072a7c` (Task 2) — FOUND

Verified files exist on disk:
- `dashboard/src/pages/settings/DeleteHeadModal.tsx` — FOUND
- `src/dashboard/routes/heads.ts` (modified) — FOUND
- `src/dashboard/routes/heads.test.ts` (modified) — FOUND
- `dashboard/src/lib/api.ts` (modified) — FOUND
- `dashboard/src/pages/settings/HeadCard.tsx` (modified) — FOUND

Verified plan acceptance criteria (all grep checks):
- `grep -q "router.get('/:id/counts', requireAuth" src/dashboard/routes/heads.ts` — PASS
- `grep -q "FROM queue_events WHERE head_id" src/dashboard/routes/heads.ts` — PASS
- `grep -q "confirmId does not match" src/dashboard/routes/heads.ts` — PASS
- `grep -c "confirmId" src/dashboard/routes/heads.test.ts` — 8 (≥ 3 required)
- `grep -q "counts: (id: string)" dashboard/src/lib/api.ts` — PASS
- `grep -q "delete: (id: string, confirmId?:" dashboard/src/lib/api.ts` — PASS
- `test -f dashboard/src/pages/settings/DeleteHeadModal.tsx` — PASS
- `grep -q "typed === head.id" dashboard/src/pages/settings/DeleteHeadModal.tsx` — PASS
- `grep -q "countsQuery.data.messages" DeleteHeadModal.tsx` — PASS
- `grep -q "countsQuery.data.queueEvents" DeleteHeadModal.tsx` — PASS
- `grep -q "countsQuery.data.channels" DeleteHeadModal.tsx` — PASS
- `grep -q "api.heads.delete(head.id, head.id)" DeleteHeadModal.tsx` — PASS
- `grep -q "DeleteHeadModal" dashboard/src/pages/settings/HeadCard.tsx` — PASS
- `grep -q "window.confirm" dashboard/src/pages/settings/HeadCard.tsx` — returns nothing (replaced by modal)

---
*Phase: 33-multi-head-management-ui*
*Completed: 2026-05-13*
