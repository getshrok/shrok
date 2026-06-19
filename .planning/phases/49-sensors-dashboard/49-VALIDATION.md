---
phase: 49
slug: sensors-dashboard
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-17
---

# Phase 49 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `vitest.config.ts` (6 parallel CI shards) |
| **Quick run command** | `npx vitest run <path>` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~per-shard, 4 GB heap each |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run <path>` (the touched test file)
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| {N}-01-01 | 01 | 1 | SENSOR-{XX} | T-49-01 / — | {expected secure behavior or "N/A"} | unit | `{command}` | ✅ / ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*
*Filled by the planner / gsd-nyquist-auditor against the RESEARCH.md Validation Architecture.*

---

## Wave 0 Requirements

- [ ] Sensor CRUD API test stubs for SENSOR-01..SENSOR-05
- [ ] Existing vitest infrastructure covers the rest

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| {behavior} | SENSOR-{XX} | {reason} | {steps} |

*If none: "All phase behaviors have automated verification."*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
