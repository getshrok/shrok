# Phase 43: End-to-End Smoke Test & Setup Docs - Context

**Gathered:** 2026-05-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Close out v1.5 Home Assistant Voice by **validating the full two-leg voice flow against
the real VPE device** and shipping the **HADOC-01 operator setup guide** so any self-hoster
can wire up the HA side from scratch.

The code for both legs already exists and is unit-tested (Phases 40–42): the inbound
`/v1/chat/completions` held-connection endpoint, the outbound `assist_satellite.announce`
REST caller, config + token redaction. This phase is the **live integration gate** that
those isolated pieces work together end-to-end through a real Extended OpenAI Conversation
component + a real VPE, and the **documentation** that lets others reproduce the setup.

**In scope:**
- **Live smoke test (SC1):** a user speaks to the VPE, Shrok acknowledges synchronously
  (or the turn lapses), and the real answer is spoken on the device unprompted via announce —
  the async two-leg flow confirmed on real hardware.
- **Apache `/v1` auth-bypass (SC2):** documented for remote self-hosters in HADOC-01, and
  live-validated on the operator's box via apply → `curl` JSON-401 verify → revert (D-05).
- **HADOC-01 operator setup guide (SC3):** new `docs/user-guide/home-assistant.md`,
  step-by-step, covering HACS + Extended OpenAI Conversation, base URL + API key, HA
  long-lived token, selecting Shrok as the VPE conversation agent, the satellite `entity_id`,
  the Shrok-side channel config + `.env`, and the optional Apache bypass.
- **Resolve + record the open research questions (SC4):** outcomes recorded in
  `43-VERIFICATION.md` (D-06).
- **Bounded code tuning (D-01):** only the pre-deferred tunables, and only if the live
  test demands them.

**Out of scope (do NOT build here):**
- Any product code or docs **tailored to the operator's own deployment** (D-09) — Shrok
  stays general; the operator's localhost/co-located setup is a test environment only.
- New voice capabilities. `continue_conversation` / `extra_system_prompt` threading
  (HACV-F-01/F-02) and multi-device `device_id` routing (HAAN-F-01) stay deferred past v1.5 —
  **record observed behavior only** (D-03).
- A manufactured stall/filler acknowledgment (D-02 — explicitly rejected again).

</domain>

<decisions>
## Implementation Decisions

### D-09 — Overarching principle: the product stays general; the operator's instance is just one deployment
- **Nothing in Shrok's code or in HADOC-01 may be tailored to the operator's setup.**
  Shrok is for any self-hoster. The operator's instance (HA and Shrok co-located on one box,
  localhost transport, a recovered HA config) is **one valid topology among several**, recorded
  below as the *test environment* — never as product spec.
- The operator's **current HA/device configuration is disposable** ("change whatever"). Do not
  preserve the legacy `jarvis_conversation` custom component or the existing pipeline; reconfigure
  HA freely for the standard path.
- HADOC-01 documents **both topologies**: co-located (HA → Shrok over loopback/LAN, no proxy)
  AND remote/proxied (HA → Shrok through a reverse proxy like Apache, requiring the `/v1` bypass).

### Code-change scope & tuning
- **D-01 — Bounded tuning is in-scope, but only the pre-deferred tunables, only if the live
  test demands them.** Permitted: bump the ~3s reply-deadline constant; add the P6
  busy-satellite skip (42 D-02); add an entity-existence check (42 D-04). Anything larger
  (new features, `continue_conversation`, `start_conversation` auto-trigger) **spins out** to
  a follow-up phase/backlog. This honors the 41/42 deferrals and keeps v1.5 closeable in one
  phase. If the test reveals nothing needs tuning, this phase ships zero production code.
- **D-02 — No manufactured filler. A lapsed turn rides announce.** If the device's lapse UX is
  ugly, the *first and only* lever is widening the deadline so more real head replies land
  in-turn — and only if replies are routinely missing the window. Do NOT add a canned "on it"
  filler (41 D-01's "no manufactured speech" stance is upheld now that the device behavior can
  be observed).
