---
phase: 43
slug: end-to-end-smoke-test-setup-docs
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-24
---

# Phase 43 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
>
> **Nature of this phase:** test + docs closeout. Most success criteria (SC1–SC4)
> are **human-attested against live VPE hardware** and recorded in `43-VERIFICATION.md`
> (D-06). The machine-verifiable surface is small: the HADOC-01 doc artifact, the
> cross-link edit, and — only if D-01 tuning fires — `tsc` + the existing HA test suite
> staying green. No new automated test files are required unless the P6 busy-satellite
> skip is implemented.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npx vitest run src/channels/home-assistant/` |
| **Full suite command** | `npx vitest run` |
| **TypeScript check** | `npx tsc --noEmit` |
| **Estimated runtime** | ~25s full suite; HA subset ~2s |

**Baseline (verified pre-phase):** 1625/1625 tests passing, `tsc` clean.

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/channels/home-assistant/` (only if the task touched code; docs-only tasks skip).
- **After every plan wave:** Run `npx vitest run` + `npx tsc --noEmit`.
- **Before `/gsd:verify-work`:** Full suite green + `tsc` exit 0.
- **Max feedback latency:** ~25 seconds.

---

## Per-Task Verification Map

> This phase's "tasks" split into a machine-verifiable docs/code track and a
> human-attested live-test track. The table covers the machine-verifiable track;
> the human-attested track is in **Manual-Only Verifications** below.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| HADOC guide exists | docs | — | HADOC-01 | — | N/A | file | `test -f docs/user-guide/home-assistant.md` | ❌ W0 | ⬜ pending |
| Guide ≥5 sections | docs | — | HADOC-01 | — | N/A | grep | `grep -c '^## ' docs/user-guide/home-assistant.md` (≥5) | ❌ W0 | ⬜ pending |
| Guide has Apache bypass block | docs | — | HADOC-01 | T-43-01 | `/v1/` exempt from Basic auth, Bearer reaches Shrok | grep | `grep -c 'AuthType None' docs/user-guide/home-assistant.md` (≥1) | ❌ W0 | ⬜ pending |
| Cross-link edit present | docs | — | HADOC-01 | — | N/A | grep | `grep 'home-assistant.md' docs/internals/channel-integrations.md` | ✅ | ⬜ pending |
| Both HA env keys allow-listed | code | — | HADOC-01 | T-43-02 | only allow-listed keys writable to `.env` | grep | `grep 'HA_ACCESS_TOKEN\|HA_INBOUND_API_KEY' src/config.ts` (both) | ✅ | ⬜ pending |
| `REPLY_DEADLINE_MS` preserved | code | — | — | — | N/A | grep | `grep REPLY_DEADLINE_MS src/channels/home-assistant/router.ts` | ✅ | ⬜ pending |
| tsc clean after any D-01 tuning | code | — | — | — | N/A | build | `npx tsc --noEmit` (exit 0) | ✅ | ⬜ pending |
| HA tests green after any D-01 tuning | code | — | — | — | N/A | unit | `npx vitest run src/channels/home-assistant/` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `docs/user-guide/home-assistant.md` — new HADOC-01 operator guide (asserted by file-exists + section/grep checks above).
- [ ] If the P6 busy-satellite skip (42 D-02) is implemented under D-01: add one test block to `src/channels/home-assistant/adapter.test.ts` covering the `state != idle → skip announce + log` path.

*Otherwise: existing HA test infrastructure (`adapter.test.ts`, `router.test.ts`, `types.test.ts`) covers all code behavior. If this phase ships zero production code (the D-01 "nothing needed" outcome), no Wave 0 test work is required.*

---

## Manual-Only Verifications

> These are the phase's primary success criteria. They require the operator at the
> live VPE device and CANNOT be automated. Outcomes recorded in `43-VERIFICATION.md` (D-06).

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| SC1 — User speaks; Shrok acks in-turn (or turn lapses) AND the real answer is spoken via announce | HADOC-01 (SC1) | Requires speaking to physical VPE hardware | Operator runs spoken-turn Scenarios A–C from RESEARCH §"Step 7"; observes device audio |
| SC2 — Apache `/v1` bypass returns Shrok's JSON 401, not Apache's `WWW-Authenticate: Basic` 401 | HADOC-01 (SC2/D-05) | Requires applying a vhost edit on the live box, then reverting | Operator runs `curl -v` (RESEARCH §"Step 8d") after apply; confirms JSON 401; reverts vhost |
| SC3 — A self-hoster can wire up the HA side from HADOC-01 with no guesswork | HADOC-01 (SC3) | Doc usability is a human judgment | Operator follows HADOC-01 end-to-end during the live setup; notes any gap |
| SC4 — Live-VPE open questions resolved & recorded | HADOC-01 (SC4/D-06) | Behavior only observable on real device | Operator records: deadline headroom under real latency, `conversation_id` stitching, `start_conversation` round-trip, `continue_conversation` behavior, `device_id` presence |

---

## Validation Sign-Off

- [ ] HADOC-01 doc artifact has automated file/section/grep assertions
- [ ] Any D-01 code tuning gated by `tsc` + HA test suite green
- [ ] Live-VPE success criteria (SC1–SC4) captured as Manual-Only with explicit record targets in `43-VERIFICATION.md`
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
