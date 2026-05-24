---
phase: 36-inbound-sender-attribution
plan: 03
subsystem: channel-adapters
tags: [typescript, channel-adapters, discord, telegram, slack, whatsapp, zoho-cliq, ttl-cache]

# Dependency graph
requires:
  - phase: 36-inbound-sender-attribution
    plan: 01
    provides: InboundMessage.senderName?: string optional field + buildPrefixedText choke point in headRouteMessage
provides:
  - Discord adapter populates senderName from member/author fallback chain
  - Telegram adapter populates senderName from from.first_name/last_name/username with 'unknown' fallback
  - Slack adapter populates senderName via TTL-cached users.info resolver (10-min TTL, T-36-04 mitigation)
  - WhatsApp adapter populates senderName from msg.pushName with 'unknown' fallback
  - Zoho Cliq adapter populates senderName from sender.name/id at BOTH handler call sites
  - End-to-end prefix pipeline working: real inbound messages now produce '[Name]: body' on the queue
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Conditional-spread idiom `...(senderName ? { senderName } : {})` for optional field under exactOptionalPropertyTypes (4 of 5 adapters)"
    - "Direct field assignment when chain always resolves (WhatsApp 'unknown' fallback) — also conforms to exactOptional"
    - "TTL-bounded per-instance cache for vendor API lookups (Slack users.info pattern; per-adapter so multi-head isolation is automatic)"
    - "Synchronous senderName capture before void IIFE (Cliq file-message background closure)"

key-files:
  created: []
  modified:
    - src/channels/discord/adapter.ts
    - src/channels/telegram/adapter.ts
    - src/channels/slack/adapter.ts
    - src/channels/whatsapp/adapter.ts
    - src/channels/zoho-cliq/adapter.ts

key-decisions:
  - "Slack uses per-adapter-instance Map<string, {name, fetchedAt}> with 10-min TTL — multi-head isolation automatic because each head constructs its own SlackAdapter"
  - "Slack API failure falls back to raw user id (preserves attribution under Slack degradation) and is NOT cached (allows retry)"
  - "Cliq senderNameOf helper lives inline inside poll() rather than top-level — keeps the diff small and the helper colocated with its only call sites"
  - "WhatsApp + Telegram chain always resolves to a non-empty string ('unknown' fallback per D-05) so the conditional-spread guard is omitted on WhatsApp and kept (defensively) on Telegram"

patterns-established:
  - "Phase 36 supply side: adapters populate raw display names; headRouteMessage owns normalization + prefix construction via buildPrefixedText (Plan 01 choke point)"
  - "Voice, dashboard, and webhook adapters are deliberately NOT modified — they have no per-message sender and inherit the no-prefix path"
  - "Slack TTL-cached resolver pattern usable for other vendor API lookups in future work"

requirements-completed: []

# Metrics
duration: 7min
completed: 2026-05-14
---

# Phase 36 Plan 03: Adapter Sender Extraction Summary

**Wired the supply side of the prefix pipeline — five channel adapters (Discord, Telegram, Slack, WhatsApp, Zoho Cliq) now populate the new optional `senderName` field on `InboundMessage` from each vendor's per-message sender, enabling end-to-end `[Name]: body` queue events for real inbound traffic via Plan 01's central `headRouteMessage` choke point.**

## Performance

- **Duration:** 7 min
- **Started:** 2026-05-14T14:19:16Z
- **Completed:** 2026-05-14T14:26:48Z
- **Tasks:** 5
- **Files modified:** 5

## Accomplishments

- **Discord adapter:** Extracts senderName from `message.member?.displayName ?? message.author.globalName ?? message.author.username` (D-05 chain); conditional-spread idiom omits the field when no source resolves to a non-empty string
- **Telegram adapter:** Extracts senderName from `from.first_name + (' ' + last_name)?` → `'@' + from.username` → `'unknown'` (D-05 chain with always-resolving 'unknown' fallback for channel/anonymous edge cases)
- **Slack adapter:** Added private `senderNameCache: Map<string, {name, fetchedAt}>` with 10-min TTL (`SENDER_NAME_TTL_MS = 10 * 60 * 1000`) and `resolveSlackSenderName()` private method implementing the D-05 chain (`profile.display_name → real_name → user id`) with graceful API-failure fallback to raw user id (NOT cached, allows retry). Inbound handler now `await`s the resolver for messages with a `user` field
- **WhatsApp adapter:** Extracts senderName from `(msg as { pushName?: string | null }).pushName` with `'unknown'` fallback (D-05 chain); cast is minimal because `msg` is loosely-typed in the dynamically-imported Baileys integration
- **Zoho Cliq adapter:** Added inline `senderNameOf(m: CliqMessage): string | undefined` helper inside `poll()` after the early-return guard; updated BOTH handler call sites — file-message background closure (senderName captured synchronously before `void (async () => {…})()` IIFE) and text-only delivery
- **Voice, dashboard, and webhook adapters NOT modified** — they have no per-message sender and inherit the no-prefix path per D-06
- `npx tsc --noEmit` GREEN after every task
- `npx vitest run` GREEN after Tasks 3 and 5 (1489 passed / 1 skipped / 0 failed)

