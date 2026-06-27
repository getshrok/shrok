---
phase: 57-dashboard-apps-section
plan: "01"
subsystem: dashboard
tags: [dashboard, apps, navigation, ui, tanstack-query]
dependency_graph:
  requires: [55-dashboard-apps-mount]
  provides: [dashboard-apps-section]
  affects: [dashboard/src/lib/api.ts, dashboard/src/pages/AppsPage.tsx, dashboard/src/components/layout/Sidebar.tsx, dashboard/src/router.tsx]
tech_stack:
  added: []
  patterns: [tanstack-query-refetch-on-mount, plain-a-href-same-tab, bare-array-api-response]
key_files:
  created:
    - dashboard/src/pages/AppsPage.tsx
  modified:
    - dashboard/src/lib/api.ts
    - dashboard/src/components/layout/Sidebar.tsx
    - dashboard/src/router.tsx
decisions:
  - "apps namespace in api.ts uses bare-array type Array<{slug,meta}>, not wrapped {apps:[...]}, matching GET /apps/ response from src/apps/router.ts"
  - "AppsPage tiles use plain <a href> with no target attribute for same-tab full-page navigation out of the SPA to /apps/<slug>/"
  - "TanStack Query default refetchOnMount+refetchOnWindowFocus is the list-freshness mechanism — no SSE, polling, or refetchInterval added"
  - "Apps nav item placed immediately after Sensors in the sidebar nav array per plan D-04"
metrics:
  duration_minutes: 2
  completed_date: "2026-06-27"
  tasks_completed: 2
  tasks_total: 2
  files_changed: 4
---

# Phase 57 Plan 01: Dashboard Apps Section Summary

**One-liner:** Apps sidebar nav item (LayoutGrid icon), `/apps` route, and an AppsPage launcher that fetches the bare-array GET /apps/ endpoint and renders same-tab tile links with icon/name/desc fallbacks.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add api.apps.list() and AppsPage launcher component | d3b2238 | dashboard/src/lib/api.ts, dashboard/src/pages/AppsPage.tsx |
| 2 | Wire Apps sidebar item and route | 2ab6bf9 | dashboard/src/components/layout/Sidebar.tsx, dashboard/src/router.tsx |

## What Was Built

### api.apps.list() (dashboard/src/lib/api.ts)

Added a top-level `apps` namespace with a single `list()` method that calls the shared `request()` wrapper against `/apps/` (the Phase-55 enumeration endpoint). Typed as a **bare array** `Array<{ slug: string; meta: { title?: string; icon?: string; desc?: string } }>` — not a wrapped object like every other namespace — because `GET /apps/` returns `res.json(listApps(appsDir))` directly.

### AppsPage.tsx (dashboard/src/pages/AppsPage.tsx)

New page component implementing the Apps launcher:
- `useQuery({ queryKey: ['apps'], queryFn: api.apps.list })` with default `refetchOnMount` + `refetchOnWindowFocus` (satisfies APPSUI-04 — new apps appear with no dashboard rebuild)
- `appsQuery.data ?? []` direct bare-array read (not `.data?.apps`)
- Responsive tile grid: `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3`
- Each tile: plain `<a href={`/apps/${slug}/`}>` with no `target`, no `rel`, and not a react-router `<Link>` — same-tab full-page GET leaves the SPA and hits the Phase-55 app shell
- Fallbacks: `meta.icon ?? '📦'`, `meta.title ?? slug`, desc line omitted when absent
- Loading, error, and empty-state ("No apps yet — ask shrok to build one.") states all present
- No `dangerouslySetInnerHTML`, no SSE/polling (T-57-01 mitigation satisfied)

### Sidebar.tsx (dashboard/src/components/layout/Sidebar.tsx)

- Added `LayoutGrid` to the lucide-react import block
- Added `Apps: LayoutGrid` to the `NAV_ICONS` map (after Sensors)
- Added `{ to: '/apps', label: 'Apps', end: false }` to the nav array immediately after the Sensors entry — the existing `.map` + `NAV_ICONS[label]` lookup handles icon and active-state styling automatically

### router.tsx (dashboard/src/router.tsx)

- Imported `AppsPage` (extensionless form, matching majority of page imports)
- Added `{ path: '/apps', element: <AppsPage /> }` under AppShell children after the `/sensors` route

## Verification

- `cd dashboard && npx tsc --noEmit` — exits 0 (clean under `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`)
- `cd dashboard && npm run build` — succeeds (2144 modules transformed, vite build complete)
- `dashboard/dist/` left unstaged; `dashboard/package.json` version unchanged — CI is sole writer of dist

## Deviations from Plan

None — plan executed exactly as written. All four files modified as specified, all acceptance criteria met.

## Threat Surface Scan

No new network endpoints, auth paths, or trust boundaries introduced. The `apps` namespace in api.ts calls the existing Phase-55 GET /apps/ endpoint (already deployed, already un-authenticated by Phase-55 D-01 design). The AppsPage renders `meta` strings as plain JSX children (React's default escaping — T-57-01 mitigated). No new packages added — `LayoutGrid` (lucide-react), `useQuery` (@tanstack/react-query), and `request()` were already present.

## Self-Check: PASSED

- dashboard/src/lib/api.ts: FOUND (modified, apps namespace added)
- dashboard/src/pages/AppsPage.tsx: FOUND (created, 51 lines)
- dashboard/src/components/layout/Sidebar.tsx: FOUND (modified, LayoutGrid + Apps nav)
- dashboard/src/router.tsx: FOUND (modified, AppsPage import + /apps route)
- Commit d3b2238: FOUND
- Commit 2ab6bf9: FOUND
- dashboard/dist/: confirmed unstaged
