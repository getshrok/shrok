---
phase: 49-sensors-dashboard
reviewed: 2026-06-18T00:00:00Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - src/dashboard/routes/sensors.ts
  - src/dashboard/routes/schedules.ts
  - src/dashboard/server.ts
  - dashboard/src/lib/api.ts
  - dashboard/src/types/api.ts
  - dashboard/src/pages/SensorsPage.tsx
  - dashboard/src/pages/SchedulesPage.tsx
  - dashboard/src/components/layout/Sidebar.tsx
  - CHANGELOG.md
findings:
  critical: 1
  warning: 2
  info: 1
  total: 4
status: resolved
resolution: "CR-01 + WR-01 + WR-02 fixed in commit a9f239d (taskName now persisted for kind:'script'; missing-slug rejected; comment clarified; regression tests G/H added). Info item (setState-during-render in SensorsPage) left as-is — logically correct, Info severity, out of fix scope."
---

# Phase 49: Code Review Report

**Reviewed:** 2026-06-18
**Depth:** standard
**Files Reviewed:** 9
**Status:** resolved (was issues_found — Critical + both Warnings fixed in a9f239d; 1 Info accepted)

## Summary

The sensors CRUD backend (`sensors.ts`) is correct: path-traversal guard fires before every `path.join`, all four routes carry `requireAuth`, and the fire-and-forget `void sensorRunner.run(slug)` contract is properly implemented. The frontend pages are well-structured with no injection or XSS risks (all user content is rendered via React's normal text interpolation, never via `innerHTML` or `dangerouslySetInnerHTML`).

One blocker was found: the `kind='script'` branch in `schedules.ts` persists `taskName` to `createOpts` only for `kind='task'`. Every sensor schedule created via the dashboard will be stored with `taskName = null`. The scheduler reads `taskName` as the sensor slug to run and immediately skips any schedule with a null slug — meaning sensor schedules created via the UI are silently inoperable at runtime. Two warnings follow from the same widening: the route lacks a `taskName` presence check for `kind='script'`, and the `deliverToHeadIds` rejection comment mislabels the scope.

## Critical Issues

### CR-01: `taskName` (sensor slug) never written to `createOpts` for `kind='script'` schedules

**File:** `src/dashboard/routes/schedules.ts:175`

**Issue:** Line 175 reads `if (kind === 'task' && typeof taskName === 'string') createOpts.taskName = taskName`. The `kind === 'task'` guard means sensor schedules (`kind='script'`) are stored with `taskName = null`. The scheduler at `src/scheduler/index.ts:70–72` does:

```typescript
const slug = schedule.taskName
if (!slug) {
  log.warn(`[scheduler] script schedule ${schedule.id} has no taskName/slug — skipping`)
  return
}
```

Every sensor schedule created from the dashboard therefore silently fires-and-skips on every tick. No error surfaces to the user. The schedule appears healthy (enabled, has a next-run time) but never runs the sensor.

**Fix:** Extend the persistence condition to cover `'script'` as well, since `taskName` serves as the sensor slug for that kind:

```typescript
// Before:
if (kind === 'task' && typeof taskName === 'string') createOpts.taskName = taskName

// After:
if ((kind === 'task' || kind === 'script') && typeof taskName === 'string') createOpts.taskName = taskName
```

---

## Warnings

### WR-01: No server-side `taskName` presence validation for `kind='script'`

**File:** `src/dashboard/routes/schedules.ts:117–129`

**Issue:** The `taskName` required-field check only runs inside `if (kind === 'task')`. A `kind='script'` POST with no `taskName` field (or an empty string) will succeed, storing a schedule with `taskName = null`. After the CR-01 fix, that schedule would still silently skip at runtime because the scheduler guards on a falsy slug. There is no 400 to tell the caller the sensor slug is missing.

**Fix:** Add a parallel guard for `'script'`:

```typescript
if (kind === 'task') {
  if (typeof taskName !== 'string' || !taskName.trim()) {
    res.status(400).json({ error: 'taskName is required for task schedules' })
    return
  }
  // ... existing tasksLoader check ...
}
if (kind === 'script') {
  if (typeof taskName !== 'string' || !taskName.trim()) {
    res.status(400).json({ error: 'taskName (sensor slug) is required for script schedules' })
    return
  }
}
```

### WR-02: `deliverToHeadIds` rejection comment mislabels scope — silently rejects `kind='script'` too

**File:** `src/dashboard/routes/schedules.ts:111–114`

**Issue:** The `else if` branch at line 111 fires when `kind` is anything other than `'task'` (i.e. both `'reminder'` and `'script'`). The comment on line 112 says `"400 on reminders"` — it does not mention `script`. Any future direct-API call that sets `deliverToHeadIds` on a sensor schedule will receive a confusing error whose message (`"deliverToHeadIds is only valid for task schedules"`) is correct but whose code path is undocumented. More practically: if the `AddSensorScheduleForm` were ever extended to support multi-head delivery, a developer reading only the comment would be misled about whether it is technically possible.

**Fix:** Update the comment:

```typescript
} else if ((req.body as { deliverToHeadIds?: unknown }).deliverToHeadIds !== undefined) {
  // 400 on reminders AND script schedules — deliverToHeadIds is task-only (D-08)
  res.status(400).json({ error: 'deliverToHeadIds is only valid for task schedules' })
  return
}
```

---

## Info

### IN-01: `setState` during render in `SensorsPage.tsx` causes a double-render per load

**File:** `dashboard/src/pages/SensorsPage.tsx:48–57`

**Issue:** Lines 48–57 call `setLoadedSlugContent` and `setEditorContent` unconditionally during the render function body (not inside a `useEffect`). React detects state-set-during-render and immediately re-renders the component. The guard conditions prevent an infinite loop (after the first extra render `loadedSlugContent.content === detailContent`, so the branch is skipped). The behavior is therefore correct, but React's own documentation calls out this pattern as a performance trade-off and recommends `useEffect` for derived-state synchronization when the trigger is an async data event (as it is here — `detailQuery.data` arriving).

The downstream risk: any hook between line 57 and the `return` statement that reads from state that was just set will see the stale (pre-set) value during the first render pass, since `setState` during render only takes effect on the retry. In the current code this doesn't cause incorrect behavior because `editorContent` is only read in JSX (not in another `useState`/`useMemo`/`useCallback` above the return), but it is a fragile pattern that could silently break if the component grows.

**Fix (preferred):** Convert to a `useEffect` with `[selectedSlug, detailContent]` dependencies:

```typescript
useEffect(() => {
  if (detailContent === undefined || selectedSlug === null) return
  if (loadedSlugContent?.slug === selectedSlug && loadedSlugContent?.content === detailContent) return
  setLoadedSlugContent({ slug: selectedSlug, content: detailContent })
  setEditorContent(detailContent)
}, [selectedSlug, detailContent]) // loadedSlugContent intentionally omitted — it's the derived value
```

---

_Reviewed: 2026-06-18_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
