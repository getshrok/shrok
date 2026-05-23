# Requirements — v1.4 Unmissable Reminders

**Defined:** 2026-05-23
**Core Value:** A single coherent AI identity that remembers everything, works across every channel, and delegates to agents — without ever losing the thread.

## v1.4 Requirements

Sourced from SEED-001 (acknowledgment-required reminders, full design settled) and backlog 999.1 (dashboard start-date inputs).

### Acknowledgment-Required Reminders (ACK)

Backend schema + scheduler/activation mechanism + head integration + tool.

- [ ] **ACK-01**: User can create a reminder flagged as acknowledgment-required, which keeps re-firing until the user explicitly acknowledges it
- [ ] **ACK-02**: User can set a nag interval for an ack-required reminder that is independent of its base recurrence (e.g., a weekly reminder that nags hourly until acked)
- [ ] **ACK-03**: The scheduler arms the next nag in code before delivering the current one, so an ack-required reminder keeps nagging even if the head does no work between fires
- [ ] **ACK-04**: Acknowledging a one-time ack-required reminder deletes it so no further nags fire
- [ ] **ACK-05**: Acknowledging a recurring ack-required reminder stops the current occurrence's nag loop while the base recurrence still fires future occurrences
- [ ] **ACK-06**: Acknowledgment cancels the already-armed in-flight nag rather than only setting a flag
- [ ] **ACK-07**: When an ack-required reminder fires, the injected reminder event carries the reminder ID and acknowledgment instructions so the head can mark it acknowledged when the user confirms
- [ ] **ACK-08**: The acknowledgment capability is scoped so the head only applies it to ack-required reminders, never to ordinary reminders
- [ ] **ACK-09**: Reminders created before this milestone (without the new fields) continue firing unchanged via lazy default migration

### Scheduling Dashboard & Docs (SCHED)

Dashboard create/edit form surface + start-date control + tool-description correctness.

- [ ] **SCHED-01**: User can set `requiresAck` and `nagInterval` on a reminder from the dashboard create/edit form
- [ ] **SCHED-02**: Dashboard reminder/schedule views visibly mark which reminders require acknowledgment
- [ ] **SCHED-03**: User can set a start date/time for a recurring schedule, reminder, or task in the dashboard, mapping to `triggerAt` + `cron` (first fire at the start date, then cron cadence)
- [ ] **SCHED-04**: The `create_reminder` tool description accurately documents that `triggerAt` + `cron` together produce start-then-repeat behavior (verify backend, loosen the misleading "one-time only" wording — do not rebuild)

## Future Requirements

Acknowledged but deferred — not in the v1.4 roadmap.

### Acknowledgment UX

- **ACK-F-01**: User can acknowledge a nagging reminder directly from the dashboard (button), not only via the conversational head
- **ACK-F-02**: Ack-required reminder escalates to a different channel after N unacknowledged nags

### Dashboard Management

- **DASH-F-02**: Dashboard shows per-head usage metrics (tokens, cost) — carried over from v1.3

## Out of Scope

| Feature | Reason |
|---------|--------|
| Ack instructions in the global system prompt | Per SEED-001 decision 5 — instructions ride in the injected fire event; worst-case (event ages out before next nag) is one redundant nag, not worth prompt bloat |
| Ack-required as a default/automatic severity | Opt-in only by design — making ordinary reminders nag would cause alarm fatigue (SEED-001 core premise) |
| Max-nag count / auto-stop after N tries | "Unmissable" means it nags until acked; a silent auto-stop would defeat the purpose. Escalation captured as ACK-F-02 future instead |
| Rebuilding start-then-repeat backend | Already supported (`triggerAt` + `cron`); SCHED-04 only verifies + documents it |

## Traceability

Which phases cover which requirements. Filled during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| ACK-01 | TBD | Pending |
| ACK-02 | TBD | Pending |
| ACK-03 | TBD | Pending |
| ACK-04 | TBD | Pending |
| ACK-05 | TBD | Pending |
| ACK-06 | TBD | Pending |
| ACK-07 | TBD | Pending |
| ACK-08 | TBD | Pending |
| ACK-09 | TBD | Pending |
| SCHED-01 | TBD | Pending |
| SCHED-02 | TBD | Pending |
| SCHED-03 | TBD | Pending |
| SCHED-04 | TBD | Pending |

**Coverage:**
- v1.4 requirements: 13 total
- Mapped to phases: 0 (roadmap pending)
- Unmapped: 13 ⚠️

---
*Requirements defined: 2026-05-23*
*Last updated: 2026-05-23 — initial v1.4 definition from SEED-001 + backlog 999.1*