- **D-03 — Genuinely-uncertain items: observe + record, implement only if trivial.** For the
  SC4 unknowns (`start_conversation` end-to-end round-trip, `continue_conversation` behavior,
  `device_id` presence in the HACS request), write down what the device + HACS component
  actually do. Fold something in **only if it is a true one-liner with clean behavior**;
  otherwise leave it as a deferred F-req. Anything the available hardware/HACS can't exercise
  is recorded as "untested, deferred" rather than blocking the phase.

### HA-side integration (product)
- **D-04 — The documented/standard component is Extended OpenAI Conversation (HACS).** It is
  the only actively-maintained component with a custom `base_url` (HA's official OpenAI
  integration hardcodes `api.openai.com`, issue #137087 closed "not planned"), it sends
  non-streaming Chat Completions, and it is exactly what Shrok's `/v1/chat/completions` was
  built for. Requires HA Core 2026.3+. HADOC-01 walks the operator through installing HACS,
  adding the component, setting the base URL + API key (`HA_INBOUND_API_KEY`), and selecting
  Shrok as the VPE pipeline's conversation agent.

### Apache `/v1` auth-bypass (SC2)
- **D-05 — Documented generically; live-validated then reverted on the operator's box.**
  HADOC-01 MUST document the `<Location "/v1/"> AuthType None / Require all granted</Location>`
  block (placed before the catch-all basic-auth) for self-hosters who run Shrok behind a
  reverse proxy — this is a non-negotiable part of the requirement. For the operator's own
  (co-located, localhost) instance the bypass is **not operationally needed**, so the live
  validation is: **apply the vhost block → `curl -v https://jarvis.gigaashley.click/v1/chat/completions`
  and confirm Shrok's JSON-401 (not Apache's `WWW-Authenticate: Basic`) → revert the edit.**
  SC2 is satisfied by a tested-then-reverted path; the operator's box is left localhost-only
  with no standing public `/v1` attack surface. (Captured snippet already lives in
  `docs/internals/channel-integrations.md`; house convention = timestamped `.conf.bak` →
  `apache2ctl configtest` → `systemctl reload apache2`.)

### Smoke-test execution & recording
- **D-06 — Interactive walk-through, no standalone test artifact; outcomes recorded in
  `43-VERIFICATION.md`.** Claude prompts each step (revive HA, restart Shrok, configure the
  component, then the spoken-turn scenarios), the operator runs it against the real device and
  reports results, and the open-question → outcome ledger (deadline headroom, `conversation_id`
  stitching, `start_conversation` round-trip, `device_id` presence, confirmed satellite slug)
  is written into the phase VERIFICATION.md. No separate `SMOKE-TEST.md`.

### Setup docs (HADOC-01)
- **D-07 — Home: new `docs/user-guide/home-assistant.md`.** Operator-facing, alongside
  `manual-uninstall.md`. `docs/internals/channel-integrations.md` stays the *developer*
  reference and cross-links to the new guide (no operator walkthrough crammed into internals).
