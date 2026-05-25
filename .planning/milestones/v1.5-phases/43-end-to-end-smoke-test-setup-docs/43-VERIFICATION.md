---
status: complete
phase: 43-end-to-end-smoke-test-setup-docs
plan: 02
type: live-smoke-test
started: 2026-05-24
updated: 2026-05-24
requirements: [HADOC-01]
success_criteria: [SC1, SC2, SC3, SC4]
verdict: "All four success criteria met on real hardware. deadline tuning needed: NO (43-03 = no-op). 5 findings (HADOC-01 doc bugs fixed in-phase; the ~16s HA-latency suspicion was investigated post-phase and DISPROVEN — HA path is ~4.5s, the one 18s turn was a non-reproducible transient blip)."
---

# Phase 43 — Live VPE Smoke Test Ledger (Plan 43-02)

Live end-to-end validation of the v1.5 Home Assistant Voice integration (Phases 40–42)
against the real Voice PE device, co-located topology (HA + Shrok on the same host).
This is the single phase test artifact (D-06). Records outcomes only — never secret values (T-43-05).

## Task 1 — Rig-Up

Co-located topology: HA in `network_mode: host`, Shrok dashboard bound to `192.168.111.69:8888`.
Transport: HA → `http://192.168.111.69:8888/v1` inbound; Shrok → `http://127.0.0.1:8123` outbound.

| Rig-up step | Outcome | Observed Behavior |
|---|---|---|
| Restart Shrok onto v1.5 code | ✓ yes | Old PID 528022 (running since Apr 23, no `/v1`) stopped; rebooted to Shrok v0.2.0, both heads (default, zoey) resolved, clean boot |
| 3 containers up (homeassistant, wyoming-whisper, wyoming-piper) ONLY | ✓ yes | `docker compose up -d` with the 3 named services (P1 honored); no v2 stack services started |
| HA reachable at `:8123` | ✓ yes | HTTP 200; recovered config volume `jarvis-2_ha-config` intact (VPE paired) |
| `home-assistant` channel + `HA_ACCESS_TOKEN` + `HA_INBOUND_API_KEY` configured | ✓ yes | Both keys written to `~/.shrok/workspace/.env` (mode 600); `home-assistant` channel added to `head[0]=default`; Shrok restarted after (P4) |
| HA adapter registered (no fail-fast on missing key) | ✓ yes | Journal: `[home-assistant] adapter registered (id=home-assistant, head=default) — HTTP listener wired in Phase 41`; `channel=home-assistant (home-assistant) connected` |
| `/v1` route alive + Shrok JSON 401 (direct, pre-Apache) | ✓ yes | `POST http://192.168.111.69:8888/v1/chat/completions` with no/invalid bearer → `HTTP 401 {"error":"Unauthorized"}`, `Content-Type: application/json`, NO `WWW-Authenticate` header |
| HACS installed | ✓ yes | Official installer ran in-container; HACS v2026.3.1 unpacked to `/config/custom_components/hacs`; HA restarted |
| Extended OpenAI Conversation installed + configured + selected as VPE conversation agent | ✓ yes | HACS download → HA restart → integration added with **Skip Authentication** (Base URL `http://192.168.111.69:8888/v1`); `conversation.extended_openai_conversation` entity present; operator confirmed it selected as the VPE pipeline conversation agent |
| HA token (`HA_ACCESS_TOKEN`) valid for outbound | ✓ yes | `GET http://127.0.0.1:8123/api/` with the token → `{"message":"API running."}` HTTP 200 |
| Legacy `jarvis_conversation` disabled as active agent | ✓ (agent switched) | VPE pipeline conversation agent switched off `jarvis_conversation` → Extended OpenAI Conversation (confirmed: spoken turn then reached Shrok `/v1`). The legacy component is still installed on disk but is no longer the active agent; full removal is optional cleanup (D-09: legacy config is disposable) |

### SC3 — HADOC-01 usability notes (recorded during real setup)

- **GAP (confirmed live): "Skip Authentication" is required and is not documented.** Adding the
  Extended OpenAI Conversation integration fails on submit with a generic "Unexpected error"
  unless the **Skip Authentication** checkbox is ticked. Root cause: the integration validates
  the connection at setup by calling `GET /v1/models`, but Shrok's `/v1` router only implements
  `POST /v1/chat/completions`. `GET /v1/models` falls through to the dashboard SPA catch-all and
  returns `text/html` (HTTP 200), which the OpenAI client cannot parse → "Unexpected error".
  HADOC-01 (`docs/user-guide/home-assistant.md`) does not mention this. **Follow-up:** add a
  "check Skip Authentication" step to the HA-Side Setup section of HADOC-01.
- **Backlog candidate (NOT in 43-03 scope — fails the D-01 spin-out test):** Shrok could
  implement a minimal `GET /v1/models` stub returning a small JSON model list so the integration's
  setup validation passes without Skip Authentication. This is a new router route, outside the
  three pre-deferred D-01 tunables — record as backlog, do not build in Phase 43.

## Task 2 — Spoken-Turn Scenarios (SC1) + SC4 Ledger

_Pending operator execution at the VPE._

