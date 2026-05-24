---
phase: 33-multi-head-management-ui
plan: 06
subsystem: dashboard
tags: [multi-head, dashboard, frontend, settings-tab, react-query, secret-preservation, DASH-03, DASH-04]

requires:
  - phase: 33-multi-head-management-ui
    plan: 04
    provides: "POST/PATCH/DELETE /api/heads + GET with masked channels — backend surface this tab calls"
  - phase: 33-multi-head-management-ui
    plan: 05
    provides: "POST/PATCH/DELETE /api/heads/:id/channels[/:channelId] — channel sub-resource"
provides:
  - "api.heads.create / rename / delete / addChannel / editChannel / removeChannel — typed client matching D-16 nested-REST paths"
  - "ChannelConfigMasked + ChannelConfigSubmit + HeadDTO mirror of the backend mask shape (D-17)"
  - "vendor-theme.ts: Vendor + VENDORS + VENDOR_COLORS + VENDOR_LABELS + vendorTheme() (D-02 visual identity, inline-style approach to bypass Tailwind purge)"
  - "ChannelRow.tsx: vendor-colored row with inline edit form + Delete (window.confirm); secret preservation via pending=null contract"
  - "HeadCard.tsx: per-head card with rename (disabled on default), channel rows, [+ Add channel ▾] vendor picker, Delete with D-08 tooltip on default"
  - "HeadsTab.tsx: react-query root that renders HeadCards and a [+ New head] inline form; bubbles onSaved() to trigger the existing RestartModal (D-05)"
  - "SettingsModal.tsx: Tab union + tabs array switched 'channels' -> 'heads'; legacy ChannelsTab.tsx kept on disk as visual reference but no longer mounted (D-03)"
affects: [plan-07-typed-confirmation-delete]

tech-stack:
  added: []
  patterns:
    - "Per-card mutation flow (no draft state for heads): each ChannelRow / HeadCard / new-channel / new-head form has its own useMutation hook that calls api.heads.* directly. On success, the mutation calls onSaved() — which the SettingsModal already wires to trigger the RestartModal. This intentionally bypasses the draft + Save pattern used by other tabs because multi-head changes are mandatory-restart per D-05, so batching them behind the modal's Save button has no value"
    - "Inline style for vendor color bands instead of Tailwind classes: vendorTheme(vendor) returns { wrapperStyle, labelStyle } using hex-with-alpha codes (e.g. '#5865F20d' for 5% alpha, '#5865F2b3' for 70% alpha). Tailwind purge never sees the strings, so no safelist entry needed. Matches the visual output of the existing `bg-[#hex]/5 border border-[#hex]/70` pattern in ChannelsTab.tsx exactly"
    - "Secret-preservation via pending=null contract on PATCH bodies: ChannelRow stores per-field pending state — text fields are seeded from the masked channel and only sent in the PATCH body if they differ from the on-disk value; secret fields use `pending: string | null` (null = no change, '' = user cleared, 'newval' = set). This mirrors the SecretInput contract from components.tsx and the buildBody pattern in draft.tsx, and lines up with the backend's `for (const key of Object.keys(patch)) merged[key] = patch[key]` body merge (Plan 05 D-PATCH-MERGE-PRESERVATION)"
    - "Channel-id collision suggestion is client-side only: suggestChannelId(vendor, headId, takenIds) walks `{vendor}-{headId}` -> `{vendor}-{headId}-2` -> `-3` ... using the set of all channel ids currently in the ['heads'] query cache. Server still authoritatively rejects collisions via collectAllChannelIds (Plan 05 D-CHANNEL-UNIQUENESS-HELPER) — the client suggestion is a UX hint only"
    - "ChannelsTab.tsx is left on disk as documented visual reference: the import is removed from SettingsModal.tsx but the file is not deleted. CONTEXT.md explicitly designates it as the canonical color-band reference; this plan extracts the colors into vendor-theme.ts rather than removing the source"

key-files:
  created:
    - dashboard/src/pages/settings/HeadsTab.tsx
    - dashboard/src/pages/settings/HeadCard.tsx
    - dashboard/src/pages/settings/ChannelRow.tsx
    - dashboard/src/pages/settings/vendor-theme.ts
  modified:
    - dashboard/src/types/api.ts
    - dashboard/src/lib/api.ts
    - dashboard/src/pages/settings/SettingsModal.tsx

