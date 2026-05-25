# Phase 42: Outbound HA REST Announce - Context

**Gathered:** 2026-05-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Stand up the **outbound** leg of the `home-assistant` channel: when `home-assistant`
is the last-active channel and **no live `/v1` turn is held open** (`pendingReply === null`),
background results are spoken on the configured satellite by calling Home Assistant's
REST API — `POST {haBaseUrl}/api/services/assist_satellite/announce` (and the
parameterized `start_conversation` variant), fire-and-forget with a 30s timeout.

This fills in the `pendingReply === null` branch of `adapter.send()` — today a
log-and-drop stub at `src/channels/home-assistant/adapter.ts:79` — with a real
Node `fetch` to HA. Background events that reach this path are the existing ones:
async sub-agent completions, reminders (incl. ack-required nags), and scheduled
fires, routed to HA by the existing `lastActiveChannel` behavior.

**In scope:**
- The outbound `announce` REST call from `adapter.send()` when `pendingReply === null`
  (HAAN-01): `POST {haBaseUrl}/api/services/assist_satellite/announce` with
  `Authorization: Bearer ${HA_ACCESS_TOKEN}` (read from `.env` at call-time) and a
  body targeting the configured satellite entity (`haVoiceSatelliteEntityId`).
- Fire-and-forget semantics with a **30s timeout** so a stuck/offline/asleep
  satellite never hangs the head's activation loop (HAAN-02 / SC3); **no retry loop**.
- The **`start_conversation` parameterized variant** of the same `assist_satellite`
  call path exists (HAAN-03 "one parameterized mechanism"), but is **not auto-selected**
  by the channel-agnostic head — see D-01. announce is the only auto-triggered outbound
  in v1.5.
- Failure handling per D-03: **fast errors throw** (router cross-channel fallback);
  **30s timeout logs and continues** (no throw).
- HA bearer token **log redaction** — see D-05 (carry-forward from the Phase 40 review).
- Verification via tests with the HA REST endpoint **mocked** (no live HA, no device).

**Out of scope (explicitly later phases — do NOT build here):**
- Any **live VPE / real-device** testing, exact 30s/timeout tuning, the
  `start_conversation` reply round-trip validation, and the HADOC-01 setup guide → **Phase 43**.
- **Satellite-state pre-check** (P6 device-initiated-turn collision avoidance) → **Phase 43** (D-02).
- **Live entity-existence verification** (boot or lazy) → not built; trust the config (D-04).
- Applying/curl-verifying the Apache `/v1` auth-bypass on the live server → **Phase 43**.
- Multi-device routing from `device_id` → **HAAN-F-01**, past v1.5.
- Any change to `lastActiveChannel` / `agent_completed` channel resolution → by design, untouched.

</domain>

<decisions>
## Implementation Decisions