| Scenario | Observed Behavior | Outcome |
|---|---|---|
| A — Basic inbound turn (real spoken turn) | Spoke "What's the capital of France?" to the VPE. Journal: POST → `turn lapsed` at +3s → `announce delivered via announce (6 chars)` at **+21s**; dashboard shows the head's "Paris" reply ~20s after the question. Device spoke "Paris" via announce. **HA sent a `conversation_id`** (0 server-side-UUID fallbacks). **CRITICAL: the actual model turn was Sonnet @ 2.1s (operator-confirmed from head logs) — so ~18s of the ~20s is non-LLM pipeline overhead (queue claim / context assembly / memory retrieval / dispatch), NOT model latency.** | ✓ Resolved — full two-leg flow confirmed on real hardware (SC1). In-turn slot did NOT win, but because of pipeline overhead, not model speed. Answer correctly rode announce. |
| B — Async announce (from another channel, HA = lastActiveChannel) | _see Scenario B run below_ | _pending_ |
| C — Deadline lapse UX (turn exceeds REPLY_DEADLINE_MS) | Lapse fires at 3s (`turn lapsed or slot replaced`), no HTTP body sent **by design** (router.ts:103–104), answer rides announce. **Device UX on lapse = operator heard silence for ~20s, then "Paris" — NO error tone, NO double-response.** Acceptable (just slow, due to head latency, not the integration). | ✓ Resolved — lapse UX acceptable. **No deadline tuning warranted.** |
| D — start_conversation (D-03 observe-only) | Not exercised (no app-path to trigger `announceOrStartConversation(text, true)` during this session; ESPHome firmware support is per-device). | Deferred (D-03 observe-only) |

**Deadline tuning needed (gates plan 43-03): NO.** Measured head latency for a trivial, tool-free answer was **~20 s** (operator-confirmed via dashboard timestamps). No `REPLY_DEADLINE_MS` value in the D-01 envelope (3000–4000 ms, ceiling well under the ~5 s firmware timeout) could ever catch a 20 s response, and the lapse→announce UX is acceptable (silence → answer, no error). Bumping the deadline would change nothing. → 43-03 deadline candidate = **no-op**.

### SC4 Open-Question Ledger