key-decisions:
  - "Three-component split (HeadsTab + HeadCard + ChannelRow) over a single HeadsTab.tsx — per the plan's `<read_first>` allowance in Claude's Discretion. Rationale: ChannelRow has nontrivial pending-state for five vendor variants and Edit/Delete; HeadCard owns the rename + add-channel picker. Splitting keeps the largest file under ~310 lines and isolates the per-channel state machine from head-level concerns"
  - "Inline CSS style objects instead of Tailwind safelist for vendor color bands — Plan listed both options. Inline-style avoids touching tailwind.config.js, keeps the vendor color mapping in a single TS module, and matches the alpha shading of the legacy ChannelsTab.tsx visually (verified: same bg-{color}0d and border-{color}b3 hex values)"
  - "Heads tab does NOT participate in the draft + Save flow of the SettingsModal — per the plan's explicit guidance. Per-card mutations fire onSaved() directly so the user sees the RestartModal after every mutation. Rationale: multi-head changes are mandatory-restart per D-05, so batching them behind the modal-level Save would only add friction"
  - "Channel rename through the per-row PATCH (id field is editable in the edit form) — relies on Plan 05's D-RENAME-IN-PATCH (rename folded into PATCH, no separate /rename route). The ChannelRow's `handleSave` adds `id` to the patch body only when it differs from `channel.id`, matching the backend's exclude-self uniqueness gate"
  - "ChannelsTab.tsx import removed from SettingsModal.tsx but the file is preserved on disk — `grep -q \"id: 'channels'\" SettingsModal.tsx` returns no match, but `dashboard/src/pages/settings/ChannelsTab.tsx` still exists for visual reference per CONTEXT.md. Vendor color hex codes were lifted from this file into vendor-theme.ts so the design source is canonical and the legacy file is purely historical"
  - "Plan 06 keeps window.confirm for the head Delete button — the threat model T-33-04 row explicitly notes Plan 07 will replace it with the typed-confirmation modal. The server-side D-08 check already prevents accidental default-head deletion regardless"

patterns-established:
  - "Settings tab as react-query root: a tab can opt out of the draft + Save flow by taking only `onSaved: () => void` as a prop and owning its own useQuery + useMutation chain. Useful for any future settings surface that mutates server state through a dedicated REST sub-resource (e.g., a future thresholds tab or scheduled-tasks tab)"
  - "Vendor brand identity as a single TypeScript module with inline CSS objects: vendor-theme.ts is the pattern any future vendor-aware UI (per-vendor analytics, per-vendor diagnostics, vendor-specific onboarding) should consume rather than re-extracting color codes from ChannelsTab.tsx"
  - "Client-side id suggestion helper colocated with the form that uses it: `suggestChannelId` lives inside HeadCard.tsx because that's the only consumer. If a second consumer appears (e.g., a head-clone or import-from-vendor flow), hoist to vendor-theme.ts or a sibling utils module"

requirements-completed: [DASH-03, DASH-04]

duration: 6min
completed: 2026-05-13
---

# Phase 33 Plan 06: Heads Tab Frontend Summary

**The Heads tab ships — Settings > Heads now renders one card per head with inline channel rows, an [+ Add channel ▾] vendor picker, and head create/rename/delete. The legacy Channels tab is hidden (D-03). Every mutation goes through api.heads.* and triggers the existing RestartModal via onSaved(). The default head's Delete button is disabled with the D-08 tooltip. tsc clean (root + dashboard); 66/66 dashboard vitest pass; dashboard build succeeds.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-05-13T21:03:59Z
- **Completed:** 2026-05-13T21:10:02Z
- **Tasks:** 3 (api client + types + vendor theme; three components; SettingsModal wire-in)
- **Files created:** 4 (HeadsTab.tsx, HeadCard.tsx, ChannelRow.tsx, vendor-theme.ts)
- **Files modified:** 3 (types/api.ts, lib/api.ts, SettingsModal.tsx)
- **Total new code:** ~700 lines TS/TSX

## Accomplishments

