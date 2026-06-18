| 47. Head Runs Agent Tools | v1.9 | 3/3 | Complete | 2026-06-07 |
| 48. Sensor Backend | v1.10 | 3/3 | Complete    | 2026-06-17 |
| 49. Sensors Dashboard | v1.10 | 3/3 | Complete    | 2026-06-18 |

### Phase 50: Per-head xray isolation — eliminate cross-head agent-activity bleed in the dashboard timeline

**Goal:** When a head is selected, the dashboard shows only that head's agent activity, steward runs, memory retrievals, and agent pills — and nothing from any other head — on both initial backfill and live streaming, including across head switches. Closes the four documented "accepted cross-head leakage" surfaces (T-33-09): `agent_message_added`, `agent_status_changed`, `memory_retrieval`, `steward_run_added`. Single-head deployments see zero behavior change.
**Requirements**: D-01, D-02, D-03, D-04 (CONTEXT.md locked decisions; no REQ-IDs mapped in roadmap)
**Depends on:** Phase 49
**Plans:** 3/4 plans executed

Plans:
**Wave 1**

- [x] 50-01-PLAN.md — steward_runs head_id migration + StewardRunStore threading + head-scoping test (Wave 1)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 50-02-PLAN.md — tag the 4 leaky SSE events with headId at emit + dual DashboardEvent union lockstep (Wave 1)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 50-03-PLAN.md — head-scope the backfill REST routes (?head=) + client api wrappers (Wave 2)

**Wave 4** *(blocked on Wave 3 completion)*

- [ ] 50-04-PLAN.md — expand SSE filter drop set + head-key caches + reset-on-switch effects + tests (Wave 2)