- **D-08 — Depth: step-by-step with copy-paste blocks, no screenshots.** Numbered HA-side
  steps + the Shrok-side `config.json` `home-assistant` channel block + `.env` keys + the
  optional Apache bypass. Copy-paste config/`.env`/apache snippets; deliberately no
  screenshots (they rot as HA's UI changes).

### Claude's Discretion
- The exact reply-deadline value if D-01 tuning is triggered (start ~3s, raise only as far as
  the live latency requires while staying safely under the device's ~5s firmware timeout).
- Whether the bounded-tuning code (if any) is a single plan or folded into a docs/test plan.
- HADOC-01 prose structure, ordering of steps, and which example values to show (entity slug,
  base URL) as **placeholders/examples** — never as product constants.
- The precise plan/wave breakdown for a test-and-docs phase that depends on live hardware in
  the loop.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & scope
- `.planning/REQUIREMENTS.md` — **HADOC-01** (this phase's requirement); the Future
  Requirements **HACV-F-01/F-02** (`continue_conversation`, `extra_system_prompt`) and
  **HAAN-F-01** (multi-device `device_id`) that stay deferred; the Out of Scope table.
- `.planning/ROADMAP.md` § "Phase 43" — goal, the 4 success criteria, and the **HIGH research
  flag** (live VPE). **Note:** SC2 is reframed by **D-05** (documented + applied-then-reverted,
  not left live) because the operator's deployment is co-located.

### Milestone research (the open questions SC4 resolves)
- `.planning/research/SUMMARY.md` § "Phase D: End-to-End Smoke Test" and § "Gaps to Address" —
  the live-VPE open questions; several are **pre-resolved** from the recovered HA config (see
  `<specifics>`). Also § "Critical Pitfalls".
- `.planning/research/PITFALLS.md` — **P1** (5s device timeout / deadline headroom),
  **P3** (Apache auth bypass — D-05), **P5** (satellite stuck in RESPONDING),
  **P6** (announce racing a live turn — bounded-tuning candidate per D-01),
  **P10** (entity_id vs device_id).
- `.planning/research/ARCHITECTURE.md` — Decision 3 (outbound announce/start_conversation path)
  and the end-to-end data flow.
- `.planning/research/STACK.md` — Extended OpenAI Conversation v2.0.2 (HACS, jekalmin),
  HA Core 2026.3+ requirement, no new npm deps.
- `.planning/research/FEATURES.md` — must/should/anti-feature list.

### Existing implementation & docs
- `src/channels/home-assistant/` — the built adapter (`adapter.ts`), `/v1` router (`router.ts`),
  OpenAI-compat + HA payload types (`types.ts`) from Phases 40–42; the subjects of the smoke test.
- `docs/internals/channel-integrations.md` § "Home Assistant" — the existing **developer**
  reference + the **captured (recorded, not applied) Apache `/v1` snippet** that D-05 applies/reverts.
- `docs/user-guide/manual-uninstall.md` — style/format reference for the new operator guide (D-07).

### Prior phase context (carry-forward)
- `.planning/phases/41-inbound-synchronous-reply-endpoint/41-CONTEXT.md` — **D-01**
  (~3s deadline + stall-filler deferred to *this* phase), **D-03** (Apache live edit deferred here).
- `.planning/phases/42-outbound-ha-rest-announce/42-CONTEXT.md` — **D-01** (`start_conversation`
  built but not auto-selected), **D-02** (P6 busy-satellite deferred here), **D-03** (failure
  semantics: fast errors fall back, 30s timeout logs-only), **D-04** (trust the entity, no existence check).
- `.planning/STATE.md` § "Key Architecture Decisions (v1.5)".

### Operator test environment (NOT product — informs the live test only)
- `~/jarvis-2/docker-compose.yml` — the abandoned stack that defines the `homeassistant`
  (`network_mode: host`) + `wyoming-whisper` (:10300) + `wyoming-piper` (:10200) containers to revive.
- `~/AGENTS.md` (home server) — `gigaashley-le-ssl.conf` ownership + edit convention, dnsmasq
  (`jarvis.gigaashley.click` → `192.168.111.69`), the `shrok` systemd `--user` service.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`src/channels/home-assistant/{adapter,router,types}.ts`** — the full inbound+outbound
  implementation already exists and is unit-tested; Phase 43 exercises it live, it does not
  rebuild it. Any change is limited to the D-01 bounded tuning.
- **`docs/internals/channel-integrations.md`** — already documents the HA adapter internals and
  holds the captured Apache snippet; the new operator guide cross-links to it rather than duplicating.
- **`src/config.ts` `ENV_KEY_ALLOWLIST`** — already allows `HA_ACCESS_TOKEN` (Phase 40) and
  `HA_INBOUND_API_KEY` (Phase 41); HADOC-01's `.env` block references these exact keys.

### Established Patterns
- **Docs taxonomy** — `docs/user-guide/` = operator-facing, `docs/internals/` = developer-facing
  (D-07 follows this). `docs/overview.md` and `docs/cheatsheet.md` are the discovery entry points
  a link could be added to.
- **Reply-deadline / announce contract** — locked in 41/42; the live test validates it and may
  only tune the deadline constant (D-01/D-02).

### Integration Points
- **New file:** `docs/user-guide/home-assistant.md` (HADOC-01).
- **Cross-link edit:** `docs/internals/channel-integrations.md` "Related docs" → the new guide.
- **Operator config (test rig, not committed product):** a `home-assistant` channel entry in
  `~/.shrok/workspace/config.json` + `HA_ACCESS_TOKEN` / `HA_INBOUND_API_KEY` in that workspace's
  `.env` — values are the operator's, shown in HADOC-01 only as placeholders.

</code_context>

<specifics>
## Specific Ideas

### Operator test environment (this instance only — MUST NOT shape product code/docs)
The live smoke test runs on the operator's box, where HA and Shrok are **co-located** and the
HA setup is **recoverable**. These are deployment facts for running the test, not product spec:

- **Home Assistant 2026.3.1** was installed via the abandoned `~/jarvis-2` Docker Compose stack
  (`homeassistant` with `network_mode: host` → binds `:8123` on the host; `wyoming-whisper` STT
  `:10300`; `wyoming-piper` TTS `:10200`). Container is **down**; base image present; the config
  volume `jarvis-2_ha-config` is **intact** (VPE paired, assist pipeline configured).
- **Pre-resolved SC4 facts (from the recovered config):**
  - Satellite entity: `assist_satellite.home_assistant_voice_0a1fbc_assist_satellite`
    (device "Home Assistant Voice PE", Nabu Casa, `device_id d484a4c2e823`).
  - STT/TTS available: wyoming `faster-whisper` + `piper` (and ElevenLabs alternates).
  - HA version meets the Core 2026.3+ requirement.
- **Transport (operator instance):** localhost — HA (host network) → `http://192.168.111.69:8888/v1`
  inbound; Shrok → `http://127.0.0.1:8123` outbound (`haBaseUrl`). No Apache/TLS on the live legs;
  the 5s device-timeout budget is trivially met. **NOTE:** Shrok currently binds
  `192.168.111.69:8888` only (not `127.0.0.1`).
- **Test-rig prerequisites (planner should sequence these):**
  1. `systemctl --user restart shrok` — the running process predates v1.5 (no `/v1`, no HA adapter).
  2. Revive **only** the HA + wyoming containers from `~/jarvis-2` (not the whole dead stack).
  3. Create an HA long-lived access token → `HA_ACCESS_TOKEN`; invent `HA_INBOUND_API_KEY`.
  4. Add a `home-assistant` channel to `~/.shrok/workspace/config.json`.
  5. Install HACS + Extended OpenAI Conversation; point its base URL at Shrok; select it as the
     VPE pipeline's conversation agent; (legacy `jarvis_conversation` component is discarded).

### Product intent
The operator "wants the device set up," but **explicitly: nothing in Shrok's code is tailored to
this situation** — general decisions only. HADOC-01 is written for anyone.

</specifics>

<deferred>
## Deferred Ideas

- **`continue_conversation` / `extra_system_prompt` threading** (HACV-F-01/F-02) — past v1.5.
  Record observed behavior during the live test (D-03); do not implement.
- **`start_conversation` auto-trigger + spoken-reply round-trip** — record behavior; implement
  only if it proves a trivial one-liner (D-03), else stays deferred.
- **Multi-device routing from `device_id`** (HAAN-F-01) — single configured entity for v1.5.
- **P6 busy-satellite skip / entity-existence check** — implement **only if** the live test
  shows it's needed (the D-01 bounded-tuning allowance); otherwise leave for a later polish phase.
- **Migrating HA out of the abandoned `~/jarvis-2` compose into a clean dedicated stack** —
  operator ops housekeeping, not part of this phase's product scope.

None of these are product scope for Phase 43 — discussion stayed within the test + docs boundary.

</deferred>

---

*Phase: 43-end-to-end-smoke-test-setup-docs*
*Context gathered: 2026-05-24*
