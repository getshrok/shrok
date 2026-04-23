# Phase 23: Timezone-aware Scheduling — Context

**Gathered:** 2026-04-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Establish timezone-awareness across the scheduling system: collect timezone once at bootstrap, expose it in settings UI and tool schemas, constrain both UI and LLM to a canonical standard cron set (enforced by validation, not just description text), and extend that standard set with weekdays and every-N-days cadences. The conditions prompt (already LLM-visible) is the escape valve for complex scheduling logic — cron expressions stay simple.

</domain>

<decisions>
## Implementation Decisions

### Onboarding (Bootstrap)

- **D-01:** Timezone collection happens in `src/identity/defaults/BOOTSTRAP.md` as a conversational question alongside the existing names/about/personality questions. It is NOT triggered lazily on first schedule attempt — it is part of the initial onboarding flow.
- **D-02:** After collecting the user's timezone, the head spawns a sub-agent (via `spawn_agent`) to write the `timezone` key to `{workspacePath}/config.json`. Same pattern as how other config mutations work — not a new write_config tool on the head.
- **D-03:** The head resolves city/colloquial names to IANA timezone strings conversationally (e.g. "New York" → "America/New_York", "London" → "Europe/London"). The LLM's own geographic knowledge handles this — no lookup table required. The written value must always be a valid IANA string.

### Timezone in Config and Settings

- **D-04:** `timezone` is already in `ConfigSchema` (src/config.ts line 91) with IANA default. Phase 23 adds it to the settings API allowlist so it can be written via the dashboard, and adds a UI control in SettingsModal.
- **D-05:** Settings UI: a text input or dropdown for timezone, labeled with the current IANA value and a note showing the resolved UTC offset. Exact widget style: Claude's discretion (match existing SettingsModal patterns).

### cronTimezone Field in Tool Schemas

