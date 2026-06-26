// src/apps/shell.ts
// Host-owned HTML shell template for VMS apps served under the /apps mount (D-03/D-04/D-05).
//
// The agent never authors HTML — the host generates a page per request by substituting
// __SLUG__ and __TITLE__ into this template.
//
// Every asset and wire URL is under the /apps mount (D-05):
//   /apps/_pkg/styles.css, /apps/_pkg/theme.css     — VMS stylesheet bundle
//   /apps/_pkg/index.js, /apps/_pkg/browser.js       — VMS browser bundle (importmap)
//   /apps/__SLUG__/api, /apps/__SLUG__/api/action     — VMS wire endpoints
//   /apps/_skill.md                                   — agent operating manual
//
// pkgDir: resolved from import.meta.url so the path is correct under tsx, the built
// dist/, and inside Docker without any hardcoded /home/... path.
// Mirrors the idiom at src/dashboard/server.ts:283 and :357.
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The VMS package directory.
 * src/apps/shell.ts → dist/apps/shell.js → ../../ = repo root.
 * Never hardcode /home/thenasty/vms-apps or any absolute host path here.
 */
export const pkgDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../node_modules/@ashley-shrok/viewmodel-shell'
)

/**
 * HTML shell template.
 * __SLUG__ appears in: meta endpoint/actionEndpoint, importmap, inline script
 *   endpoint/actionEndpoint, and the onError label — renderShell replaces ALL occurrences.
 * __TITLE__ appears once in <title>.
 */
export const SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="viewmodel-shell" content='{"protocol":"viewmodel-shell/1.0","endpoint":"/apps/__SLUG__/api","actionEndpoint":"/apps/__SLUG__/api/action","skill":"/apps/_skill.md"}'>
  <title>__TITLE__</title>
  <link rel="stylesheet" href="/apps/_pkg/styles.css">
  <link rel="stylesheet" href="/apps/_pkg/theme.css">
  <style>body { margin: 0; }</style>
</head>
<body>
  <div id="app"></div>
  <script type="importmap">
  {
    "imports": {
      "@ashley-shrok/viewmodel-shell": "/apps/_pkg/index.js",
      "@ashley-shrok/viewmodel-shell/browser": "/apps/_pkg/browser.js"
    }
  }
  </script>
  <script type="module">
    import { ViewModelShell } from "@ashley-shrok/viewmodel-shell";
    import { BrowserAdapter } from "@ashley-shrok/viewmodel-shell/browser";
    new ViewModelShell({
      endpoint:       "/apps/__SLUG__/api",
      actionEndpoint: "/apps/__SLUG__/api/action",
      adapter:        new BrowserAdapter(document.getElementById("app")),
      onError:        (e) => console.error("__SLUG__ error", e),
    }).load();
  </script>
</body>
</html>`

/**
 * HTML-escape a string for safe insertion into HTML text/attribute contexts.
 * Escapes & < > " ' — the five characters sufficient to prevent XSS in element
 * text content and double-quoted attribute values.
 *
 * Used for agent-authored values (e.g. meta.json title) before substitution into
 * the shell template. __SLUG__ substitution does not need this because SLUG_RE
 * constrains slugs to [a-z0-9-], which contains no HTML-special characters.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Produce the final HTML page for a discovered app.
 * Replaces ALL occurrences of __SLUG__ (endpoint + actionEndpoint in both meta and script,
 * plus the onError label) and __TITLE__ (single <title> element).
 *
 * slug is SLUG_RE-validated ([a-z0-9-] only) — no HTML-special characters, no escaping needed.
 * title comes from agent-authored meta.json — must be HTML-escaped to prevent XSS.
 */
export function renderShell(slug: string, title: string): string {
  return SHELL.replaceAll('__SLUG__', slug).replaceAll('__TITLE__', escapeHtml(title))
}
