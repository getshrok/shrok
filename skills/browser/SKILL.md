---
name: browser
description: Browse the web, interact with pages, and extract data. Two grounding modes — semantic (LLM-driven) for open-ended tasks, or deterministic (snapshot + ref-targeted primitives) for precise multi-step flows.
---

Single script: `browser.mjs` — run with `--help` for commands.

First run auto-installs npm dependencies and Chromium into the skill directory
(no global side effects). On Linux, you may also need Chromium's system
libraries once — if the first run exits with code 127, run:
`sudo node node_modules/playwright-core/cli.js install-deps chromium`.
Runs headless.

Browser sessions persist across invocations — navigate once, then act /
extract / click / type multiple times without re-specifying the URL. Sessions
auto-close after 10 minutes idle or 30 minutes total. Call `close` when done
to free resources immediately.

## Two grounding modes — pick per task

**(A) Semantic — hand the LLM a goal, let it decide.** Uses the active LLM
API key from the environment (ANTHROPIC_API_KEY / OPENAI_API_KEY /
GEMINI_API_KEY). When `SHROK_LLM_PROVIDER` is set, matches shrok's provider.

- `browse --url --task` — multi-step agent loop, up to 20 actions.
- `act [--url] --action` — single LLM-driven action ("click the search button",
  "select California from the state dropdown").
- `extract [--url] --query [--schema]` — structured data extraction; optional
  JSON-schema shape for the output.

**(B) Deterministic — snapshot the page, target elements by ref.** No LLM
needed for these. Fast, cheap, reliable.

- `snapshot [--url]` — walks the DOM, tags interactive elements with a
  `data-browser-ref` attribute, returns JSON: `{url, title, count, refs: [{ref, role, name, ...}]}`.
- `click --ref <N>`, `type --ref <N> --text <str>`, `press --ref <N> --key <key>`,
  `scroll [--ref <N>] [--direction up|down|top|bottom]` — target by ref.
- `highlight --ref <N> [--output <path>]` — outline an element in red and
  screenshot it (debug aid: verify a ref resolves to what you think).

**When to use which.** Semantic mode is great for open-ended tasks where you
trust the LLM to figure out the page. Deterministic mode is better when you
need precision, want to avoid LLM cost per step, or are repeating the same
flow across many sites/invocations. They're complementary — `snapshot` to
see what's there, `act` for the fuzzy step, `click --ref` for the targeted
next step.

## Critical: refs are invalidated by navigation

`snapshot` tags elements in the live DOM via `data-browser-ref`. Those refs
stay valid only as long as the page doesn't navigate. Any `click`/`type`/
`press` that triggers a navigation (URL change) invalidates **all** existing
refs — the command response will include `"navigated": true` and
`"snapshot_invalidated": true`.

When you see that, call `snapshot` again before targeting anything else. Do
not reuse old ref numbers across navigations.

## Always-available

- `screenshot [--url] --output` — no LLM needed.
- `close` — shuts down the browser session.