### D-01 — The head stays channel-agnostic; the adapter chooses announce vs start_conversation
- **The head never knows which channel a user is talking through or listening through.**
  This is a locked design principle (consistent with `lastActiveChannel` "respond
  wherever you're talking"). Therefore the announce-vs-`start_conversation` choice is
  **NOT** a head tool, **NOT** a head-set `send()` param, and **NOT** any head-visible
  concept. The decision belongs entirely in the **channel-aware adapter layer**.
- **The selection rule is simple and settled:** if there is an **open conversation**
  (a pending live turn, `pendingReply !== null`), the reply resolves the held HTTP slot
  (Phase 41 path). If there is **no open conversation** (`pendingReply === null`), the
  adapter uses **`announce`**. announce is the obvious, and only auto-selected, outbound
  mechanism for Phase 42.
- **`start_conversation` is the available parameterized variant** of the same
  `assist_satellite` call path (satisfies HAAN-03's "one parameterized mechanism,
  parameterized by intent"), but it is **not auto-triggered** by inference (no
  trailing-`?` heuristic, etc.). *How/whether* it ever fires, and its reply round-trip,
  is a **Phase 43** live concern (relates to HACV-F-02). The planner should build the
  call path parameterized (announce | start_conversation) but wire only announce as the
  live trigger.

### D-02 — No busy-satellite pre-check in Phase 42 (defer P6 to Phase 43)
- **No `GET /api/states/<entity>` pre-check** before announcing. The announce fires
  regardless of the satellite's current state; the fire-and-forget + 30s timeout (D-03)
  is the only protection.
- Rationale: the P6 race is a **device-initiated** wake-word turn that never hit Shrok's
  `/v1` (so `pendingReply` is `null` and Shrok cannot see it). Its mitigation cannot be
  meaningfully validated without real hardware, so any state-check/skip/retry tuning is
  **deferred to the Phase 43 live test**. Keeps Phase 42 fully testable now.

### D-03 — Failure & timeout handling: fast errors fall back, 30s timeout logs only
- **Fast errors** — HA unreachable, connection refused, HTTP 4xx/5xx — the adapter
  **throws** so the existing router retry+fallback (`src/channels/router.ts:23-41`)
  re-sends the result to the first **other** channel ("⚠️ Your home-assistant channel
  appears to be down…"). The result reaches the user *somewhere* rather than being lost.
- **30s playback-timeout** (the `assist_satellite.announce` REST call holds open until
  playback finishes; a timeout means HA *accepted* the call but never confirmed —
  the stuck-in-RESPONDING bug, P5): **log and continue — do NOT throw.** HA already
  accepted the call, so throwing would risk **double-delivery** (spoken on the device
  *and* re-sent to a text channel) and would pin the head's activation loop chasing a
  fallback. The result stays in Shrok's memory.
- **No retry loop** (SC3). Note: the router's single re-call of `send()` on a thrown
  fast-error is **one retry, not a loop** — SC3 is satisfied. (Planner: be aware that a
  thrown fast-error causes one re-announce attempt before the cross-channel fallback;
  for a hard error that second attempt fails fast, which is acceptable.)
- Mechanism is the planner's discretion (e.g. `AbortController` + `Promise.race` with a
  30s timer); the **observable contract** above is what's locked.

### D-04 — Trust the configured satellite entity_id; no existence verification
- **No live existence check** of `haVoiceSatelliteEntityId` — neither at boot nor lazily
  on first use. Phase 40's **format regex** (`^assist_satellite\.[a-z0-9_]+$`) remains
  the only validation.
- A wrong/renamed entity surfaces on the **first announce** as a fast HTTP error, which
  per D-03 throws → router cross-channel fallback + log. That failure mode is already
  handled, so a dedicated check buys little and a boot-time check would couple Shrok's
  startup to HA reachability.

### D-05 — Redact the HA bearer token in outbound logs (carry-forward from Phase 40 review)
- Phase 42 is where the outbound `Authorization: Bearer ${HA_ACCESS_TOKEN}` header is
  first sent. The Phase 40 code review flagged (forward-looking) that `HA_ACCESS_TOKEN`
  is **not yet in the log-redaction set**. The planner MUST ensure the token / the
  `Authorization` header is **never logged** (strip it from any request logging; add the
  key to the redaction set if one exists). See PITFALLS § Security Mistakes
  ("Logging full request body including Authorization header").

### Claude's Discretion
- Exact REST payload field names/shape (`{ entity_id, message }` for announce; the
  `start_message`/question phrasing for `start_conversation`) — follow the HA REST API
  contract; verify against `.planning/research/ARCHITECTURE.md` Decision 3.
- The timeout mechanism (`AbortController` + `Promise.race`, or `fetch` signal) and the
  exact 30s constant location/name.
- File layout: whether the outbound caller is a method on `HomeAssistantChannelAdapter`
  (e.g. `announceOrStartConversation(text, wantsReply?)`) or a small helper in
  `src/channels/home-assistant/` — the research suggests an adapter method.
- Whether the `start_conversation` variant is a `wantsReply` boolean param or a separate
  method — as long as it is **not** head-visible (D-01) and announce is the live trigger.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & scope
- `.planning/REQUIREMENTS.md` — **HAAN-01, HAAN-02, HAAN-03** (this phase's requirements);
  also the "Out of Scope" table (no device control, single entity, async model preserved)
  and Future Requirements **HAAN-F-01** (multi-device), **HACV-F-02** (start_conversation
  context threading) — both confirm what is deferred.
- `.planning/ROADMAP.md` § "Phase 42: Outbound HA REST Announce" — goal + the 4 success
  criteria. **Note:** SC4 ("head can choose start_conversation") is reframed by **D-01** —
  the *adapter* owns the choice and announce is the only auto-trigger; `start_conversation`
  is the parameterized-but-not-auto-selected variant. Read D-01 alongside SC4.

### Milestone research (HIGH confidence, verified against live source)
- `.planning/research/SUMMARY.md` § "Phase C: Outbound HA REST Announce" and § "Architecture
  Approach" (announce/start_conversation as one parameterized `send()` branch; 30s
  fire-and-forget).
- `.planning/research/ARCHITECTURE.md` § "Decision 3: Outbound Announce / Start-Conversation
  Path" (HA REST target, payload shape, `announceOrStartConversation` method, device
  targeting via config `entity_id`) and § "Outbound Unprompted (background event)" data-flow.
- `.planning/research/PITFALLS.md` — **P5** (satellite stuck in RESPONDING → 30s
  fire-and-forget, no retry), **P6** (announce racing a live turn — deferred per D-02),
  **P10** (entity_id vs device_id — config stores entity_id; existence check skipped per D-04),
  and § "Security Mistakes" (do not log the Authorization header — D-05).
- `.planning/research/STACK.md` — confirms **no new npm deps**: Node 22 built-in `fetch`
  for the HA REST call.
- `.planning/research/FEATURES.md` — outbound announce/start_conversation feature list.

