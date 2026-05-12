# Requirements — v1.3 Multi-Head Support

**Defined:** 2026-05-12
**Core Value:** A single coherent AI identity that remembers everything, works across every channel, and delegates to agents — without ever losing the thread.

## v1.3 Requirements

### Data Layer

- [ ] **DATA-01**: Migration assigns `head_id = 'default'` to all existing `queue_events` rows so single-head deployments continue working unchanged
- [ ] **DATA-02**: Migration assigns `head_id = 'default'` to all existing `messages` rows
- [ ] **DATA-03**: `QueueStore.claimNext(headId)` atomically claims only events belonging to the specified head
- [ ] **DATA-04**: `MessageStore.getRecent(headId, tokenBudget)` returns conversation history scoped to the specified head

### Core Activation

- [x] **CORE-01**: `ActivationLoop` is parameterized by `headId` and scopes all queue and message operations to that head
- [x] **CORE-02**: Per-head last-active-channel stored as `{headId}:lastActiveChannel` in `AppStateStore`
- [x] **CORE-03**: Per-head archival lock stored as `{headId}:archivalLock` in `AppStateStore` so concurrent heads cannot race on archival
- [ ] **CORE-04**: Each head owns an independent `ChannelRouter` instance populated only with its assigned adapters

### Adapter Registry

- [ ] **ADPT-01**: Channel adapters accept a `headId` config field and stamp it on every inbound event they enqueue
- [ ] **ADPT-02**: Multiple adapter instances of the same vendor type can be registered with distinct IDs (e.g., `telegram-personal`, `telegram-work`)

### Config & Startup

- [ ] **CONF-01**: `config.json` accepts a `heads` array where each entry has an `id` and a `channels` list of adapter IDs
- [ ] **CONF-02**: When no `heads` array is configured, a single implicit `default` head is used (backward compatible with all existing deployments)
- [ ] **CONF-03**: Startup creates one `ActivationLoop` and one `ChannelRouter` per configured head

### Dashboard

- [ ] **DASH-01**: Dashboard displays a head selector so the user can switch the active head context
- [ ] **DASH-02**: Conversation view returns only messages scoped to the currently selected head

## Future Requirements

### Dashboard Management

- **DASH-F-01**: Dashboard allows creating and deleting heads without editing config.json directly
- **DASH-F-02**: Dashboard shows per-head usage metrics (tokens, cost)
- **DASH-F-03**: Dashboard allows renaming heads and reassigning channel adapters from the UI

### Cross-Head Features

- **XH-F-01**: Agent running under one head can send a message that surfaces in another head's conversation
- **XH-F-02**: Schedules and reminders can be assigned to a specific head

## Out of Scope

| Feature | Reason |
|---------|--------|
| Cross-head message passing | Heads are independent; routing between them adds complexity without clear benefit at this stage |
| Per-head identity or skills | Core design principle — single identity, shared context across all heads |
| Per-head memory | Shared memory is what makes heads feel like one entity rather than separate bots |
| Creating/deleting heads from dashboard UI | Config-driven approach keeps head lifecycle explicit and auditable |
| Multi-process isolation | Single process + SQLite WAL is sufficient; multiprocessing adds ops complexity |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DATA-01 | Phase 29 | Pending |
| DATA-02 | Phase 29 | Pending |
| DATA-03 | Phase 29 | Pending |
| DATA-04 | Phase 29 | Pending |
| CORE-01 | Phase 30 | Complete |
| CORE-02 | Phase 30 | Complete |
| CORE-03 | Phase 30 | Complete |
| CORE-04 | Phase 30 | Pending |
| ADPT-01 | Phase 31 | Pending |
| ADPT-02 | Phase 31 | Pending |
| CONF-01 | Phase 31 | Pending |
| CONF-02 | Phase 31 | Pending |
| CONF-03 | Phase 31 | Pending |
| DASH-01 | Phase 32 | Pending |
| DASH-02 | Phase 32 | Pending |

**Coverage:**
- v1.3 requirements: 15 total
- Mapped to phases: 15 (roadmap complete)
- Unmapped: 0 ✓

---
*Requirements defined: 2026-05-12*
*Last updated: 2026-05-12 — traceability filled after roadmap creation*