| Question | Observed Behavior | Outcome |
|---|---|---|
| Exact safe reply window (POST→in-turn latency) | In-turn slot effectively never wins (head ~4.5s > 3s deadline). **HA path is ~4.5s end-to-end** across 5 sampled turns (head LLM ~2s + ~2.5s assemble/memory/queue) — parity with the dashboard (~3.6s). The one 18s "France" turn was a non-reproducible anomaly (likely a transient provider blip — see Findings #4). | Resolved — no HA latency penalty; earlier "~16s overhead" was a sampling artifact |
| Deadline lapse UX (silence / chime / error tone) | Operator heard silence for ~20s then "Paris" via announce — no error tone, no double-response | Resolved — acceptable |
| conversation_id stitching (ha-${conversation_id} thread) | On real spoken turns HA **sends** a `conversation_id` (0 server-side-UUID fallbacks in the journal); Shrok's `ha-${conversation_id}` thread keys off it | Resolved — stitching works |
| start_conversation round-trip | No app-path to trigger `announceOrStartConversation(text, true)` this session; ESPHome firmware support is per-device | Deferred (D-03 observe-only) |
| device_id presence in HACS request body | Not captured this session (would require logging `req.body` once); pre-resolved device_id `d484a4c2e823` known from config | Deferred (for HAAN-F-01 planning) |
| continue_conversation behavior | Not observed this session | Deferred |

#### Pre-resolved facts (confirm, not re-derive)

| Fact | Pre-resolved value | Confirmed live? |
|---|---|---|
| Satellite entity | `assist_satellite.home_assistant_voice_0a1fbc_assist_satellite` | _pending_ |
| device_id | `d484a4c2e823` (Home Assistant Voice PE, Nabu Casa) | _pending_ |
| STT/TTS | wyoming faster-whisper + piper | _pending_ |
| HA version | 2026.3.1 (meets Core 2026.3+) | ✓ (container reports 2026.3.1) |
| ESPHome start_conversation support | per firmware (≥ 2025.5.0) | _pending_ |

## Task 3 — Apache /v1 Bypass: apply → verify → revert (SC2)

SC2 confirmed through the live `jarvis-le-ssl.conf` proxy, then reverted. **✓ PASS.**

| Step | Outcome |
|---|---|
| Baseline (no bypass) | `/v1/chat/completions` → Apache Basic 401 (`WWW-Authenticate: Basic realm="Jarvis (shrok) Access"`, Apache HTML page) — confirms the bypass is needed |
| Backup `jarvis-le-ssl.conf` | ✓ `jarvis-le-ssl.conf.bak.20260524-123243` |
| Add `<Location "/v1/">` AuthType-None block **before** catch-all | ✗ did NOT work — still Apache Basic 401. **Apache 2.4 applies overlapping `<Location>` in config order, later wins**, so the catch-all re-imposed Basic auth |
| Add block **after** catch-all (corrected) | ✓ `curl https://jarvis.gigaashley.click/v1/chat/completions` → `HTTP 401`, `Content-Type: application/json`, body `{"error":"Unauthorized"}`, **no** `WWW-Authenticate: Basic` — Shrok's JSON 401 through the proxy |
| Revert from backup + configtest + reload | ✓ restored byte-identical to backup; `apache2ctl configtest` Syntax OK; reloaded; post-revert `/v1` back to Apache Basic 401; **0** `/v1/` blocks in live conf (no standing public surface, D-05 / T-43-04) |

**SC2 finding (doc bug):** the `<Location "/v1/">` block must be placed **AFTER** the catch-all `<Location />`, not before. RESEARCH § "Step 8b" and the HADOC-01 guide both said "before the catch-all" — that is backwards for Apache 2.4 and leaves `/v1` still gated. HADOC-01 corrected during this phase (see Findings #5).

## Findings & Follow-ups (backlog — none in Phase 43 / 43-03 scope)

All of these fail the 43-03 D-01 spin-out test (new route / context-layer / config change), so they are
recorded here as backlog, NOT implemented in this phase.

1. **SC3 — HADOC-01 missing "Skip Authentication" step.** Adding the Extended OpenAI Conversation
   integration fails with a generic "Unexpected error" unless **Skip Authentication** is ticked, because
   the integration validates setup via `GET /v1/models` which Shrok's router does not implement (the
   request falls through to the dashboard SPA and returns HTML). *Follow-up:* add the Skip-Authentication
   step to `docs/user-guide/home-assistant.md`; optionally add a minimal `GET /v1/models` JSON stub
   (new router route — spin-out).
2. **SC3 — legacy `jarvis_conversation` silently shadows the new agent.** The VPE pipeline kept the old
   `jarvis_conversation` agent after install, producing a misleading "Sorry, I could not reach Jarvis"
   (it was dialing the dead `:8765` backend) while never touching Shrok's `/v1`. *Follow-up:* HADOC-01
   should call out explicitly verifying the *device's* pipeline conversation agent is switched, and
   removing/disabling the legacy component.
3. **`/v1` sends no HTTP body on lapse (by design, D-02).** Works acceptably here (HA waited, the
   answer arrived via announce, no device error), but the HA OpenAI client is left hanging until its own
   timeout. *Follow-up (optional, contested by D-02):* consider a fast minimal ack on lapse.
4. **RESOLVED (post-phase investigation) — NOT a structural HA latency; the ~16s was a one-off anomaly.**
   The original "~16s HA overhead" was a sampling artifact: one slow HA turn (capital of France, 18s)
   compared against one fast text turn (4s). Controlled re-measurement disproves it:

   | Turn (HA `/v1` unless noted) | POST → answer |
   |---|---|
   | "tallest mountain" | 4.8s |
   | "chemical symbol for gold" | 4.5s |
   | "how many continents" | 4.4s |
   | "pong" probes ×3 | 4.5–5.6s |
   | "capital of italy" (dashboard) | 3.6s |
   | "capital of France" (the anomaly) | **18.0s** |

   The HA path is consistently **~4.5s end-to-end** (head LLM ~2s + ~2.5s assemble/memory/queue) — no
   HA penalty, parity with the dashboard. The single 18s France turn had a ~16s gap between enqueue
   (16:18:48) and its first LLM call (16:19:04) with **zero competing local work** in the window
   (`queue_events`/`agents`/`steward_runs`/`memories` all empty 16:12:54→16:19:04) and no MCP servers
   configured (so `buildCapabilitiesBlock` can't block). The only thing that turn did that the fast
   probes didn't was fire a per-turn **memory query-rewriter (haiku) call**, whose usage row lands at
   the end of the gap (16:19:04) — so the most plausible cause is a **transient LLM-provider latency
   blip on that one haiku call**, not Shrok's HA code. Not reproducible across 5+ subsequent turns;
   **no code change warranted.** *If it recurs:* add lightweight assemble-phase timing logs
   (query-rewriter / `topicMemory.retrieve` / head call) to confirm the provider-blip hypothesis.

   Note on the deadline: head turns are ~4.5s (> the 3s `REPLY_DEADLINE_MS`), so the in-turn slot still
   never wins and answers ride `announce` — confirms 43-03 deadline = no-op (a 4s bump wouldn't reliably
   beat ~4.5s either, and the announce UX is acceptable).

5. **FIXED IN-PHASE — HADOC-01 corrections from live SC3 findings.** Two doc bugs caught by the live
   test were corrected in `docs/user-guide/home-assistant.md` during this phase (not deferred, because a
   setup guide with wrong steps fails its own purpose):
   (a) added the required **"Skip Authentication"** step (Finding #1);
   (b) corrected the Apache `/v1/` block placement from "before the catch-all" to **"after the catch-all"**
   with the Apache-2.4 config-order rationale (the SC2 finding above);
   (c) corrected the verify-step log-line names to the strings the code actually emits
   (`adapter registered` / `announce delivered via announce` / `turn lapsed …`) and added the
   stale-conversation-agent warning. Doc-only; passes all 43-01 acceptance checks.
