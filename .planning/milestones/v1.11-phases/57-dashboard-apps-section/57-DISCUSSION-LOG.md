# Phase 57: Dashboard "Apps" Section - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-27
**Phase:** 57-Dashboard "Apps" Section
**Areas discussed:** Launch behavior, Page layout, List freshness, Sidebar item

---

## Launch behavior

| Option | Description | Selected |
|--------|-------------|----------|
| New tab | `target="_blank"` — app opens in a new tab; dashboard stays open behind it. Most launcher-like. | |
| Same tab | Full navigation — dashboard replaced by the app page; browser Back returns. Simpler, one tab. | ✓ |

**User's choice:** Same tab
**Notes:** Implemented as a plain `<a href="/apps/<slug>/">` (no `target`, no react-router `<Link>`). Works because `/apps/*` is mounted above the SPA catch-all, so a full-page nav leaves the SPA and hits the app shell.

---

## Page layout

| Option | Description | Selected |
|--------|-------------|----------|
| Card/tile grid | Each app is a tile: large emoji icon + name + description, responsive grid. Launcher feel, matches vms-apps home page. Whole tile is the link. | ✓ |
| List rows | Each app is a row: small icon + name + desc on one line. Matches Sensors page; denser. | |

**User's choice:** Card/tile grid
**Notes:** Launcher, not a manager — no detail/edit pane. Match the vms-apps home-page card aesthetic.

---

## List freshness (APPSUI-04)

| Option | Description | Selected |
|--------|-------------|----------|
| On open + refocus | Refetch on page mount + window focus (TanStack Query defaults). Zero extra infra; matches Skills/Sensors. | ✓ |
| Live via SSE | Push updates over `/api/stream`; open page updates in real time. Needs a new server event on app folder changes. | |
| Short polling | Refetch on a 10–30s timer while open. Mild constant traffic. | |
| On open only | Refetch only on mount; no refocus/poll. Simplest. | |

**User's choice:** On open + refocus
**Notes:** SSE and polling rejected as over-engineering for a rarely-changing list. Query defaults already satisfy "reflects appearing/disappearing without a rebuild."

---

## Sidebar item

### Icon

| Option | Description | Selected |
|--------|-------------|----------|
| LayoutGrid | 2×2 grid of squares — "a collection of apps / launcher." Distinct from other nav glyphs. | ✓ |
| AppWindow | Window/app frame — literal "apps," but close to a generic window. | |
| Package | A box — "built/shipped things." | |
| Grid3x3 | 3×3 grid — app-drawer connotation, busier. | |

### Position

| Option | Description | Selected |
|--------|-------------|----------|
| After Sensors | Grouped with workspace-capability items (Skills, Tasks, Sensors, then Apps). | ✓ |
| After Docs (bottom) | End of main nav, above developer-only Logs. | |
| Right after Conversation | Near the top, high prominence. | |

**User's choice:** `LayoutGrid` icon, positioned after Sensors
**Notes:** Apps cluster naturally with the other workspace-discovered artifacts.

---

## Claude's Discretion

- Consume the existing `GET /apps/` endpoint directly (returns `[{slug, meta}]`) rather than adding a redundant `/api/apps` proxy route.
- Metadata fallbacks: missing title → slug; missing icon → neutral default glyph; missing desc → omit.
- Empty state: friendly "No apps yet — ask shrok to build one" card.
- Broken apps: still list (enumeration doesn't import); render as normal tiles; clicking surfaces the per-app error on the app's own page.
- Exact component file layout, card markup, and response types are planner/executor details.

## Deferred Ideas

- Live (SSE) updates of the open Apps list — rejected; refetch-on-open+focus suffices.
- In-dashboard app management (rename/delete/broken-status/inspect) — out of scope; dashboard is a launcher.
- Per-head app filtering — apps are global (Phase 55 D-01); future-only.