- **`api.heads.*` client extended (Task 1)** — added `create(id)`, `rename(id, newId)`, `delete(id)`, `addChannel(headId, channel)`, `editChannel(headId, channelId, patch)`, `removeChannel(headId, channelId)` matching the D-16 nested-REST paths verbatim. All methods are typed against the new `HeadDTO` / `ChannelConfigMasked` / `ChannelConfigSubmit` shapes mirrored from `src/dashboard/routes/heads.ts`.
- **Types mirror the backend mask shape (Task 1)** — `ChannelConfigMasked` returns secrets as `{ isSet: boolean }` (D-17); `ChannelConfigSubmit` carries plaintext for POST/PATCH; `HeadDTO` is `{ id, channels: ChannelConfigMasked[] }`. The three are exported from `dashboard/src/types/api.ts` next to `Message` + `DashboardEvent`.
- **`vendor-theme.ts` extracted (Task 1)** — single module owning `Vendor` union, `VENDORS` ordered list, `VENDOR_COLORS` hex map, `VENDOR_LABELS` display map, and `vendorTheme(vendor)` returning inline `{ wrapperStyle, labelStyle }` CSS objects. The inline-style approach sidesteps Tailwind purge so no safelist entry is needed.
- **`ChannelRow.tsx` (Task 2)** — collapsed view shows vendor label + channel id + Edit + Delete; expanded view renders vendor-specific fields (telegram: chatId + botToken; discord: channelId + botToken; slack: channelId + botToken + appToken; whatsapp: allowedJid; zoho-cliq: chatId + clientId + clientSecret + refreshToken). Reuses `Field` + `SecretInput` verbatim. Save builds a partial PATCH body containing ONLY fields the user changed (per the buildBody pattern); secret fields with `pending === null` are omitted (D-17 secret preservation). Delete uses `window.confirm` with the channel id.
- **`HeadCard.tsx` (Task 2)** — head id + rename pencil (hidden on default head per D-08), channel rows list, `[+ Add channel ▾]` vendor picker dropdown that expands into an inline new-channel form. Pre-fills the new channel id with `suggestChannelId(vendor, headId, takenIds)` (D-15 auto-bump on collision against any channel in any head). Delete button has `disabled={isDefault}` plus `title="the default head cannot be deleted"` (D-08 tooltip).
- **`HeadsTab.tsx` (Task 2)** — react-query root: `useQuery(['heads'], api.heads.list)` populates the list; each mutation calls `queryClient.invalidateQueries({ queryKey: ['heads'] })` and then `onSaved()` to trigger the existing RestartModal flow. `[+ New head]` button opens an inline form with client-side `HEAD_ID_REGEX` validation hint; the server re-validates (T-33-03 mitigation).
- **`SettingsModal.tsx` wire-in (Task 3)** — `ChannelsTab` import replaced with `HeadsTab`; `Tab` union switches `'channels'` to `'heads'`; tabs array entry switches `'Channels'` to `'Heads'`; render guard `activeTab === 'channels'` becomes `activeTab === 'heads'`. The HeadsTab receives only `onSaved` (no `d/s/set`) because it owns its data fetch and mutates directly — the modal-level Save button is a no-op for this tab, which is documented with an inline comment near the render guard.

## Task Commits

Three task commits, atomic and sequential:

1. **Task 1:** `48a1bd6` (feat) — `feat(33-06): add api.heads CRUD client + masked channel types + vendor-theme`
2. **Task 2:** `e893fea` (feat) — `feat(33-06): add HeadsTab + HeadCard + ChannelRow components`
3. **Task 3:** `90db91f` (feat) — `feat(33-06): wire HeadsTab into SettingsModal + remove legacy Channels tab`

## Files Created/Modified

### Created
- `dashboard/src/pages/settings/HeadsTab.tsx` (~100 lines) — react-query root, `[+ New head]` form, error/loading states.
- `dashboard/src/pages/settings/HeadCard.tsx` (~310 lines) — per-head card, rename, vendor picker, new-channel form, Delete with D-08 tooltip.
- `dashboard/src/pages/settings/ChannelRow.tsx` (~225 lines) — per-channel collapsed/edit views for all 5 vendors, partial PATCH body builder, window.confirm delete.
- `dashboard/src/pages/settings/vendor-theme.ts` (~50 lines) — Vendor union + color/label maps + vendorTheme() helper (inline CSS objects).

