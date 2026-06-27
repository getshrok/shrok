---
phase: 55-app-serving-subsystem
fixed_at: 2026-06-26T23:28:00Z
review_path: .planning/phases/55-app-serving-subsystem/55-REVIEW.md
iteration: 1
findings_in_scope: 5
fixed: 5
skipped: 0
status: all_fixed
---

# Phase 55: Code Review Fix Report

**Fixed at:** 2026-06-26T23:28:00Z
**Source review:** `.planning/phases/55-app-serving-subsystem/55-REVIEW.md`
**Iteration:** 1

**Summary:**
- Findings in scope: 5 (CR-01, CR-02, CR-03, WR-01, WR-02)
- Fixed: 5
- Skipped: 0

## Fixed Issues

### CR-01: Reflected XSS — unvalidated slug in HTML 404 response

**Files modified:** `src/apps/router.ts`, `src/apps/router.test.ts`
**Commit:** `7be2e76`
**Applied fix:** Added `.type('text')` before `.status(404).send(...)` in the `GET /:slug/` handler so the response is `text/plain` rather than `text/html`. The body text is unchanged; only the content type changes. Added regression test asserting that a 404 for an XSS-shaped slug (`<script>alert(1)</script>`) returns `text/plain`, not `text/html`.

---

### CR-02: Stored XSS — agent-controlled exception message in HTML 500 response

**Files modified:** `src/apps/router.ts`, `src/apps/router.test.ts`
**Commit:** `7be2e76`
**Applied fix:** Added `.type('text')` before `.status(500).send(...)` in the `GET /:slug/` handler so the error message from `loaded.error` is sent as `text/plain`. Added regression test asserting that the broken-app 500 response is `text/plain`, not `text/html`.

---

### CR-03: Stored XSS — agent-authored title from meta.json injected unescaped into HTML shell

**Files modified:** `src/apps/shell.ts`, `src/apps/shell.test.ts`
**Commit:** `d3b6695`
**Applied fix:** Added `escapeHtml()` helper in `shell.ts` that escapes `& < > " '` to their HTML entities. Applied it to the `title` argument in `renderShell()`. The `__SLUG__` substitution is unchanged (slug is SLUG_RE-validated to `[a-z0-9-]`, no HTML-special characters possible). Added three regression tests in `shell.test.ts`:
- `</title><script>alert(document.cookie)</script>` title is entity-escaped; no raw `<script>` survives in output
- All five HTML-special characters (`& < > " '`) are escaped
- Benign titles without HTML-special characters pass through unchanged

---

### WR-01: Unhandled rejection in `_skill.md` handler

**Files modified:** `src/apps/router.ts`
**Commit:** `7be2e76`
**Applied fix:** Removed the `void` prefix from `webRes.text().then(...)` and added `.catch((e: unknown) => { ... })` that sends a 500 `text/plain` response and logs the error via `console.error`. A rejection now surfaces as a 500 to the client instead of silently hanging the connection.

---

### WR-02: Broken-app load errors are permanently cached; operator cannot recover without restart

**Files modified:** `src/apps/discovery.ts`
**Commit:** `dc130b6`
**Applied fix:** Added a multi-line code comment in the `catch` block of `loadApp()` documenting that error caching is intentional (prevents retrying the dynamic import on every request for a broken app), that the trade-off is restart-required to fix a broken app, and that this is by design per D-02. No behavioural change.

---

## Skipped Issues

None.

---

_Fixed: 2026-06-26T23:28:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