## Task Commits

1. **Task 1: Discord adapter — extract sender from member/author fallback chain** — `7dc24a8` (feat)
2. **Task 2: Telegram adapter — extract sender from from.first_name/last_name/username** — `9f7d58a` (feat)
3. **Task 3: Slack adapter — resolve event.user via cached users.info** — `79f9eb1` (feat)
4. **Task 4: WhatsApp adapter — extract sender from message.pushName** — `c735ff5` (feat)
5. **Task 5: Zoho Cliq adapter — extract sender from msg.sender.name** — `d07c442` (feat)

Plan metadata commit will follow this SUMMARY landing.

## Files Created/Modified

- `src/channels/discord/adapter.ts` — added 6 lines inside `processMessage` just before the `this.handler({...})` call: `const senderName = message.member?.displayName ?? message.author.globalName ?? message.author.username` and a `...(senderName ? { senderName } : {})` spread in the handler object literal
- `src/channels/telegram/adapter.ts` — added 9 lines inside the `bot.on('message')` handler just before the `this.handler({...})` call: `const from = ctx.message.from` plus the nested ternary fallback chain and a `...(senderName ? { senderName } : {})` spread (defensive guard even though the chain always resolves)
- `src/channels/slack/adapter.ts` — added 5 lines to field declarations (cache + TTL constant + 3-line comment), a 19-line private async method `resolveSlackSenderName()`, and 5 lines inside the `app.message` callback (userId extraction + `await this.resolveSlackSenderName(userId)` + conditional-spread). 29 lines net added
- `src/channels/whatsapp/adapter.ts` — added 4 lines inside the `messages.upsert` loop just before the `this.handler({...})` call: minimal cast `(msg as { pushName?: string | null }).pushName` + always-resolving `'unknown'` fallback + direct `senderName,` field (no conditional spread because the chain always resolves)
- `src/channels/zoho-cliq/adapter.ts` — added 8 lines of `senderNameOf` helper inside `poll()` and 5 net lines updating BOTH handler call sites (file-message background closure synchronously captures senderName before void IIFE; text-only delivery has its own local `const senderName = senderNameOf(msg)`)

## Decisions Made

