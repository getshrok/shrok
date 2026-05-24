# Phase 39: Dashboard Reminder UI - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-23
**Phase:** 39-Dashboard Reminder UI
**Areas discussed:** Nag interval input, Ack visual marker (SCHED-02), Start-date for recurring (SCHED-03), Edit vs creation-only

---

## Nag interval input

### Q1 — How should the reminder form capture the nag interval?

| Option | Description | Selected |
|--------|-------------|----------|
| Multi-slot integers | min/hr/day inputs summed to nagIntervalMinutes; mirrors create_reminder tool | ✓ |
| Single minutes field | One "Nag every N minutes" input | |
| Value + unit dropdown | Number + unit dropdown (minutes/hours/days) | |

**User's choice:** Multi-slot integers
**Notes:** Honors the Phase 37 "clean dashboard mapping" intent; no parsing, consistent with the tool's slot model.

### Q2 — How should the requiresAck toggle relate to the nag-interval inputs?

| Option | Description | Selected |
|--------|-------------|----------|
| Reveal when on | Nag inputs hidden until requiresAck toggled on | ✓ |
| Always visible, disabled | Nag inputs always render, greyed until ack on | |

**User's choice:** Reveal when on

### Q3 — The 5→1 min floor correction: how far should it propagate?

| Option | Description | Selected |
|--------|-------------|----------|
| Fix tool + dashboard | Floor=1min in create_reminder tool (registry.ts) AND dashboard form; ceiling 30d unchanged | ✓ |
| Dashboard only | 1-min floor in dashboard only; leave tool at 5min | |

**User's choice:** Fix tool + dashboard
**Notes:** User flagged that they "already denied the floor once during previous phase discussion — it should be 1 minute, not 5." Verified `registry.ts:1017-1027` ships a 5-min floor today, and the Phase 37 log confirms the 5-min floor was Claude's pick (the "whatever cap is sensible" sign-off was about the ceiling). This ratifies a 1-min floor and overrides Phase 37 D-03.

### Q4 — Where should the form enforce the rules?

| Option | Description | Selected |
|--------|-------------|----------|
| Client + backend | Inline validation disables Create; backend POST re-validates as source of truth | ✓ |
| Backend only | Form submits; backend rejects with {error,message} | |

**User's choice:** Client + backend

---

## Ack visual marker (SCHED-02)

### Q1 (first pass) — Marker form on reminder rows

| Option | Description | Selected |
|--------|-------------|----------|
| Icon (bell/alarm) | Small lucide icon next to message | |
| Text badge ('ACK') | Pill badge styled like Head badge | |
| Icon + tooltip | Icon + hover tooltip | |

**User's choice:** (none — note: "maybe nags instead of ack")
**Notes:** User preferred "nags" framing over "ack" wording. Re-asked with nags-framed options.

### Q1 (reframed) — Marker form with "nags" framing

| Option | Description | Selected |
|--------|-------------|----------|
| Icon + 'nags' tooltip | Bell icon + "Nags every 1h until acknowledged" tooltip | |
| 'NAGS' text badge | Pill badge reading NAGS styled like Head badge; cadence inline in sub-label | ✓ |
| Icon + inline nag text | Bell icon + nag cadence in sub-label | |

**User's choice:** 'NAGS' text badge (preview also showed "· nags every 1h" inline in sub-label)

### Q2 — Surface live ackPending "nagging now" state?

| Option | Description | Selected |
|--------|-------------|----------|
| Static badge only | NAGS whenever requiresAck=true; no ackPending API change | ✓ |
| Live 'nagging now' state | Intensify (red/pulse) when ackPending; needs API to return ackPending | |

**User's choice:** Static badge only

---

## Start-date for recurring (SCHED-03)

### Q1 — How to expose the start date for a recurring item?

| Option | Description | Selected |
|--------|-------------|----------|
| Optional field in repeating | Keep once/repeating toggle; optional Start date/time field below CronPicker | ✓ |
| Third mode | Add distinct "Recurring from date" mode | |
| Always-on start field | Show Start field always (default now) | |

**User's choice:** Optional field in repeating
**Notes:** Empty = first fire from cron (today's behavior); set = first fire at datetime then cron. Backward-compatible.

### Q2 — Which forms get the start-date field?

| Option | Description | Selected |
|--------|-------------|----------|
| Both forms | Reminder (AddReminderForm) + scheduled-task (AddScheduleForm) | ✓ |
| Reminders only | Reminder form only | |

**User's choice:** Both forms

### Q3 — Past start date behavior?

| Option | Description | Selected |
|--------|-------------|----------|
| Reject (must be future) | Inline-validate future; block submit | ✓ |
| Allow (fires asap, then cron) | Accept past; fires next tick, then cron | |

**User's choice:** Reject (must be future)

---

## Edit vs creation-only

### Q1 — Editable on existing reminder or creation-only?

| Option | Description | Selected |
|--------|-------------|----------|
| Editable via PATCH | Extend SchedulePatch + update() + route + api + edit modal | ✓ |
| Creation-only | Edit modal omits ack/nag; delete & recreate to change | |

**User's choice:** Editable via PATCH
**Notes:** Resolves the Phase 37 D-09 deferral; required by SCHED-01's "create/edit form" wording.

### Q2 — Edit turns requiresAck OFF while actively nagging (ackPending=true)?

| Option | Description | Selected |
|--------|-------------|----------|
| Clear nag, resume normal | ackPending→false; recurring nextRun→next cron occurrence; one-time→ordinary | ✓ |
| Block while nagging | Disallow toggling off until acked via head | |

**User's choice:** Clear nag, resume normal
**Notes:** Editing acts as an admin-side acknowledgment. update() must clear ackPending + recompute nextRun on requiresAck true→false.

---

## Claude's Discretion

- Exact `NAGS` badge label casing/wording (nags framing required).
- Whether the optional start-date field also appears in the edit modal for recurring items.
- Whether to extract a reusable Toggle/Badge component vs inline styling.
- Exact inline sub-label format for the nag cadence.
- Whether the schedules API GET projects requiresAck/nagIntervalMinutes (confirm Schedule type carries them to frontend).
- Exact validation error wording (match the tool's strings where overlapping).

## Deferred Ideas

- **ACK-F-01** — dashboard ack button (one-click acknowledge from UI). Future Requirements, not v1.4.
- **ACK-F-02** — escalate to another channel after N unacked nags. Future Requirements.
- **Live ackPending "nagging now" indicator** — offered (marker Q2) and declined; cheap future enhancement.
