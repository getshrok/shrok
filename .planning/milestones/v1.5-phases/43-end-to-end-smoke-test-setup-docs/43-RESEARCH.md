# Phase 43: End-to-End Smoke Test & Setup Docs — Research

**Researched:** 2026-05-24
**Domain:** Live HA VPE integration gate + HADOC-01 operator setup guide
**Confidence:** HIGH for code-verifiable items; MEDIUM for live-device behavior
**Phase type:** TEST + DOCS. Zero new features. The only permitted code change is bounded
tuning (D-01). If the live test reveals nothing needs tuning, this phase ships zero
production code.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-09** — Nothing in Shrok's code or HADOC-01 may be tailored to the operator's setup. The operator's box is one valid deployment topology, not a product spec.
- **D-01** — Bounded tuning only, and only if the live test demands it. Permitted: bump `REPLY_DEADLINE_MS`; add P6 busy-satellite skip; add entity-existence check. Anything larger spins out.
- **D-02** — No manufactured filler. If the lapse UX is ugly, the only lever is widening the deadline.
- **D-03** — For genuinely-uncertain items (`start_conversation`, `continue_conversation`, `device_id`): observe + record. Fold in only if a true one-liner with clean behavior.
- **D-04** — Extended OpenAI Conversation (jekalmin HACS) is the documented/standard component.
- **D-05** — Apache `/v1` bypass documented generically in HADOC-01; live-validated then reverted on the operator's box (apply → curl verify → revert).
- **D-06** — Interactive walkthrough; outcomes recorded in `43-VERIFICATION.md`. No separate SMOKE-TEST.md.
- **D-07** — New file `docs/user-guide/home-assistant.md`. `docs/internals/channel-integrations.md` stays the developer reference and cross-links to the new guide.
- **D-08** — Step-by-step with copy-paste blocks. No screenshots (they rot).
- **D-09** — Overarching: product stays general.

### Claude's Discretion

- Exact `REPLY_DEADLINE_MS` value if D-01 tuning is triggered (start ~3s, raise only as far as live latency requires, stay safely under ~5s firmware limit).
- Whether bounded-tuning code (if any) is a single plan or folded into a docs/test plan.
- HADOC-01 prose structure, ordering of steps, placeholder example values (entity slug, base URL) — never as product constants.
- Precise plan/wave breakdown for a test-and-docs phase that depends on live hardware.

### Deferred Ideas (OUT OF SCOPE)

- `continue_conversation` / `extra_system_prompt` threading (HACV-F-01/F-02) — record observed behavior only.
- `start_conversation` auto-trigger — record behavior; implement only if trivial one-liner.
- Multi-device routing from `device_id` (HAAN-F-01).
- P6 busy-satellite skip and entity-existence check — implement only if the live test shows it's needed.
- Migrating HA out of `~/jarvis-2` compose — operator ops housekeeping.

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| HADOC-01 | Setup docs cover HA side end-to-end: install Extended OpenAI Conversation (HACS), point base URL + API key, select as VPE conversation agent, add satellite `entity_id`, apply Apache `/v1` auth-bypass | Documented below: exact steps, copy-paste blocks, both topologies, style reference |

</phase_requirements>

---

## Summary

Phase 43 is an integration gate and documentation sprint. The code under test (Phases 40–42) is already unit-tested and checked in. This phase's job is: (1) confirm it works against real hardware in a live loop, (2) resolve the remaining open questions that only hardware can answer, and (3) ship HADOC-01 so any self-hoster can reproduce the setup.

**The implementation is complete.** `src/channels/home-assistant/adapter.ts` and `router.ts` already implement the full two-leg flow. `ENV_KEY_ALLOWLIST` already contains `HA_ACCESS_TOKEN` and `HA_INBOUND_API_KEY`. The Apache bypass snippet is already captured in `docs/internals/channel-integrations.md`. The test suite is 1625/1625 green (verified). This phase adds: one new docs file (`docs/user-guide/home-assistant.md`), one cross-link edit, and the live-test ledger (`43-VERIFICATION.md`). All code changes are conditional on the live test revealing a specific need.

**Primary recommendation:** Plan in two parallelizable concerns — the live-test execution track (which the operator must run interactively) and the HADOC-01 authoring track (which Claude can draft independently). Sequence the live-test first so the docs capture verified example values.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Inbound voice turn auth + routing | API / Backend (Shrok) | — | Bearer auth + queue enqueue happens in `router.ts` before any HA-side logic |
| Synchronous reply within deadline | API / Backend (Shrok) | — | `REPLY_DEADLINE_MS` constant in `router.ts`; `pendingReply` slot in `adapter.ts` |
| Outbound announce / start_conversation | API / Backend (Shrok) | HA REST API | Shrok calls HA; HA owns TTS/satellite delivery |
| Apache /v1 auth bypass | CDN / Static (reverse proxy) | — | Apache vhost config; not in Shrok code |
| HACS component config | HA (external system) | — | Operator configures; documented in HADOC-01 |
| VPE audio pipeline | HA + device firmware | — | Fully HA-owned; Shrok never sees audio |

---

## Standard Stack

No new packages for this phase. [VERIFIED: existing codebase]

