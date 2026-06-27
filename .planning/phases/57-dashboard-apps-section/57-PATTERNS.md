# Phase 57: Dashboard "Apps" Section - Pattern Map

**Mapped:** 2026-06-27
**Files analyzed:** 4 (1 create, 3 modify)
**Analogs found:** 4 / 4

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `dashboard/src/pages/AppsPage.tsx` (CREATE) | page (component) | request-response (read-only list) | `dashboard/src/pages/SensorsPage.tsx` (fetch/loading/empty) + `dashboard/src/pages/TestsPage.tsx` (card grid) | role-match (composite) |
| `dashboard/src/components/layout/Sidebar.tsx` (MODIFY) | component (nav) | request-response | itself (existing nav array + `NAV_ICONS`) | exact |
| `dashboard/src/router.tsx` (MODIFY) | route config | request-response | itself (existing route entries) | exact |
| `dashboard/src/lib/api.ts` (MODIFY) | utility (api client) | request-response | itself (`api.sensors.list` + `request<T>()`) | exact |

---

## ⚠️ Load-bearing fact: `GET /apps/` returns a BARE ARRAY, not a wrapped object

Confirmed in `src/apps/router.ts:76-78`:

```typescript
router.get('/', (_req: ExReq, res: ExRes): void => {
  res.json(listApps(appsDir))
})
```

And `listApps()` (`src/apps/discovery.ts:83-95`) returns `{ slug: string; meta: Record<string, string> }[]`.

This is **different from every other api namespace in `api.ts`**, which wrap their list in an object (`{ sensors: [...] }`, `{ skills: [...] }`, `{ tasks: [...] }`). So `api.apps.list()` resolves to a **plain array** — the page reads `appsQuery.data ?? []` directly, NOT `appsQuery.data?.apps`.

`meta` is `Record<string, string>` with optional keys `title`, `icon`, `desc` (see `AppMod.meta` in `discovery.ts:24`). All three may be absent (`meta: {}` for an app with no `meta.json`). The fallback rules (CONTEXT D-Discretion): missing `title` → use `slug`; missing `icon` → neutral glyph; missing `desc` → omit the line.

---

## Pattern Assignments

### `dashboard/src/lib/api.ts` (utility, request-response)

**Analog:** the file itself — `api.sensors.list` (lines 238-240) + the `request<T>()` wrapper (lines 15-22).

**`request<T>()` wrapper signature** (lines 15-22) — already sends `credentials:'include'` and works on ANY same-origin path (not just `/api/*`), so it can call `/apps/` directly:
```typescript
async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'include', ...opts })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}
```

**Existing list-namespace shape to mirror** (`api.sensors.list`, lines 238-240) — note the inline response type:
```typescript
sensors: {
  list: () =>
    request<{ sensors: Array<{ slug: string }> }>('/api/sensors'),
  ...
```

**New entry to add** (a top-level `apps` namespace; the type is a bare array because the endpoint is unwrapped — see load-bearing fact above):
```typescript
apps: {
  list: () =>
    request<Array<{ slug: string; meta: { title?: string; icon?: string; desc?: string } }>>('/apps/'),
},
```
Path is `'/apps/'` (the enumeration route mounted at `/apps` → `router.get('/')`). Consume `/apps/` directly — do NOT add a `/api/apps` proxy (CONTEXT Discretion). The shared `request()` already attaches the session cookie; harmless on this un-authed endpoint.

---

### `dashboard/src/components/layout/Sidebar.tsx` (component, nav)

**Analog:** the file itself.

**Import** — add `LayoutGrid` to the existing lucide-react import block (lines 3-7):
```typescript
import {
  MessageSquare, BrainCircuit, UserCircle, Zap, BarChart3,
  ScrollText, FlaskConical, ClipboardCheck, Settings, LogOut,
  Clock, PanelLeftClose, PanelLeftOpen, CheckSquare, BookOpen, Activity,
  LayoutGrid,
} from 'lucide-react'
```