- **D-SLACK-TTL-PER-INSTANCE** (Plan-local, locked by `<action>` Step A): `senderNameCache` lives as a private field on each `SlackAdapter` instance. Multi-head isolation is automatic because each head constructs its own adapter — no cross-head leakage of display names between heads that happen to share user ids
- **D-SLACK-FAILURE-NOT-CACHED** (Plan-local, T-36-04 mitigation refinement): Slack `users.info` exceptions fall back to the raw user id but the failure is NOT stored in `senderNameCache`. This means the next inbound message from the same user retries the API call — preferred over poisoning the cache with the user id and never re-resolving
- **D-CLIQ-INLINE-HELPER** (Plan-local, planner's "cleaner: top-level helper OR inline" choice): `senderNameOf` is defined inline inside `poll()` rather than as a top-level helper. Keeps the diff small; helper is only used at two call sites which are both inside the same loop body
- **D-CLIQ-SYNC-CAPTURE** (Plan-local, mirrors §373-374 pattern): For the file-message background closure, `senderName` is computed synchronously before `void (async () => { … })()` and closed over, matching how `handler` and `channel` are already captured at the same spot. Computing senderName inside the IIFE would be a benign change but breaks the pattern
- **D-WHATSAPP-DIRECT-FIELD** (Plan-local, locked by `<action>` "no conditional spread"): WhatsApp's chain always resolves to a non-empty string ('unknown' fallback per D-05) so the handler object literal writes `senderName,` directly. Conditional-spread would be a no-op but adds visual noise

## Deviations from Plan

None — all five tasks executed byte-identically to the locked `<action>` blocks. All 28 acceptance criteria across the five tasks passed on first run:
- Discord: 6 ACs PASS (including handler-call-count = 1)
- Telegram: 7 ACs PASS
- Slack: 9 ACs PASS (including full `npx vitest run` GREEN)
- WhatsApp: 4 ACs PASS
- Cliq: 6 ACs PASS (including `grep -c "senderName ? { senderName } : {}" = 2` for the two handler sites)

No Rule 1–3 auto-fixes were needed. No CLAUDE.md directives were violated (no `src/icw/` edits, no plain `fs.writeFileSync` on identity/skill files, no `git add .` patterns).

## Issues Encountered

None — every task executed cleanly. The Slack adapter task was the most involved (cache + private method + handler edit + await), but the existing handler was already declared `async ({ message }) => …` so no signature changes were needed. The full vitest suite (1489 tests) passed after Slack's changes confirming that no existing Slack-related test mocked `users.info` in a way that broke under the new lookup — the test surface for Slack is small because Bolt's socket mode is hard to integration-test, and the new field is optional at the type contract.

The PreToolUse:Edit hook reminders fired after each successful edit (one per edit) — these were informational only; all edits applied successfully because the relevant files had been Read earlier in the session. After each reminder I re-read the file as instructed and verified the edit had landed before proceeding.

## Threat Model Status

Plan 03 closes / advances threats forecast by Plan 01:

| Threat ID | Disposition | Status after this plan |
|-----------|-------------|------------------------|
| T-36-04 Slack users.info TTL staleness | accept (with mitigation) | **Mitigated.** TTL is bounded to 10 min via `SENDER_NAME_TTL_MS = 10 * 60 * 1000`; API failure preserves attribution via raw user id fallback without poisoning the cache. Display-name renames propagate within 10 min |

No new threat surface introduced. The five adapter edits are all on existing handler call paths — no new endpoints, no new auth paths, no new file access patterns, no schema changes. Slack adds one new outbound API call (`users.info`) but this is to Slack's own auth-bounded user-info API, the same trust boundary already crossed by every `chat.postMessage` and `chat.update` call elsewhere in the adapter.

## Next Phase Readiness

**Phase 36 is now end-to-end complete.** All three plans have landed:
- Plan 01: type contract + central prefix construction (`buildPrefixedText` in `headRouteMessage`)
- Plan 02: head-side stripper generalization (`stripLeadingBracketPrefixes` defends against model echo-back)
- Plan 03: adapter supply side (this plan — adapters populate `senderName` from each vendor's per-message sender)

A real Discord message from "Ashley" now produces `[Ashley]: <body>` on the queue. A real WhatsApp message from a contact named "Bob" produces `[Bob]: <body>`. A real Cliq message from "Sam" produces `[Sam]: <body>`. The model echoing forged `[Name]:` back is stripped first-line-only by `stripLeadingBracketPrefixes`. All locked threat-model dispositions hold.

No blockers. Phase 36 is ready for `/gsd-transition` to evolve PROJECT.md and the milestone tracker.

## Self-Check: PASSED

Verification commands and results:

- `[ -f src/channels/discord/adapter.ts ]` — FOUND
- `[ -f src/channels/telegram/adapter.ts ]` — FOUND
- `[ -f src/channels/slack/adapter.ts ]` — FOUND
- `[ -f src/channels/whatsapp/adapter.ts ]` — FOUND
- `[ -f src/channels/zoho-cliq/adapter.ts ]` — FOUND
- `git log --all --oneline | grep -q 7dc24a8` — FOUND (Task 1)
- `git log --all --oneline | grep -q 9f7d58a` — FOUND (Task 2)
- `git log --all --oneline | grep -q 79f9eb1` — FOUND (Task 3)
- `git log --all --oneline | grep -q c735ff5` — FOUND (Task 4)
- `git log --all --oneline | grep -q d07c442` — FOUND (Task 5)
- `grep -q "message.member?.displayName" src/channels/discord/adapter.ts` — FOUND
- `grep -q "from.first_name" src/channels/telegram/adapter.ts` — FOUND
- `grep -q "private async resolveSlackSenderName" src/channels/slack/adapter.ts` — FOUND
- `grep -q "this.app.client.users.info" src/channels/slack/adapter.ts` — FOUND
- `grep -q "pushName && pushName.length > 0" src/channels/whatsapp/adapter.ts` — FOUND
- `grep -q "const senderNameOf" src/channels/zoho-cliq/adapter.ts` — FOUND
- `grep -c "senderName ? { senderName } : {}" src/channels/zoho-cliq/adapter.ts` — 2
- `npx tsc --noEmit` exit 0 — PASSED
- `npx vitest run` 1489 passed / 1 skipped / 0 failed — PASSED

---
*Phase: 36-inbound-sender-attribution*
*Completed: 2026-05-14*