- **D-06:** Add a `cronTimezone` field to `create_schedule` and `create_reminder` tool schemas. It appears **before** the `cron` field — the LLM must commit to its intended timezone before writing the cron expression. This is chain-of-thought-by-construction (same philosophy as the `description` field on tool calls from the tool-call-legibility milestone).
- **D-07:** `cronTimezone` is the ground truth for cron execution. The schedule runs in whatever timezone the LLM stated. If omitted, the workspace configured timezone is used as the fallback.
- **D-08:** LLM always sees times in the workspace-configured local timezone (never UTC). Internally, the system may store next-run timestamps as UTC (recommended for reliability — Claude's discretion on internals). Any model-facing time display must be converted to the configured local timezone.
- **D-09:** The `cronTimezone` description in the tool schema should be dynamic — showing the currently configured workspace timezone so the LLM sees e.g. "Timezone the cron expression is relative to (workspace default: America/New_York)."

### Standard Cron Set + Validation

- **D-10:** Define a canonical standard cron set that both CronPicker UI and LLM tools are constrained to. The standard set (after Phase 23 additions):
  - Every N minutes: `*/5`, `*/10`, `*/15`, `*/30`, `*/45` in minute field
  - Hourly at :MM: `M * * * *`
  - Daily at HH:MM: `M H * * *`
  - **NEW — Weekdays (Mon–Fri) at HH:MM:** `M H * * 1-5`
  - Weekly on one day at HH:MM: `M H * * D`
  - **NEW — Every N days (1–7):** `0 H */N * *` where N ∈ {1,2,3,4,5,6,7}
  - Monthly on day D: `M H D * *`
  - Yearly on month Mo, day D: `M H D Mo *`
- **D-11:** Add actual validation code (not just advisory description text) that rejects cron expressions outside the standard set. If the LLM submits a non-standard cron, the tool returns an error: "Cron expression is not in the supported standard set. Use a simpler pattern, or use the `conditions` field for complex scheduling logic (e.g. 'Only run on the 2nd, 7th, and 23rd of the month')."
- **D-12:** CronPicker in the dashboard is updated to support exactly the same standard set. Since all valid crons are parseable by CronPicker, the raw-text fallback is not needed — it was only necessary to handle exotic LLM-generated expressions, which validation now prevents.

### CronPicker Additions

- **D-13:** Add `weekdays` as a new cadence option in CronPicker (`'minutes' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly'`). It produces `M H * * 1-5` with a configurable time. Sits between `daily` and `weekly` in the dropdown.
- **D-14:** Add every-N-days cadence to CronPicker with a selector for N ∈ {1,2,3,4,5,6,7}. Produces `0 H */N * *`.
- **D-15:** No raw-text fallback needed (see D-12). CronPicker should cover 100% of valid (standard-set) cron expressions.

### Conditions Prompt (existing — do not re-implement)

- **D-16:** `conditions` field already exists on `create_schedule` and `create_reminder`, is already LLM-visible, and already references "use conditions for custom timing logic." Phase 23 should reinforce this in the validation error message (D-11) but does not need to add the field — it already exists.

### Claude's Discretion

- Internal timezone storage format (UTC timestamps recommended for reliability)
- Exact UI widget for timezone in SettingsModal (text input vs searchable dropdown)
- Whether to expose a timezone search/autocomplete or plain text input in settings
- Exact wording of the bootstrap onboarding question for timezone

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

No external specs — requirements fully captured in decisions above.

### Key files to read before planning

- `src/identity/defaults/BOOTSTRAP.md` — current onboarding flow; timezone question is being added here
- `src/config.ts` — ConfigSchema with existing `timezone` field (line 88–91); settings write path
- `src/sub-agents/registry.ts` — `create_schedule` and `create_reminder` tool definitions (lines 707–940); `conditions` field already present; `cron` field description with existing standard set
- `dashboard/src/components/CronPicker.tsx` — existing cadences and DEFAULT_STATE; weekdays + every-N-days being added
- `dashboard/src/pages/settings/SettingsModal.tsx` — settings UI to add timezone control
- `src/dashboard/routes/settings.ts` — settings API; timezone needs to be added to the allowlist
- `src/head/steward.ts` — onboarding/steward mechanism; relevant for understanding how BOOTSTRAP.md is consumed

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ConfigSchema.timezone` (src/config.ts:91): Already defined as IANA string with system default. Phase 23 exposes it in settings API + UI — no schema change needed.
- `conditions` field on both schedule/reminder tools: Already implemented and LLM-visible. Reuse as-is for the validation error message redirect.
- Existing cron validation: `nextRunAfter()` throws on invalid cron syntax. Phase 23 adds a whitelist check BEFORE this call.

### Established Patterns
- Tool schema field ordering is intentional (description → intent → action, per tool-call-legibility milestone). `cronTimezone` goes before `cron` — same philosophy.
- Settings API uses a patch-merge pattern. Adding `timezone` to the allowlist follows the existing pattern in `src/dashboard/routes/settings.ts`.
- CronPicker cadence switch pattern: `handleCadenceChange()` normalizes state per cadence. Weekdays and every-N-days follow the same pattern.

### Integration Points
- BOOTSTRAP.md → head onboarding conversation → spawn_agent writes `timezone` to config.json
- config.json `timezone` → tool schema dynamic descriptions (cronTimezone default) + settings UI display
- Standard cron set → shared validation function used by both create_schedule and create_reminder
- CronPicker cadence list → must match the standard cron set exactly after Phase 23

</code_context>

<specifics>
## Specific Ideas

- The user explicitly called out the chain-of-thought-by-construction pattern for `cronTimezone` field ordering — this is intentional and mirrors the `description`-first tool call philosophy from the tool-call-legibility milestone.
- "Option 4" for cron complexity: instead of a perfect UI or constraining the LLM, the system defines a sufficient standard set and uses `conditions` as the escape valve. This is a first-class design decision, not a compromise.
- Bootstrap onboarding should feel conversational, not form-like — one or two questions at a time, letting the timezone question flow naturally after "where are you?" in the about-the-user section.

</specifics>

<deferred>
## Deferred Ideas

- Searchable timezone autocomplete in settings (city name → IANA) — beyond this phase's scope
- Timezone display in schedule list (showing "fires at 9am EST") — dashboard enhancement for a future phase
- Multi-timezone support (different timezone per schedule) — the cronTimezone field enables this but the settings/UI work is deferred

</deferred>

---

*Phase: 23-timezone-aware-scheduling*
*Context gathered: 2026-04-23*