**`NAV_ICONS` map** (lines 117-131) — keyed by the nav `label`. Add `Apps`:
```typescript
const NAV_ICONS = {
  Conversation: MessageSquare,
  ...
  Sensors: Activity,
  Apps: LayoutGrid,        // ← add right after Sensors
  Schedules: Clock,
  ...
} as const
```

**Nav array** (lines 183-194) — add the `Apps` entry **right after Sensors** (CONTEXT D-04). Entries are `{ to, label, end }`; the icon is resolved from `NAV_ICONS[label]` by the existing `.map` at line 210:
```typescript
{ to: '/sensors', label: 'Sensors', end: false },
{ to: '/apps', label: 'Apps', end: false },   // ← add this line
{ to: '/schedules', label: 'Schedules', end: false },
```
No other change — the existing `.map(({ to, label, end }) => <NavLink ... />)` and the `NAV_ICONS[label as keyof typeof NAV_ICONS]` lookup (line 210) render the icon + active-state styling automatically.

---

### `dashboard/src/router.tsx` (route config, request-response)

**Analog:** the file itself.

**Import** (after line 16, alongside the other page imports):
```typescript
import AppsPage from './pages/AppsPage'
```
(Note: most imports here omit the extension, e.g. `import SensorsPage from './pages/SensorsPage.js'` uses `.js` but `TasksPage`/`SkillsPage` omit it. Either resolves under `moduleResolution: bundler`. Prefer the bare form `'./pages/AppsPage'` to match the majority.)

**Route entry** — add under the `AppShell` children (lines 68-81), placed near `/sensors` for readability:
```typescript
{ path: '/sensors', element: <SensorsPage /> },
{ path: '/apps', element: <AppsPage /> },     // ← add this line
{ path: '/schedules', element: <SchedulesPage /> },
```

---

### `dashboard/src/pages/AppsPage.tsx` (page, request-response — CREATE)

This is a **composite**: take the **fetch + loading/error/empty pattern** from `SensorsPage.tsx`, and the **responsive card-grid markup** from `TestsPage.tsx`. It does NOT use the Sensors split-pane (no detail/editor pane — tiles just launch).

**Imports pattern** (top-of-file, mirrors SensorsPage.tsx:1-5, trimmed to what a read-only launcher needs):
```typescript
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
// optional: a fallback glyph icon, e.g. import { LayoutGrid } from 'lucide-react'
```

**Fetch pattern** (from SensorsPage.tsx:101-104) — TanStack Query with default `refetchOnMount` + `refetchOnWindowFocus` satisfies APPSUI-04 / D-03 with zero extra config:
```typescript
const appsQuery = useQuery({
  queryKey: ['apps'],
  queryFn: api.apps.list,
})
const apps = appsQuery.data ?? []   // ← bare array, NOT appsQuery.data?.apps
```

**Loading / error / empty states** (adapted from SensorsPage.tsx:325-333) — same dark-theme text classes:
```typescript
{appsQuery.isLoading && (
  <p className="px-2 py-1 text-xs text-zinc-500">Loading…</p>
)}
{appsQuery.isError && (
  <p className="px-2 py-1 text-xs text-red-400">Failed to load apps</p>
)}
{!appsQuery.isLoading && apps.length === 0 && (
  /* friendly empty-state card (CONTEXT Discretion) */
  <div className="text-sm text-zinc-500">No apps yet — ask shrok to build one.</div>
)}
```

**Page header + responsive grid container** (header from TestsPage.tsx:75-82; grid from the same file). Use a responsive column count rather than the fixed `grid-cols-2` Tests uses, to get the launcher feel (D-02):
```tsx
<div className="h-full flex flex-col">
  <div className="px-6 pt-6 pb-4 border-b border-zinc-800 shrink-0">
    <h1 className="text-lg font-semibold text-zinc-100">Apps</h1>
  </div>
  <div className="flex-1 overflow-y-auto px-6 py-6">
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {/* tiles here */}
    </div>
  </div>
</div>
```

