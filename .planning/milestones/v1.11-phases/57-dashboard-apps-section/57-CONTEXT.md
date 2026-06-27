# Phase 57: Dashboard "Apps" Section - Context

**Gathered:** 2026-06-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Add an **"Apps" item to the dashboard sidebar** and an **Apps page** that lists the apps shrok has built (name / icon / description, pulled live from the Phase-55 `GET /apps/` enumeration endpoint) and links **out** of the React SPA to each standalone app at `/apps/<slug>/`. The list reflects apps appearing/disappearing without a dashboard rebuild. Maps APPSUI-01..04.

**In scope:** the dashboard React surface only — one sidebar nav item, one new page (`AppsPage`), one route, and the fetch wiring to the existing enumeration endpoint.

**Out of scope (already built / other phases):** the app-serving subsystem, enumeration endpoint, and `/apps/<slug>/` standalone serving (Phase 55); the agent's `build_app` capability (Phase 56); per-head app scoping (rejected milestone-wide, D-01 of Phase 55); any change to how apps themselves are served or how their `/api` wire works.
</domain>

<decisions>
## Implementation Decisions

### Launch behavior
- **D-01 (Same tab).** Clicking an app tile navigates in the **same tab** — a full browser navigation to `/apps/<slug>/` that replaces the dashboard SPA with the app's standalone page; browser **Back** returns to the dashboard. Implement as a plain `<a href="/apps/<slug>/">` (NO `target="_blank"`, NO react-router `<Link>`). This satisfies APPSUI-03 ("navigates out of the dashboard SPA"): because `/apps/*` is mounted above the SPA catch-all in `src/dashboard/server.ts`, a full-page GET to `/apps/<slug>/` hits the apps router (the standalone shell), not the SPA. react-router v6 does NOT intercept plain anchor clicks (only its own `<Link>`/`<NavLink>`), so a plain `<a>` reliably leaves the SPA.