### Modified
- `dashboard/src/types/api.ts` — added `ChannelConfigMasked`, `ChannelConfigSubmit`, `HeadDTO` types (mirrored from `src/dashboard/routes/heads.ts`). Placed adjacent to `Message`/`DashboardEvent` for visual grouping.
- `dashboard/src/lib/api.ts` — extended the `heads:` block: `list` now returns `HeadDTO[]` instead of `Array<{ id }>` (additive widening — pre-existing callers using `.id` still compile); added `create`/`rename`/`delete`/`addChannel`/`editChannel`/`removeChannel`.
- `dashboard/src/pages/settings/SettingsModal.tsx` — import swap (ChannelsTab → HeadsTab); Tab union swap; tabs array entry swap; render guard swap; inline comment near the new render block.

## Decisions Made

- **Three-component split (HeadsTab + HeadCard + ChannelRow)** rather than a monolithic `HeadsTab.tsx` — the plan listed this as Claude's Discretion. The per-channel edit form has nontrivial pending state for 5 vendor variants; isolating it in `ChannelRow.tsx` keeps the head-level concerns (rename, delete, vendor picker) in `HeadCard.tsx` readable.
- **Inline CSS style objects** instead of adding hex codes to a Tailwind safelist — both were listed as valid options in the plan's Task 1 step 3 note. Inline-style avoids touching `tailwind.config.js`, keeps the vendor color mapping in a single TS module, and exactly matches the alpha shading of `ChannelsTab.tsx` (verified by computing `#5865F20d` ≈ `bg-[#5865F2]/5` and `#5865F2b3` ≈ `border-[#5865F2]/70`).
- **Heads tab opts out of the draft + Save flow** — per the plan's explicit guidance. Each mutation calls `onSaved()` directly, so the user sees the RestartModal after every successful change; the modal-level Save is a no-op for this tab.
- **Channel rename folded into the existing PATCH editor** — the `id` field is editable inside the per-row edit form; `handleSave` adds `id` to the patch body only if it differs from `channel.id`. Backend Plan 05 D-RENAME-IN-PATCH handles this without a dedicated route.
- **`ChannelsTab.tsx` kept on disk** — `grep -q "id: 'channels'"` returns no match after Task 3, but the file is preserved for visual reference per CONTEXT.md. Vendor color hex codes were lifted into `vendor-theme.ts` so the design source is now canonical and the legacy file is purely historical.
- **`window.confirm` for head Delete (baseline)** — explicitly anticipated by the plan and the T-33-04 row of the threat model. Plan 07 replaces this with the typed-confirmation modal showing message/channel/queue counts.

## Deviations from Plan

### Auto-fixed Issues

**None.** Plan executed exactly as written. The only optional choices flagged (component split, Tailwind safelist vs. inline style) were both authorized by the plan; the chosen path is documented above. No bugs encountered during typecheck or build.

### Threat-flag scan

No new security-relevant surface beyond what the plan's `<threat_model>` already enumerated:

- **T-33-02 (Secret Disclosure):** Mitigated — `SecretInput` receives `{ isSet: boolean }` only. The plaintext secret only lives in React state when the user is actively typing in the `pending` field; on unmount, GC. The `ChannelConfigMasked` type guarantees the API contract at compile time.
- **T-33-03 (Input Validation):** Mitigated — `HEAD_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/` is enforced client-side in both HeadsTab (create) and HeadCard (rename + new-channel id). The Plan 04 backend re-runs the same regex; a malicious client bypassing the JS hits a 400 from the server.
- **T-33-04 (Auditability / Destructive Action):** Mitigated with caveat — Plan 06 uses `window.confirm` as a baseline; Plan 07 adds the typed-confirmation modal per D-06. The server-side D-08 check prevents accidental default-head delete regardless.
- **T-33-06 (Mass Assignment):** Mitigated — `api.heads.addChannel` body is type-narrowed by `ChannelConfigSubmit`; the backend Zod schema re-validates and strips unknown fields (Plan 05 D-PATCH-MERGE-PRESERVATION). Two layers of allow-list.
- **T-33-13 (UI confusion / Multiple tabs):** Mitigated — legacy ChannelsTab is hidden (D-03); `grep -q "id: 'channels'" dashboard/src/pages/settings/SettingsModal.tsx` returns no match after Task 3.

No new threats introduced; no `## Threat Flags` section needed.

## Issues Encountered