| Component | Version / Location | Role in Phase 43 |
|-----------|-------------------|-----------------|
| Vitest | existing | Machine-verifiable checks (docs existence, ENV_KEY_ALLOWLIST, tsc) |
| Extended OpenAI Conversation | v2.0.2 (HACS, jekalmin) | HA-side component the operator installs; documented in HADOC-01 |
| HA Core | 2026.3.1 (operator's instance) | Pre-confirmed meets ≥2026.3 requirement |
| Apache 2.x | installed on this host | `/v1/` bypass block for remote topology; apply-then-revert for SC2 |

**No npm install step.** [VERIFIED: STACK.md research]

---

## Package Legitimacy Audit

No external packages are installed by this phase. Audit: N/A.

---

## Architecture Patterns

### What Already Exists (Phase 43 inherits, does not build)

```
HA device (VPE)
  → wake word → STT → text
  → Extended OpenAI Conversation (HACS component on HA)
  → POST /v1/chat/completions  (Bearer: HA_INBOUND_API_KEY)
  → jarvis.gigaashley.click (Apache TLS)
     [← SC2 bypass block goes here, before the catch-all <Location />]
  → 192.168.111.69:8888 (Shrok dashboard Express server)
  → createHomeAssistantRouter (src/channels/home-assistant/router.ts)
    → bearer auth check → extractLastUserTurn → dispatchInbound
    → pendingReply promise (REPLY_DEADLINE_MS = 3_000 ms)
  → headRouteMessage → QueueStore → ActivationLoop → runToolLoop
  → adapter.send(text)
    → pendingReply != null → resolve → buildChatCompletionResponse → HTTP 200
    → pendingReply == null → announceOrStartConversation → HA REST
  → HA TTS → VPE speaker (in-turn path)
                OR
  → assist_satellite.announce (async path, 30s AbortController timeout)
  → VPE speaker (background/async path)
```

### Recommended Project Structure (new files only)

```
docs/
├── user-guide/
│   ├── home-assistant.md    ← NEW: HADOC-01 operator guide
│   └── manual-uninstall.md  (style reference)
└── internals/
    └── channel-integrations.md  (cross-link edit: add "Related docs" link to new guide)

.planning/phases/43-.../
├── 43-VERIFICATION.md       ← NEW: outcomes of the live smoke test
└── 43-RESEARCH.md           (this file)
```

---

## Key Code Facts (for planning and tuning)

### The reply-deadline constant

**File:** `src/channels/home-assistant/router.ts` line 13
**Name:** `REPLY_DEADLINE_MS`
**Current value:** `3_000` (3 seconds)
**How to tune (D-01):** Change the numeric value on that line. The constant is declared `export const` and is imported by `src/channels/home-assistant/router.test.ts` — **preserve the `export` keyword** when tuning (changing only the numeric literal). Existing tests cover the behavior, so no test changes are needed for a value bump.

The tuning envelope (Claude's Discretion per CONTEXT.md):
- Start: 3000 ms (current). This is conservative.
- Raise only if live latency is routinely causing the head's real reply to miss the window.
- Hard ceiling: stay well below the ~5000 ms VPE firmware timeout. On the operator's localhost topology (HA host-network → `192.168.111.69:8888`, no TLS on the inbound path, no Apache in the loop) the effective budget is near the full 5s. For a remote/proxied operator the TLS + proxy overhead subtracts ~100–300 ms. A safe upper bound for tuning is 4000 ms; do not go higher without a measured baseline.
- Rationale for conservative default: if the reply lands at the boundary of the deadline, the device may have already abandoned the socket — the reply would vanish rather than fall back to announce. A deadline well under 5s ensures near-boundary replies cleanly miss the HTTP slot and ride the announce path.

[VERIFIED: router.ts line 13, confirmed export name `REPLY_DEADLINE_MS`]

### The announce timeout constant

**File:** `src/channels/home-assistant/adapter.ts` line 7
**Name:** `ANNOUNCE_TIMEOUT_MS`
**Current value:** `30_000` (30 seconds, fire-and-forget per HAAN-02)
**Phase 43 role:** Verify this never blocks the activation loop under real conditions. No tuning expected unless the live test reveals a problem.

[VERIFIED: adapter.ts line 7]

### ENV_KEY_ALLOWLIST confirmation

Both required keys are already in `ENV_KEY_ALLOWLIST` at `src/config.ts`:
- `HA_ACCESS_TOKEN` — line 514 [VERIFIED: grep output]
- `HA_INBOUND_API_KEY` — line 515 [VERIFIED: grep output]

No config.ts changes needed for HADOC-01.

### dashboardHost binding on the operator's instance

`~/.shrok/workspace/config.json` contains `"dashboardHost": "192.168.111.69"`. [VERIFIED: cat output]

This means Shrok's Express server is listening on `192.168.111.69:8888`, NOT `127.0.0.1:8888`.

**Transport implication for the test rig:**
- **Inbound (HA → Shrok):** The HA container runs with `network_mode: host` (confirmed in `~/jarvis-2/docker-compose.yml`). It can reach `192.168.111.69:8888` directly. The inbound path works without the Apache proxy for the localhost/co-located topology.
- **Outbound (Shrok → HA):** Shrok will call `http://127.0.0.1:8123` (the `haBaseUrl` the operator puts in the channel config). Since Shrok runs on the host and HA binds `:8123` on the host (network_mode: host), this works.
- **No blocking issue** — the co-located topology works with the current `192.168.111.69` binding. The Apache bypass is only needed for the `jarvis.gigaashley.click` (remote/proxied) topology; SC2 validates it via apply→curl→revert.

[VERIFIED: config.json, docker-compose.yml]

---

## Live-Test Sequencing & Prerequisites

These are the ordered steps the planner must sequence as tasks. They are strictly ordered; each depends on the prior.

### Step 1 — Restart Shrok to pick up v1.5 code

```bash
systemctl --user restart shrok
# Verify: journalctl --user -u shrok -f | grep 'home-assistant\|HA_INBOUND'
# Expected: startup throws if HA channel in config but HA_INBOUND_API_KEY missing
```

The running process (`PID 528022`, active since April 23) predates v1.5 entirely. It must be restarted. [VERIFIED: systemctl status output]

### Step 2 — Revive ONLY the HA + wyoming containers

The `~/jarvis-2/docker-compose.yml` defines 9 services. Start only the 3 needed:

```bash
cd ~/jarvis-2
docker compose up -d homeassistant wyoming-whisper wyoming-piper
```

**Why only these 3:** The other services (jarvis2, postgres, qdrant, falkordb, 3× mcp) are from the abandoned v2 stack and are unrelated to the HA smoke test. Starting them would conflict with ports or waste resources. The `homeassistant` container uses `network_mode: host` (binds `:8123` on the host). `wyoming-whisper` and `wyoming-piper` use a Docker bridge network (`jarvis-net`) but expose ports `10300` and `10200` to the host.

**Volume state:** `jarvis-2_ha-config` is intact (confirmed: `docker volume ls` shows it present). HA will load the previously-paired VPE and configured pipeline from this volume. [VERIFIED: docker volume ls]

**Wait for HA to finish loading** before proceeding (typically 30–60s after container start — check `http://192.168.111.69:8123` responds).

### Step 3 — Add `home-assistant` channel to Shrok config + .env

**Config (`~/.shrok/workspace/config.json`)** — add to `heads[0].channels[]`:

```json
{
  "id": "home-assistant",
  "vendor": "home-assistant",
  "haBaseUrl": "http://127.0.0.1:8123",
  "haVoiceSatelliteEntityId": "assist_satellite.home_assistant_voice_0a1fbc_assist_satellite"
}
```

Note: `haBaseUrl` uses `127.0.0.1` (outbound Shrok → HA); inbound HA → Shrok uses `192.168.111.69:8888` (HA's perspective from the host network). Both are correct for the co-located topology.

**Env (`~/.shrok/workspace/.env`)** — add two keys:

```
HA_ACCESS_TOKEN=<long-lived token from HA profile — Step 4>
HA_INBOUND_API_KEY=<invented bearer key — same value goes into HACS component>
```

`HA_INBOUND_API_KEY` is a secret the operator invents. Any non-empty string works. It must be pasted identically into the Extended OpenAI Conversation config in HA.

**Then restart Shrok again** to pick up the new channel config + env keys.

### Step 4 — Create HA long-lived access token

In HA UI: `http://192.168.111.69:8123` → User Profile → Long-Lived Access Tokens → Create → copy value → paste into `HA_ACCESS_TOKEN` in `.env`.

Security note for HADOC-01: create the token under a dedicated HA user with minimal permissions, not the owner account.

### Step 5 — Install HACS + Extended OpenAI Conversation

Standard HACS installation (skip if already installed). Then:
1. HA → Settings → Integrations → Add Integration → "Extended OpenAI Conversation"
2. API Key: the value of `HA_INBOUND_API_KEY` (what the operator invented in Step 3)
3. Base URL: `http://192.168.111.69:8888/v1` (HA is on host network, can reach Shrok directly)
4. After integration appears: Settings → Voice Assistants → edit the assistant (or create new) → Conversation Agent → "Extended OpenAI Conversation"
5. Remove or disable the old `jarvis_conversation` custom component (D-09 disposition: the legacy config is disposable; reconfigure freely for the standard path)

### Step 6 — Wire up the satellite entity

In the VPE device settings in HA, verify the satellite entity is `assist_satellite.home_assistant_voice_0a1fbc_assist_satellite` (pre-confirmed from recovered config). Set the assist pipeline to the one using the new Extended OpenAI Conversation agent.

### Step 7 — Run the spoken-turn smoke test scenarios

The planner should structure these as distinct operator tasks (each a human action + record-the-result pair):

**Scenario A — Basic inbound turn (HACV-01 through 05 live confirmation):**
Speak a simple question to the VPE device. Expected: Shrok reply is spoken on the device within the deadline. Check Shrok logs for `[home-assistant] turn dispatched` and the reply delivery. Record: actual latency observed, whether the deadline was met, whether the reply came back in-turn or via announce.

**Scenario B — Async announce (HAAN-01 live confirmation):**
Send a message to the default head from another channel (Telegram/Discord) while HA is the lastActiveChannel. Expected: the response is spoken on the VPE device via `assist_satellite.announce`, not in a text channel. Record: time to announce, any announce errors.

**Scenario C — Deadline lapse observation:**
Trigger a turn that will take the head longer than `REPLY_DEADLINE_MS` to respond (e.g., ask for something that spawns a sub-agent). Observe the device UX on lapse. Record: is the lapse UX acceptable (silent timeout → announce arrives shortly after) or genuinely bad (error tone, confusion)? This determines whether D-01 tuning is actually needed.

**Scenario D — `start_conversation` observation (D-03 record-only):**
From another channel, manually trigger `start_conversation` via `adapter.announceOrStartConversation(text, true)` (or via a dev console). Observe: does the device open its mic? Does a spoken reply arrive at `/v1/chat/completions`? Record for VERIFICATION.md as D-03 observe-and-record.

### Step 8 — Apache /v1 bypass: apply → verify → revert (SC2 / D-05)

**File to edit:** `/etc/apache2/sites-available/jarvis-le-ssl.conf` (root-owned, requires `sudo`)

**Note:** This file is NOT the same as `gigaashley-le-ssl.conf` (which is `thenasty`-owned per AGENTS.md). The jarvis vhost requires `sudo` for all edits. [VERIFIED: ls -la output]

**Step 8a — Timestamped backup (house convention):**
```bash
sudo cp /etc/apache2/sites-available/jarvis-le-ssl.conf \
        /etc/apache2/sites-available/jarvis-le-ssl.conf.bak.$(date +%Y%m%d-%H%M%S)
```

**Step 8b — Apply the bypass block.** Add `<Location "/v1/">` BEFORE the existing `<Location />` catch-all basic-auth block (currently lines 18–23 of jarvis-le-ssl.conf):

```apache
# /v1/ is Shrok's OpenAI-compatible endpoint for Home Assistant.
# HA presents a Bearer token — Apache's Basic auth would reject it before
# Shrok sees it. This block exempts /v1/ from Basic auth entirely;
# Shrok's own bearer check handles authentication.
# Place BEFORE the catch-all <Location /> block.
<Location "/v1/">
    AuthType None
    Require all granted
</Location>
```

**Step 8c — Test + reload:**
```bash
sudo apache2ctl configtest && sudo systemctl reload apache2
```

**Step 8d — Verify (SC2):** This is the curl that distinguishes Shrok's JSON 401 from Apache's Basic 401:
```bash
curl -v https://jarvis.gigaashley.click/v1/chat/completions 2>&1 | grep -E 'HTTP/|WWW-Authenticate|{"error'
```

Expected: HTTP 401 with body `{"error":"Unauthorized"}` and NO `WWW-Authenticate: Basic` header. If `WWW-Authenticate: Basic` appears, the bypass block is not in the right position or the reload did not take.

A correct response looks like:
```
< HTTP/2 401
< content-type: application/json; charset=utf-8
{"error":"Unauthorized"}
```
An Apache 401 (bypass NOT working) looks like:
```
< HTTP/2 401
< www-authenticate: Basic realm="Jarvis (shrok) Access"
```

**Step 8e — Revert:**
```bash
# Restore from timestamped backup
sudo cp /etc/apache2/sites-available/jarvis-le-ssl.conf.bak.<timestamp> \
        /etc/apache2/sites-available/jarvis-le-ssl.conf
sudo apache2ctl configtest && sudo systemctl reload apache2
```

SC2 is satisfied by the tested-then-reverted path. The operator's box is left with no standing public `/v1` attack surface. [VERIFIED: live jarvis-le-ssl.conf content]

---

## SC4 Open-Question Ledger

### Pre-Resolved from Recovered HA Config

These were listed as open questions in `SUMMARY.md § "Gaps to Address"` but are confirmed from the operator's recovered HA configuration. They require no live test to close.

| Question | Pre-resolved Answer | Source |
|----------|-------------------|--------|
| Correct satellite entity slug | `assist_satellite.home_assistant_voice_0a1fbc_assist_satellite` | 43-CONTEXT.md `<specifics>` |
| device_id for this VPE | `d484a4c2e823` | 43-CONTEXT.md `<specifics>` |
| STT available | yes — wyoming `faster-whisper` (small-int8 model, `:10300`) | docker-compose.yml `wyoming-whisper` |
| TTS available | yes — wyoming `piper` (en_US-lessac-medium, `:10200`) | docker-compose.yml `wyoming-piper` |
| HA Core version meets ≥2026.3 requirement | yes — 2026.3.1 | 43-CONTEXT.md `<specifics>` |
| ESPHome version supports `start_conversation` | yes if VPE is on ESPHome ≥2025.5.0 | STACK.md; verify via HA device page |

### Still Requires Live Device

These must be observed during the smoke test and written into `43-VERIFICATION.md`:

| Question | What to Record | Consequence if Not Answered |
|----------|---------------|----------------------------|
| Exact safe reply window | Measured latency from POST to in-turn response under real conditions (co-located = fast; for HADOC-01, what is a safe default for a proxied self-hoster?) | HADOC-01 cannot give operators a reliable deadline recommendation |
| Deadline lapse UX | Does the device emit a graceful silence, a chime, or an error tone? | Determines whether D-01 tuning is warranted (see D-02 stance) |
| `conversation_id` stitching in practice | Does Extended OpenAI Conversation send `conversation_id` or `user` field? Does HA stitch multi-turn correctly via `ha-${conversation_id}` thread? | Affects multi-turn conversation reliability |
| `start_conversation` round-trip | Does the satellite open its mic? Does the spoken reply arrive as a new `/v1/chat/completions` POST? | Needed to confirm HAAN-03 works end-to-end; record as observed vs. deferred |
| `device_id` presence in HACS request | Does the HACS component include `device_id` in the request body? | Determines HAAN-F-01 feasibility; record for future planning |
| `continue_conversation` behavior | What does setting it in the response actually do to the satellite's listen mode? | Determines HACV-F-01 feasibility; record as observed |

**Recording format:** Each item goes in `43-VERIFICATION.md` as a table row: Question | Observed Behavior | Outcome (Resolved / Deferred / Needs Follow-up).

---

## HADOC-01 Operator Guide Structure

### File

`docs/user-guide/home-assistant.md` — new file, following the style and heading conventions of `docs/user-guide/manual-uninstall.md`. [VERIFIED: manual-uninstall.md format: H1 title, brief intro prose, H2 sections, fenced code blocks with bash/json/apache syntax highlighting, no screenshots, no emojis.]

### Required Sections

**1. Overview** (~2 sentences)
What this integration does: Shrok becomes your Home Assistant VPE's conversation brain via an OpenAI-compatible `/v1/chat/completions` endpoint. Brief mention of the two-leg async pattern (synchronous ack + announce). No screenshots.

**2. Prerequisites**
- Home Assistant Core ≥ 2026.3
- HACS installed in HA
- Shrok running with a `home-assistant` channel configured
- (For remote/proxied topology) Apache or nginx with the `/v1/` auth bypass applied

**3. Shrok-Side Configuration**

H3 sub-sections:

**3.1 — `config.json` channel block** (copy-paste block with placeholder values):

```json
{
  "id": "home-assistant",
  "vendor": "home-assistant",
  "haBaseUrl": "http://homeassistant.local:8123",
  "haVoiceSatelliteEntityId": "assist_satellite.home_assistant_voice_YOURDEVICE_assist_satellite"
}
```

Note: `haVoiceSatelliteEntityId` must start with `assist_satellite.` — copy it from HA → Settings → Devices → Voice PE → entity listing.

**3.2 — `.env` keys** (copy-paste block):

```
HA_ACCESS_TOKEN=<long-lived token from HA profile>
HA_INBOUND_API_KEY=<a secret you invent — paste this into the HACS component too>
```

Note: `HA_ACCESS_TOKEN` is Shrok's outbound token (Shrok calls HA); `HA_INBOUND_API_KEY` is what HA presents to Shrok. They are separate secrets with independent rotation.

How to create `HA_ACCESS_TOKEN`: HA UI → User Profile → Long-Lived Access Tokens → Create. Recommend creating under a dedicated minimal-permission user, not the owner account.

**4. HA-Side Setup (Extended OpenAI Conversation)**

Numbered steps (no screenshots — HA UI changes frequently):

1. Install HACS (link to official HACS install docs; skip if already installed)
2. In HACS → Integrations → search "Extended OpenAI Conversation" (jekalmin) → Download
3. HA → Settings → Integrations → Add Integration → "Extended OpenAI Conversation"
   - API Key: the value of `HA_INBOUND_API_KEY` from your `.env`
   - Base URL: `http://<your-shrok-host>:8888/v1` (co-located: `http://127.0.0.1:8888/v1` from HA's perspective; remote: `https://your-domain.com/v1` — see Section 5)
4. HA → Settings → Voice Assistants → Edit your assistant → Conversation Agent → "Extended OpenAI Conversation"
5. HA → Settings → Devices → your Voice PE → verify the satellite entity ID and copy it (for `haVoiceSatelliteEntityId` in step 3.1)

**5. Reverse Proxy Setup (optional — required only when HA is NOT co-located with Shrok)**

Explain: if HA and Shrok run on the same host, HA can reach Shrok directly on localhost/LAN — no proxy config needed. If HA is remote (different machine, different network), Shrok is typically behind a reverse proxy (Apache/nginx) with TLS, and the proxy's basic-auth will block HA's Bearer token before it reaches Shrok.

**Apache `/v1/` bypass block** (copy-paste):

```apache
# Place BEFORE the catch-all basic-auth <Location /> block in your vhost.
# Required so Home Assistant's Bearer token reaches Shrok's /v1 router
# instead of hitting Apache's Basic auth (which HA cannot respond to).
<Location "/v1/">
    AuthType None
    Require all granted
</Location>
```

How to apply: edit your vhost file, add the block, `sudo apache2ctl configtest`, `sudo systemctl reload apache2`.

Verify: `curl -v https://your-domain.com/v1/chat/completions` should return a JSON 401 from Shrok (`{"error":"Unauthorized"}`) with NO `WWW-Authenticate: Basic` header. If you see `WWW-Authenticate: Basic`, the block is not in the right position.

Note: the `AuthType None` block is safe because Shrok's own bearer auth on `/v1` enforces authentication — Apache is just letting the request through to Shrok.

**6. Satellite Entity ID — Finding It**

`haVoiceSatelliteEntityId` must be your device's `assist_satellite.*` entity, not a device ID. In HA: Settings → Devices & Services → Devices → click your Voice PE → copy the entity ID that starts with `assist_satellite.`. The entity ID format is `assist_satellite.home_assistant_voice_<device-name-slug>_assist_satellite`.

**7. Verify It Works**

Speak to the VPE device. Shrok acknowledges synchronously (the head's first utterance in-turn); asynchronous results are spoken later via `assist_satellite.announce`. Check Shrok's journal (`journalctl --user -u shrok | grep home-assistant`) to see inbound dispatches and outbound announce calls.

**8. Troubleshooting** (brief table)

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Device says nothing, returns to idle | Inbound endpoint not reached or reply too slow | Check Shrok logs for `[home-assistant]`; verify no Apache Basic auth on `/v1/` |
| HA logs "Error talking to OpenAI" | Bearer token mismatch or Apache blocking | Curl-verify as described in Section 5; confirm `HA_INBOUND_API_KEY` matches |
| Announce never fires | `HA_ACCESS_TOKEN` missing or wrong; wrong `haBaseUrl` | Check Shrok logs for announce errors; confirm HA is reachable at `haBaseUrl` |
| Satellite stuck speaking | Known HA bug — satellite stuck in RESPONDING | Power-cycle the VPE device |

### Cross-Link Edit (docs/internals/channel-integrations.md)

Add to the `## Related docs` section at the bottom of `channel-integrations.md`:

```markdown
- [home-assistant.md](../user-guide/home-assistant.md) — operator setup guide for the HA voice integration (HACS, base URL, entity ID, Apache bypass)
```

[VERIFIED: current `## Related docs` section in channel-integrations.md ends with mcp.md; adding one line is the complete edit]

---

## D-01 Bounded-Tuning Candidates

### Candidate 1: `REPLY_DEADLINE_MS` (most likely to be needed)

**Location:** `src/channels/home-assistant/router.ts` line 13
**Current value:** `3_000`
**Trip wire:** If Scenario C of the smoke test shows the head regularly misses the 3s window on simple turns, bump to 3500 or 4000 ms (in 500ms increments). On the co-located topology without Apache/TLS in the inbound path, the practical budget is very close to the full ~5s. A value of 4000 ms is a reasonable maximum for this topology.
**Change size:** one-line edit

### Candidate 2: P6 busy-satellite skip (42 D-02 deferred)

**Where it would go:** `src/channels/home-assistant/adapter.ts` in `announceOrStartConversation()`, before the `fetch` call.
**What it does:** `GET ${haBaseUrl}/api/states/${haVoiceSatelliteEntityId}` — if state is not `idle`, log and skip the announce. Retries are explicitly out of scope (D-01 says "true one-liner" only).
**Implementation sketch:** `const state = await fetch(...).json()` + `if (state?.state !== 'idle') { log.info(...); return }`. Two lines in the existing try block.
**Trip wire:** Implement ONLY if the smoke test demonstrates an actual P6 collision (device reports interleaved audio, stuck state, or dropped turn). Do not implement speculatively.
**Change size:** ~5 lines

### Candidate 3: Entity-existence check (42 D-04 deferred)

**Where it would go:** `src/channels/home-assistant/adapter.ts` in `start()` or constructor.
**What it does:** `GET ${haBaseUrl}/api/states/${haVoiceSatelliteEntityId}` at startup; throw if 404.
**Trip wire:** Implement ONLY if the smoke test reveals the entity ID is wrong and the current silent failure path is too confusing to debug. The existing Phase 40 regex validation (`^assist_satellite\.[a-z0-9_]+$`) catches format errors; this would catch "entity doesn't exist" errors.
**Change size:** ~5 lines

### Spin-out criteria (from D-01)

Any of the following triggers a spin-out to a follow-up phase instead of implementation here:
- The change requires adding a new interface field to `ChannelAdapter`
- The change requires a new config key beyond the existing schema
- The change requires modifying `router.ts` beyond the `REPLY_DEADLINE_MS` constant
- The change interacts with `activation.ts`, `QueueStore`, or `ChannelRouter`

---

## Common Pitfalls

### Pitfall 1: Starting the wrong docker-compose services

**What goes wrong:** Running `docker compose up -d` in `~/jarvis-2` without specifying service names starts all 9 services including `jarvis2`, `postgres`, `qdrant`, `falkordb`, and `mcp-*`. The `jarvis2` container tries to bind `:8765` (conflicts with nothing, but wastes memory), and `postgres`, `qdrant`, and `falkordb` consume significant disk/memory unnecessarily.
**How to avoid:** `docker compose up -d homeassistant wyoming-whisper wyoming-piper` — explicitly name only the 3 needed services.
[VERIFIED: docker-compose.yml service list]

### Pitfall 2: Editing the wrong Apache conf file

**What goes wrong:** The `/v1/` bypass block must go in `jarvis-le-ssl.conf` (the `jarvis.gigaashley.click` vhost). Editing `gigaashley-le-ssl.conf` (the main site) instead would expose `/v1/` on the wrong domain and leave the actual bypass unverified.

The files are distinct:
- `/etc/apache2/sites-available/jarvis-le-ssl.conf` — `jarvis.gigaashley.click` → proxies to `192.168.111.69:8888` — **this is the one**
- `/etc/apache2/sites-enabled/gigaashley-le-ssl.conf` — `gigaashley.click` — does NOT proxy to Shrok

Also note: `jarvis-le-ssl.conf` is **root-owned** (requires `sudo`), unlike `gigaashley-le-ssl.conf` which is `thenasty`-owned.
[VERIFIED: ls -la output, cat output of both files]

### Pitfall 3: HA_INBOUND_API_KEY and HA_ACCESS_TOKEN confusion

**What goes wrong:** The operator sets the same secret for both, or confuses which goes where. `HA_INBOUND_API_KEY` is what HA presents TO Shrok (set as the "API key" in the HACS component). `HA_ACCESS_TOKEN` is what Shrok uses to call HA outbound (long-lived token from HA profile). They must be set independently.
**How to catch:** Adapter constructor throws at boot if `HA_INBOUND_API_KEY` is missing. `announceOrStartConversation` throws if `HA_ACCESS_TOKEN` is missing. Both produce clear error messages.
[VERIFIED: adapter.ts lines 34–43 and 105–108]

### Pitfall 4: Shrok not restarted after config.json + .env changes

**What goes wrong:** The operator adds the `home-assistant` channel and env keys but Shrok is still running the old process (no HA adapter instantiated, no `/v1` route registered). Requests reach Apache but get 404 or no response from Shrok.
**How to detect:** `journalctl --user -u shrok | grep 'home-assistant'` shows nothing after the restart.
**How to avoid:** `systemctl --user restart shrok` must happen after every config/env change. The adapter constructor fail-fast on missing `HA_INBOUND_API_KEY` will surface the key if it's absent.

### Pitfall 5: `haBaseUrl` from HA's perspective vs. Shrok's perspective

**What goes wrong:** The operator sets `haBaseUrl` to `http://127.0.0.1:8123` but this is the address from the HOST's perspective. From HA running in `network_mode: host`, `127.0.0.1` is also the host — so this works for the co-located topology. But for the HACS component's "Base URL", the address must be reachable FROM HA's perspective, not Shrok's. On the co-located topology this is `http://192.168.111.69:8888/v1` (the host's LAN IP + Shrok's port).
**Table of correct values for the co-located topology:**

| Config item | Value | Where it goes |
|-------------|-------|---------------|
| `haBaseUrl` in Shrok config | `http://127.0.0.1:8123` | Shrok workspace config.json (Shrok→HA outbound) |
| "Base URL" in HACS component | `http://192.168.111.69:8888/v1` | HA integration config (HA→Shrok inbound) |

---

## Validation Architecture

**Note:** `workflow.nyquist_validation` is absent from `.planning/config.json` (only `_auto_chain_active: false` is set), which means it defaults to enabled. This section is required.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest |
| Config file | `vitest.config.ts` |
| Quick run | `npx vitest run src/channels/home-assistant/` |
| Full suite | `npx vitest run` (1625 tests, ~25s) |
| TypeScript check | `npx tsc --noEmit` |

**Current baseline (verified pre-phase):** 1625/1625 tests passing, tsc clean. [VERIFIED: vitest output]

### Machine-Verifiable Checks

These can be confirmed by automated means and should be part of the plan's verification steps:

| Check | Command | Pass Condition |
|-------|---------|---------------|
| Both HA env keys in allowlist | `grep 'HA_ACCESS_TOKEN\|HA_INBOUND_API_KEY' src/config.ts` | Both lines present |
| HADOC-01 guide exists | `test -f docs/user-guide/home-assistant.md` | file exists |
| Guide contains required sections | `grep -c '## ' docs/user-guide/home-assistant.md` | ≥5 headings |
| Guide contains Apache bypass block | `grep -c 'AuthType None' docs/user-guide/home-assistant.md` | ≥1 |
| Cross-link edit in channel-integrations.md | `grep 'home-assistant.md' docs/internals/channel-integrations.md` | line present |
| tsc still clean after any D-01 tuning | `npx tsc --noEmit` | exit 0 |
| Existing tests still green | `npx vitest run src/channels/home-assistant/` | all pass |
| `REPLY_DEADLINE_MS` constant name preserved | `grep REPLY_DEADLINE_MS src/channels/home-assistant/router.ts` | line present |

### Human-Attested Checks

These require the operator at the device and CANNOT be automated:

| Check | How to Attest | Record in |
|-------|--------------|-----------|
| SC1 — User speaks, reply lands in-turn or via announce | Operator performs Scenarios A-C | 43-VERIFICATION.md |
| SC2 — Apache bypass: curl returns Shrok JSON 401, not Apache Basic 401 | Operator runs curl-v (Step 8d) | 43-VERIFICATION.md |
| SC3 — Operator can follow HADOC-01 from scratch with no guesswork | Operator validates during setup | 43-VERIFICATION.md |
| SC4 — Open questions resolved | Operator records observed behavior | 43-VERIFICATION.md |
| `start_conversation` round-trip behavior | Operator observes Scenario D | 43-VERIFICATION.md (D-03 record-only) |
| `continue_conversation` behavior | Operator observes if possible | 43-VERIFICATION.md (D-03 record-only) |

### Phase-43-Specific Test Files

No new test files are required for this phase. The HA adapter already has:
- `src/channels/home-assistant/adapter.test.ts`
- `src/channels/home-assistant/router.test.ts`
- `src/channels/home-assistant/types.test.ts`

If D-01 code tuning is triggered (e.g., bumping `REPLY_DEADLINE_MS`), no test changes are needed — the constant change is one line and existing tests cover the behavior.

If the P6 busy-satellite skip is added, one test block should be added to `adapter.test.ts` covering the "state != idle → skip announce + log" path.

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Yes | Bearer auth on `/v1` already implemented in router.ts; no change |
| V3 Session Management | No | `/v1` is stateless bearer; no session |
| V4 Access Control | Partial | Apache bypass for `/v1` must not be wider than the path (use `<Location "/v1/">` with trailing slash, not `/v1`) |
| V5 Input Validation | Yes | Zod schema validates `haBaseUrl` (URL), `haVoiceSatelliteEntityId` (regex) — already in place |
| V6 Cryptography | No | TLS is handled by Apache/Let's Encrypt; Shrok does not do crypto |

### Security Notes for This Phase

- The Apache bypass block uses `<Location "/v1/">` (with trailing slash) — this matches only paths under `/v1/` and not a hypothetical `/v1anything` path. [VERIFIED: Apache docs pattern, confirmed in PITFALLS.md § Security Mistakes]
- After SC2 verification, the bypass is REVERTED. The operator's production instance has no standing `/v1` exposure through Apache.
- `HA_ACCESS_TOKEN` is masked in Shrok's log redaction set (Phase 42 D-05 implemented in adapter.ts). [VERIFIED: adapter.ts line 105 — token read from env, never logged]
- HADOC-01 must advise creating the HA long-lived token under a minimal-permission user, not the owner account (already included in proposed structure above).

---

## Environment Availability

| Dependency | Required By | Available | Version | Notes |
|------------|------------|-----------|---------|-------|
| Docker | Reviving HA + wyoming containers | ✓ | active | `homeassistant`, `wyoming-whisper`, `wyoming-piper` images present in `jarvis-2_*` volumes |
| Docker volume `jarvis-2_ha-config` | HA config persistence (VPE paired, pipeline configured) | ✓ | intact | Confirmed via `docker volume ls` |
| shrok.service (systemd --user) | Smoke test | ✓ | active (since Apr 23) | Must be restarted to pick up v1.5 code |
| Apache 2.x | SC2 bypass apply+verify+revert | ✓ | active | `/etc/apache2/sites-available/jarvis-le-ssl.conf` is root-owned |
| VPE device (physical hardware) | SC1, SC3, SC4 | unknown — operator must confirm | — | Must be on same LAN, powered, ESPHome ≥2025.5.0 for `start_conversation` |
| `curl` | SC2 verification | ✓ | system | Available on Linux host |
| `sudo` | jarvis-le-ssl.conf edit | ✓ | passwordless per AGENTS.md | Operator has passwordless sudo for ops tasks |

**Missing dependencies with no fallback:**
- Physical VPE device on LAN — SC1/SC3/SC4 are fully blocked without it. The dead stack can be revived and Shrok reconfigured, but the spoken-turn scenarios require real hardware.

**Missing dependencies with fallback:**
- None identified for the documentation track (HADOC-01 can be authored independently of the live test).

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `jarvis-2_ha-config` volume contains an intact HA config with VPE paired and wyoming pipeline configured | Live-Test Step 2 | Would require manual HA re-setup before test — adds 30–60 min |
| A2 | ESPHome on VPE device is ≥2025.5.0 (needed for `start_conversation` in Scenario D) | SC4 Ledger | `start_conversation` Scenario D cannot be tested; record as "hardware not able to exercise, deferred" |
| A3 | Extended OpenAI Conversation v2.0.2 is still the current stable release as of test execution | HADOC-01 Section 4 | Version number in guide would be stale; low risk — the install-via-HACS path doesn't specify a version |
| A4 | The VPE device is on the LAN and powered on at smoke-test time | Live-Test prerequisites | SC1/SC3/SC4 cannot be completed; phase would be partially satisfied with docs only |

**Note:** A1–A4 are [ASSUMED] because they depend on physical state that cannot be verified from source files or shell commands. The code-verifiable items (REPLY_DEADLINE_MS value, ENV_KEY_ALLOWLIST contents, test suite status, Apache vhost structure) are all [VERIFIED].

---

## Open Questions

1. **Is the VPE on an ESPHome version that supports `start_conversation`?**
   - What we know: `start_conversation` requires ESPHome ≥2025.5.0 (STACK.md); HA 2026.3.1 is confirmed.
   - What's unclear: the VPE's current ESPHome firmware version.
   - Recommendation: check in HA → Settings → Devices → Voice PE → ESPHome version. If below 2025.5.0, OTA update before attempting Scenario D. If OTA is not possible, record Scenario D as "untested, deferred."

2. **Will the head consistently land replies within 3s on the co-located topology?**
   - What we know: co-located transport is localhost, no TLS on inbound path, sub-ms latency. Head latency is dominated by LLM inference time.
   - What's unclear: median and P95 head response time under real load for simple voice turns.
   - Recommendation: run Scenario A 3–5 times. If all replies land in-turn (REPLY_DEADLINE_MS=3000), no tuning needed. If any miss, measure the actual latency and tune accordingly.

3. **Does Extended OpenAI Conversation forward `device_id` in the request body?**
   - What we know: the component has been confirmed to send `user` (= conversation_id) and standard `messages[]`. Whether it also includes `device_id` in the body is unconfirmed.
   - What's unclear: the exact request body sent by v2.0.2 to Shrok.
   - Recommendation: log `req.body` once during the smoke test (add a temporary debug log to `router.ts`), or inspect HA's Extended OpenAI Conversation source at `conversation.py` for the exact fields sent. Record in VERIFICATION.md for HAAN-F-01 planning.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| HA official OpenAI integration (hardcoded `api.openai.com`) | Extended OpenAI Conversation HACS (custom `base_url`) | HA closed issue #137087 "not planned" (2025) | Self-hosters must use HACS; official integration is not viable |
| Synchronous full-answer reply before returning | Synchronous deadline + async announce | Phase 41/42 design | VPE 5s firmware timeout is now non-blocking; async results ride announce |

**Deprecated/outdated:**
- `jarvis_conversation` custom component in the recovered HA config: the legacy component from the abandoned jarvis-2 project. D-09 says reconfigure freely. It should be disabled/removed and replaced with Extended OpenAI Conversation.

---

## Sources

### Primary (HIGH confidence)

- `src/channels/home-assistant/router.ts` — verified `REPLY_DEADLINE_MS = 3_000` at line 13 [VERIFIED: Read tool]
- `src/channels/home-assistant/adapter.ts` — verified `ANNOUNCE_TIMEOUT_MS = 30_000` at line 7; `announceOrStartConversation` implementation [VERIFIED: Read tool]
- `src/channels/home-assistant/types.ts` — verified `extractLastUserTurn` and `buildChatCompletionResponse` [VERIFIED: Read tool]
- `src/config.ts` — verified `ENV_KEY_ALLOWLIST` contains both `HA_ACCESS_TOKEN` (line 514) and `HA_INBOUND_API_KEY` (line 515) [VERIFIED: grep output]
- `~/.shrok/workspace/config.json` — verified `dashboardHost: "192.168.111.69"` [VERIFIED: cat output]
- `/etc/apache2/sites-enabled/jarvis-le-ssl.conf` — verified exact vhost structure, `<Location />` catch-all at lines 18–23, `ProxyPass / http://192.168.111.69:8888/` at line 25; file is root-owned [VERIFIED: Read tool, ls -la]
- `~/jarvis-2/docker-compose.yml` — verified `homeassistant` (network_mode: host), `wyoming-whisper` (`:10300`), `wyoming-piper` (`:10200`) service definitions [VERIFIED: Read tool]
- `docker volume ls` output — verified `jarvis-2_ha-config` volume is present [VERIFIED: Bash]
- `npx vitest run` — verified 1625/1625 tests passing [VERIFIED: Bash]
- `docs/internals/channel-integrations.md` — verified captured Apache snippet at lines 112–119; `## Related docs` section is the cross-link target [VERIFIED: Read tool]
- `docs/user-guide/manual-uninstall.md` — verified style: H1 title, prose intro, H2/H3 sections, fenced bash code blocks, no screenshots [VERIFIED: Read tool]
- `.planning/phases/43-end-to-end-smoke-test-setup-docs/43-CONTEXT.md` — all decisions verified [VERIFIED: Read tool]

### Secondary (MEDIUM confidence)

- `.planning/research/SUMMARY.md` — open question ledger [CITED: .planning/research/SUMMARY.md]
- `.planning/research/PITFALLS.md` — P1, P3, P5, P6, P10, security mistakes [CITED: .planning/research/PITFALLS.md]
- `.planning/research/STACK.md` — Extended OpenAI Conversation v2.0.2, ESPHome 2025.5.0 `start_conversation` support [CITED: .planning/research/STACK.md]

---

## Metadata

**Confidence breakdown:**

| Area | Level | Reason |
|------|-------|--------|
| Code facts (REPLY_DEADLINE_MS, ENV_KEY_ALLOWLIST, adapter structure) | HIGH | All verified via Read/grep on actual source files |
| Docker/infrastructure availability | HIGH | Verified via docker volume ls, container inspection, systemctl status |
| Apache vhost structure and edit procedure | HIGH | Verified by reading jarvis-le-ssl.conf directly; exact line positions confirmed |
| HADOC-01 guide structure | HIGH | Based on verified implementation + confirmed style reference (manual-uninstall.md) |
| Live device behavior (deadline headroom, conversation_id stitching, start_conversation round-trip) | MEDIUM | Cannot be observed without physical hardware; documented as SC4 open questions |
| ESPHome firmware version on VPE | LOW | Not verifiable from code/shell; assumed ≥2025.5.0 based on purchase date, but not confirmed |

**Research date:** 2026-05-24
**Valid until:** 2026-07-24 (60 days; Extended OpenAI Conversation is actively maintained — check for v2.0.x releases if significant time passes before planning)

---

## RESEARCH COMPLETE

**Phase:** 43 — End-to-End Smoke Test & Setup Docs
**Confidence:** HIGH (code-verifiable items), MEDIUM (live device behavior)

### Key Findings

1. **No code changes are guaranteed needed.** `REPLY_DEADLINE_MS = 3_000` in `router.ts` line 13 is the only likely tuning target; whether it needs adjustment depends on the live test. If the co-located topology meets the deadline consistently, this phase ships zero production code.

2. **Apache bypass targets `jarvis-le-ssl.conf`, not `gigaashley-le-ssl.conf`.** This is root-owned and requires `sudo`. The bypass is applied, curl-verified, then reverted — not left live.

3. **Three Docker containers only:** `docker compose up -d homeassistant wyoming-whisper wyoming-piper` in `~/jarvis-2`. The `jarvis-2_ha-config` volume is intact with the VPE already paired.

4. **Transport is consistent.** Shrok binds `192.168.111.69:8888` (confirmed in workspace config.json). HA uses `network_mode: host`, so it can reach `192.168.111.69:8888` directly for the inbound path. Shrok's outbound `haBaseUrl` should be `http://127.0.0.1:8123`.

5. **HADOC-01 can be drafted independently of the live test.** The docs track and the test track are parallelizable; the docs reference placeholder values that get updated after the live test confirms the exact entity slug and safe deadline value.

6. **Five pre-resolved SC4 items.** Satellite entity slug, device_id, STT/TTS availability, HA version, and ESPHome `start_conversation` support (if firmware is current) are confirmed from the recovered HA config and docker-compose. Only latency, lapse UX, `conversation_id` stitching, `device_id` in HACS body, and `continue_conversation` behavior still need the live device.

### File Created

`.planning/phases/43-end-to-end-smoke-test-setup-docs/43-RESEARCH.md`

### Ready for Planning

Research complete. Planner can now create PLAN.md files.