### Page layout
- **D-02 (Card/tile grid).** The Apps page renders a **responsive card/tile grid** (launcher feel, like the vms-apps home page) — each tile shows a large emoji icon (`meta.icon`), the app **name** (`meta.title`), and the **description** (`meta.desc`). **The whole tile is the link** (the `<a>` wraps the card). NOT the Sensors-style left-list / split-pane (there is no per-app detail/editor pane here — the app launches, it isn't edited in the dashboard). Style with the existing Tailwind dark theme + accent vars (match the dashboard; zero new design system).

### List freshness (APPSUI-04)
- **D-03 (Refetch on open + window refocus).** The list is fetched at runtime from the enumeration endpoint via **TanStack Query with its default `refetchOnMount` + `refetchOnWindowFocus`** behavior — exactly how the Skills/Sensors/Tasks pages already work. A just-built app appears the moment you (re)open the Apps page or the tab regains focus; a deleted app disappears the same way. **No SSE, no polling** — apps change rarely, and the existing query defaults satisfy "reflects appearing/disappearing without a dashboard rebuild" with zero extra infra. (SSE via `/api/stream` and short polling were both considered and rejected as over-engineering for a rarely-changing list.)

### Sidebar item
- **D-04 (Icon + position).** Add a sidebar nav item labeled **"Apps"** using the **`LayoutGrid`** lucide-react icon (reads as "a collection of apps / a launcher"), positioned **right after Sensors** in the nav order (it clusters naturally with the other workspace-discovered capability artifacts: Skills, Tasks, Sensors, then Apps). New `NavLink` to `/apps` in `Sidebar.tsx`'s nav array + `LayoutGrid` added to `NAV_ICONS`.

### Claude's Discretion
- **Enumeration source.** Consume the **existing `GET /apps/` endpoint directly** (it already returns exactly `[{ slug, meta: { title?, icon?, desc? } }]`) using the dashboard's `request()` wrapper (`credentials:'include'`). Do NOT add a redundant `/api/apps` proxy route in the dashboard server — the endpoint exists and returns the right shape. (`GET /apps/` is un-authenticated by Phase-55 design; sending the session cookie is harmless. The dashboard `request()` helper works on any same-origin path, not just `/api/*`.) If the planner finds a concrete reason a thin `/api/apps` route is needed (e.g. response-shape normalization), that's an acceptable alternative — but default to consuming `/apps/` directly.
- **Metadata fallbacks.** Missing `meta.title` → fall back to the `slug`; missing `meta.icon` → a neutral default glyph (e.g. a generic app/box emoji or the LayoutGrid icon); missing `meta.desc` → omit the description line. Apps with no `meta.json` still list (enumeration returns `meta: {}`).
- **Empty state.** When zero apps exist, show a friendly empty-state card — e.g. "No apps yet — ask shrok to build one."
- **Broken apps.** The Apps page stays dumb about broken state: enumeration (`listApps`) does NOT import app modules, so a broken app still lists and renders as a normal tile. Clicking it launches `/apps/<slug>/`, whose own route surfaces the Phase-55 (D-09) per-app error. The Apps page does not need to detect or special-case load failures.
- Exact component file layout (`dashboard/src/pages/AppsPage.tsx` + an `api.apps.list` entry in `dashboard/src/lib/api.ts`), card markup/spacing, and the response TypeScript type are implementation details for the planner/executor.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 55 — the serving subsystem this UI consumes
- `.planning/phases/55-app-serving-subsystem/55-CONTEXT.md` — locked decisions: D-01 global apps, D-02 filesystem discovery, the enumeration endpoint, the `/apps/<slug>/` mount above the SPA catch-all. Read before assuming anything about the backend.
- `src/apps/router.ts` — the live apps router. **`GET /apps/`** is the enumeration endpoint this page consumes: returns `listApps(appsDir)` = `[{ slug, meta: Record<string,string> }]`, un-authenticated, does NOT import app modules (so broken apps still list). Per-app routes (`/:slug/`, `/:slug/api`, `/:slug/api/action`) are `requireAuth`-gated and NOT touched by this phase.
- `src/apps/discovery.ts` — `listApps()` (the exact enumeration shape) and `AppMod.meta = { title?, icon?, desc? }` (the metadata fields the cards render).

### Dashboard frontend — the surface this phase edits (the Sensors page is the closest analog)
- `dashboard/src/components/layout/Sidebar.tsx` — nav-item array (~line 183) + `NAV_ICONS` map (~line 117). Add the "Apps" `NavLink` (`{ to: '/apps', label: 'Apps' }`) after Sensors + `LayoutGrid` to `NAV_ICONS`.
- `dashboard/src/router.tsx` — react-router v6 config; add `{ path: '/apps', element: <AppsPage /> }` under the `AppShell` children.
- `dashboard/src/pages/SensorsPage.tsx` — closest existing analog (a workspace-discovered list fetched via `useQuery`); reference for the fetch + render pattern, NOT for the split-pane layout (D-02 uses a tile grid instead).
- `dashboard/src/lib/api.ts` — the shared `request<T>()` wrapper (`credentials:'include'`) + the `api.*` namespaces; add an `api.apps.list()` calling `GET /apps/`.
- `src/dashboard/server.ts` (~line 363, `app.use('/apps', createAppsRouter(...))` mounted above the `express.static` + `app.get('*')` SPA catch-all) — confirms a full-page nav to `/apps/<slug>/` leaves the SPA (D-01).

### Build/release constraint (AGENTS.md)
- `AGENTS.md` — **CI is the sole writer of `dashboard/dist/`.** Do NOT commit `dashboard/dist/`; bump `dashboard/package.json` in lockstep with the root only on a version cut, not here. Build locally for testing (`cd dashboard && npm run build`) but leave dist unstaged. This is what makes APPSUI-04 ("no dashboard rebuild" for new apps) meaningful — the list is data-driven at runtime, so the committed dist never changes when an app is added.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`GET /apps/` enumeration endpoint** — already built and tested (Phase 55); returns precisely `{ slug, meta:{title,icon,desc} }[]`. The page is purely a consumer.
- **`request()` + TanStack Query** (`dashboard/src/lib/api.ts`) — the fetch + caching + refetch-on-mount/focus machinery (D-03) already exists; add one namespace entry, no new infra.
- **lucide-react icons + the `NAV_ICONS`/`NavLink` sidebar pattern** — adding a nav item is a 2-line change.
- **`AppShell` + react-router `Outlet`** — adding a page is one route entry + one component.

### Established Patterns
- Sidebar nav = static array of `{ to, label }` + a `NAV_ICONS` lucide map; active state via `NavLink isActive`.
- Pages fetch list data with `useQuery({ queryKey, queryFn: api.<x>.list })`; Tailwind dark theme + `var(--accent)` for styling; zero custom CSS frameworks.
- Out-of-SPA / external links use plain `<a href>` (existing examples: media downloads, markdown links with `target="_blank"`); this phase's app links are same-tab plain `<a href>`.

### Integration Points
- `dashboard/src/components/layout/Sidebar.tsx` (nav array + `NAV_ICONS`).
- `dashboard/src/router.tsx` (new `/apps` route under `AppShell`).
- `dashboard/src/pages/AppsPage.tsx` (new file).
- `dashboard/src/lib/api.ts` (new `api.apps.list()` → `GET /apps/`).
- The backend (`src/apps/router.ts`) needs **no change** — `GET /apps/` already serves the list.

</code_context>

<specifics>
## Specific Ideas

- The page is a **launcher**, not a manager — no create/edit/delete/detail UI in the dashboard (apps are authored by the agent in Phase 56, served standalone). Tile click → launch, full stop.
- Match the vms-apps home-page card-grid feel (large emoji icon + title + one-line description tiles) since the user already likes that launcher aesthetic for app collections.

</specifics>

<deferred>
## Deferred Ideas

- **Live (SSE) updates of the open Apps list** — considered for APPSUI-04, rejected as over-engineering (refetch-on-open+focus suffices for a rarely-changing list). Revisit only if instant in-place updates are ever wanted.
- **In-dashboard app management** (rename / delete / see broken-app status / view an app's `meta`/data) — out of scope; the dashboard is a launcher. The agent manages apps (Phase 56); a future phase could add a management surface if desired.
- **Per-head app filtering on the page** — apps are global (Phase 55 D-01); no per-head view. Future-only if per-head apps ever ship.

None of these are in Phase 57 scope.

</deferred>

---

*Phase: 57-Dashboard "Apps" Section*
*Context gathered: 2026-06-27*