**The tile = whole card wrapped in a plain `<a>`** (CONTEXT D-01/D-02). Card styling is the bordered-card pattern from TestsPage.tsx:89-103 (`rounded-lg border border-zinc-800 bg-zinc-900/50`, `text-zinc-200` title, `text-xs text-zinc-500` desc). The `<a>` is a **plain same-tab full-page navigation** — NO `target`, NO react-router `<Link>`:
```tsx
{apps.map(({ slug, meta }) => (
  <a
    key={slug}
    href={`/apps/${slug}/`}
    className="block px-4 py-4 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800/60 hover:border-zinc-700 transition-colors text-center"
  >
    <div className="text-3xl mb-2">{meta.icon ?? '📦'}</div>
    <div className="text-sm font-medium text-zinc-200">{meta.title ?? slug}</div>
    {meta.desc && <p className="mt-1 text-xs text-zinc-500">{meta.desc}</p>}
  </a>
))}
```

**Why plain `<a>` and not `<Link>`** (D-01): react-router v6 only intercepts its own `<Link>`/`<NavLink>` clicks, so a plain `<a href="/apps/<slug>/">` does a real browser GET. Because `/apps/*` is mounted ABOVE the SPA catch-all in `src/dashboard/server.ts` (`app.use('/apps', createAppsRouter(...))`), that GET hits the standalone app shell, not the SPA. Browser Back returns to the dashboard.

**⚠️ Distinguish from the other external-link pattern in the codebase:** `DocsPage.tsx:109` and `ConversationsPage.tsx:192` use `<a href={...} target="_blank" rel="noreferrer noopener">` for **markdown/external** links (new tab). This phase is the OPPOSITE — **same tab, no `target`, no `rel`**. Do not copy the `target="_blank"` from those.

---

## Shared Patterns

### Dark-theme card styling (no design system, Tailwind + accent vars)
**Source:** `dashboard/src/pages/TestsPage.tsx:89-103`
**Apply to:** AppsPage tiles
```
rounded-lg border border-zinc-800 bg-zinc-900/50    /* card surface */
text-sm font-medium text-zinc-200                   /* title */
text-xs text-zinc-500                               /* description / muted */
hover:bg-zinc-800/60 hover:border-zinc-700 transition-colors
```

### Active nav-item theming via `var(--accent)`
**Source:** `dashboard/src/components/layout/Sidebar.tsx:202-208`
**Apply to:** the new Apps `NavLink` (handled automatically — it flows through the existing `.map` render; no per-item styling needed). For reference, active state is:
```
isActive
  ? 'bg-[var(--accent)]/10 text-zinc-100 border-l-2 border-[var(--accent)]'
  : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 border-l-2 border-transparent'
```

### TanStack Query list fetch (refetch-on-mount + on-focus by default)
**Source:** `dashboard/src/pages/SensorsPage.tsx:101-104`
**Apply to:** AppsPage — `useQuery({ queryKey: ['apps'], queryFn: api.apps.list })`. The default `refetchOnMount`/`refetchOnWindowFocus` IS the freshness mechanism (D-03); no SSE, no polling.

---

## No Analog Found

None. Every file has a strong analog (3 are self-modifications; AppsPage composes two existing pages).

---

## Build/Release Constraint (carry into the plan)

**Source:** `AGENTS.md` (CI structure + Versioning)
**Apply to:** all 4 files
- Do **NOT** commit `dashboard/dist/` — CI is its sole writer on `main`. Build locally for testing (`cd dashboard && npm run build`) but leave dist unstaged.
- Do **NOT** bump `dashboard/package.json` / root `package.json` in this phase — that happens only on a version cut.
- This data-driven design is what makes APPSUI-04 ("new app appears with no dashboard rebuild") true: the committed dist never changes when an app is added — the list is fetched at runtime.

---

## Metadata

**Analog search scope:** `dashboard/src/pages/`, `dashboard/src/components/layout/`, `dashboard/src/lib/`, `src/apps/`
**Files scanned:** SensorsPage.tsx, Sidebar.tsx, router.tsx, api.ts, TestsPage.tsx, DocsPage.tsx, ConversationsPage.tsx, src/apps/router.ts, src/apps/discovery.ts
**Pattern extraction date:** 2026-06-27
