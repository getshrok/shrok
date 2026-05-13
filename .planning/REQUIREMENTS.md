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
- [x] **CORE-04**: Each head owns an independent `ChannelRouter` instance populated only with its assigned adapters

### Adapter Registry

- [x] **ADPT-01**: Channel adapters accept a `headId` config field and stamp it on every inbound event they enqueue
- [x] **ADPT-02**: Multiple adapter instances of the same vendor type can be registered with distinct IDs (e.g., `telegram-personal`, `telegram-work`)

### Config & Startup

- [ ] **CONF-01**: `config.json` accepts a `heads` array where each entry has an `id` and a `channels` list of adapter IDs
- [x] **CONF-02**: When no `heads` array is configured, a single implicit `default` head is used (backward compatible with all existing deployments)
- [x] **CONF-03**: Startup creates one `ActivationLoop` and one `ChannelRouter` per configured head

### Dashboard

- [x] **DASH-01**: Dashboard displays a head selector so the user can switch the active head context
- [x] **DASH-02**: Conversation view returns only messages scoped to the currently selected head
- [ ] **DASH-03**: Dashboard allows creating, renaming, and deleting heads from the UI without editing config.json directly
- [ ] **DASH-04**: Dashboard allows adding, editing, and removing channel adapters within a head, including multiple instances of the same vendor (e.g., two Telegram bots, two Slack workspaces)
- [x] **DASH-05**: Sending a message from the dashboard routes to the currently selected head's outbound channel rather than always to the default head

## Future Requirements

### Dashboard Management

- **DASH-F-02**: Dashboard shows per-head usage metrics (tokens, cost)

### Cross-Head Features

- **XH-F-01**: Agent running under one head can send a message that surfaces in another head's conversation
- **XH-F-02**: Schedules and reminders can be assigned to a specific head

## Out of Scope

| Feature | Reason |
|---------|--------|
| Cross-head message passing | Heads are independent; routing between them adds complexity without clear benefit at this stage |
| Per-head identity or skills | Core design principle — single identity, shared context across all heads |
| Per-head memory | Shared memory is what makes heads feel like one entity rather than separate bots |
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
| CORE-04 | Phase 30 | Complete |
| ADPT-01 | Phase 31 | Complete |
| ADPT-02 | Phase 31 | Complete |
| CONF-01 | Phase 31 | Pending |
| CONF-02 | Phase 31 | Complete |
| CONF-03 | Phase 31 | Complete |
| DASH-01 | Phase 32 | Complete |
| DASH-02 | Phase 32 | Complete |
| DASH-03 | Phase 33 | Pending |
| DASH-04 | Phase 33 | Pending |
| DASH-05 | Phase 33 | Complete |

**Coverage:**
- v1.3 requirements: 18 total
- Mapped to phases: 18 (roadmap complete)
- Unmapped: 0 ✓

---
*Requirements defined: 2026-05-12*
*Last updated: 2026-05-13 — promoted DASH-F-01/F-03 from Future Requirements into active scope as DASH-03/04/05 (multi-head management UI + per-head Send routing)*