### Prior phase context (carry-forward)
- `.planning/phases/41-inbound-synchronous-reply-endpoint/41-CONTEXT.md` — **D-01** (the
  `send()` decision branch; `pendingReply === null` is *this* phase's announce seam, left
  as a clean stub), the `pendingReply` slot lifecycle, and `adapter.send()` exactly-once
  semantics that this phase extends.
- `.planning/phases/40-config-adapter-skeleton/40-CONTEXT.md` — **D-04** (single global
  `HA_ACCESS_TOKEN` in `.env`, single instance / one satellite), **D-02** (entity-id format
  regex), **D-06** (fixed channel id `'home-assistant'`).
- `.planning/STATE.md` § "Key Architecture Decisions (v1.5)" — the upstream-locked items
  (announce 30s fire-and-forget; announce vs start_conversation as one parameterized
  mechanism; no `lastActiveChannel`/`agent_completed` changes).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/channels/home-assistant/adapter.ts` — current state: `send()` resolves the held
  HTTP slot when `pendingReply !== null` and **logs-and-drops** at line 79 when `null`.
  Phase 42 replaces that log-and-drop branch with the real `announce` REST call (D-01).
  The constructor already reads `HA_INBOUND_API_KEY`; the **outbound** `HA_ACCESS_TOKEN`
  is read at call-time (Phase 40 D-04) — confirm it's available where the fetch runs.
- `src/channels/voice/adapter.ts` — `VoiceChannelAdapter`, the established single-active-
  session analogue (shape reference only; voice has no REST callback).
- Node 22 built-in `fetch` — the HA REST client; no dependency (research STACK).
- `openai` SDK types (already present) — only for the inbound response shape (Phase 41);
  outbound HA payloads are small hand-rolled objects.

### Established Patterns
- `src/channels/router.ts:12-43` — `ChannelRouterImpl.send()`: on `adapter.send()` **throw**
  it retries once after 2s, then falls back to the **first other** channel with a
  "⚠️ Your {channel} appears to be down" prefix (truncated to 500 chars). **D-03 relies on
  this**: the adapter throws on fast errors to trigger this fallback, and does NOT throw on
  the 30s timeout. `lastActiveChannel` is set on a successful `send()` (line 21/29).
- `src/head/activation.ts:975/977` — the head's final reply is delivered via
  `await this.opts.channelRouter.send(sendChannel, lastAssistantContent[, attachments])`.
  `sendChannel` comes from `lastActiveChannel`. This is the path that reaches the HA
  adapter for background events — **untouched** by this phase (ARCHITECTURE anti-patterns).
- Phase 40 D-05 posture: the stub `send()` was "loud-but-safe, never throws." Phase 42
  **intentionally changes** that for the **fast-error** path (now throws so the router
  fallback fires, D-03) — a deliberate, documented divergence, not a regression.

### Integration Points
- `src/channels/home-assistant/adapter.ts` — the `pendingReply === null` branch of `send()`
  becomes the announce caller (new method, e.g. `announceOrStartConversation(text, wantsReply?)`).
- HA REST: `POST {haBaseUrl}/api/services/assist_satellite/{announce|start_conversation}`,
  `Authorization: Bearer ${process.env['HA_ACCESS_TOKEN']}`, body targets
  `haVoiceSatelliteEntityId`. `haBaseUrl` + `haVoiceSatelliteEntityId` come from the
  per-channel config (Phase 40).
- No changes to `QueueStore`, `ActivationLoop`, `AppStateStore`, `lastActiveChannel`
  routing, or `agent_completed` resolution (by design).

</code_context>

<specifics>
## Specific Ideas

- **Channel-agnostic head is the load-bearing principle here.** The user was emphatic:
  "the head should have no concept of what channel a user is talking through or listening
  through." Any design that leaks channel awareness into the head (a `start_conversation`
  tool, an HA-specific param) is rejected. The adapter is the only channel-aware layer.
- **announce is the obvious outbound for the no-open-conversation case** — "anything else
  would be dumb." The planner should not introduce inference heuristics to auto-pick
  `start_conversation`.
- **Deliver-elsewhere-on-hard-failure is preferred over silently dropping** — the user
  chose router cross-channel fallback for fast errors specifically so a result isn't lost
  when HA is down.

</specifics>

<deferred>
## Deferred Ideas

- **`start_conversation` auto-trigger + reply round-trip** — the parameterized variant is
  built/available at the adapter, but *how/whether* it ever fires and how the spoken reply
  stitches back through `/v1` is a **Phase 43** live concern (relates to HACV-F-02).
- **P6 collision avoidance** (satellite-state pre-check / skip-when-busy / retry queue) —
  **Phase 43** live tuning (D-02).
- **Live entity-existence verification** (boot or lazy `GET /api/states/<entity>`) — not
  built; trust the config (D-04). Could be revisited if first-use diagnostics prove poor.
- **Multi-device routing from `device_id`** — **HAAN-F-01**, past v1.5 (single configured
  entity for now).

None — discussion stayed within phase scope (no scope creep surfaced).

</deferred>

---

*Phase: 42-outbound-ha-rest-announce*
*Context gathered: 2026-05-24*