- **None.** All three task commits passed `tsc --noEmit` (root + dashboard) and the dashboard `npm run build` on the first try. Dashboard `vitest run` reports 66/66 pass (no regression in CronPicker, voice-fsm, streamFilter, useVoice tests). The dashboard build artifacts (`dashboard/dist/`) were excluded from the source commits per the project convention that CI rebuilds and commits them.

## User Setup Required

None — this is a frontend-only plan. No new env vars, no new external services, no migration to run. Existing users see the new "Heads" tab the next time they open Settings; the legacy "Channels" tab is no longer rendered.

## Next Phase Readiness

- **Plan 07 (typed-confirmation delete):** READY — the head Delete button is currently wired to `window.confirm` in `HeadCard.tsx`; Plan 07 replaces that block with a portal modal showing message/channel/queue counts. The `api.heads.delete` client + the backend D-07 wipe transaction are already complete from Plans 04 + 06.

No blockers.

## Verification (final)

Manual verification deferred to a human reviewer per the plan's `<verification>` block (open dashboard → Settings → Heads tab → see one card per configured head; expand `[+ Add channel ▾]`; verify RestartModal appears after save). Automated verification:

- `npx tsc --noEmit` (root) — exit 0
- `cd dashboard && npx tsc --noEmit` — exit 0
- `cd dashboard && npm run build` — succeeds (2138 modules, 1116 KB minified)
- `cd dashboard && npx vitest run` — 66/66 tests pass across 4 files

## Self-Check: PASSED

Verified the following commits exist:
- `48a1bd6` (Task 1) — FOUND
- `e893fea` (Task 2) — FOUND
- `90db91f` (Task 3) — FOUND

Verified files exist on disk:
- `dashboard/src/pages/settings/HeadsTab.tsx` — FOUND
- `dashboard/src/pages/settings/HeadCard.tsx` — FOUND
- `dashboard/src/pages/settings/ChannelRow.tsx` — FOUND
- `dashboard/src/pages/settings/vendor-theme.ts` — FOUND

Verified plan acceptance criteria (all grep checks):
- `grep -q "create: (id: string)" dashboard/src/lib/api.ts` — PASS
- `grep -q "rename: (id: string, newId: string)" dashboard/src/lib/api.ts` — PASS
- `grep -q "addChannel" dashboard/src/lib/api.ts` — PASS
- `grep -q "editChannel" dashboard/src/lib/api.ts` — PASS
- `grep -q "removeChannel" dashboard/src/lib/api.ts` — PASS
- `grep -q "ChannelConfigMasked" dashboard/src/types/api.ts` — PASS
- `grep -q "ChannelConfigSubmit" dashboard/src/types/api.ts` — PASS
- `grep -q "HeadDTO" dashboard/src/types/api.ts` — PASS
- `grep -q "VENDOR_COLORS" dashboard/src/pages/settings/vendor-theme.ts` — PASS
- `grep -q "VENDOR_LABELS\[channel.vendor" dashboard/src/pages/settings/ChannelRow.tsx` — PASS
- `grep -q "suggestChannelId" dashboard/src/pages/settings/HeadCard.tsx` — PASS
- `grep -q "the default head cannot be deleted" dashboard/src/pages/settings/HeadCard.tsx` — PASS
- `grep -q "api.heads.addChannel\\|api.heads.editChannel\\|api.heads.removeChannel" dashboard/src/pages/settings/HeadCard.tsx dashboard/src/pages/settings/ChannelRow.tsx` — PASS
- `grep -q "SecretInput" dashboard/src/pages/settings/ChannelRow.tsx` — PASS
- `grep -q "queryKey: \\['heads'\\]" dashboard/src/pages/settings/HeadsTab.tsx` — PASS
- `grep -q "id: 'heads'" dashboard/src/pages/settings/SettingsModal.tsx` — PASS
- `grep -q "id: 'channels'" dashboard/src/pages/settings/SettingsModal.tsx` — returns nothing (legacy channels tab removed)
- `grep -q "import HeadsTab" dashboard/src/pages/settings/SettingsModal.tsx` — PASS
- `grep -q "activeTab === 'heads'" dashboard/src/pages/settings/SettingsModal.tsx` — PASS
- `grep -q "activeTab === 'channels'" dashboard/src/pages/settings/SettingsModal.tsx` — returns nothing

---
*Phase: 33-multi-head-management-ui*
*Completed: 2026-05-13*
