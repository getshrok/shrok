# Developer Mode

Developer mode is a toggle in the dashboard's Settings that reveals Shrok's more technical surface: logs, tests, evals, and the deeper identity files.

## Turning it on

**Settings > General > Mode** has two options: **Standard** and **Development**. Pick Development and the choice sticks (stored in `localStorage`, so it's per-browser, not global). Switching modes only changes which controls and pages are visible. It doesn't change how Shrok behaves.

## What it unlocks

Two things:

1. Reveals the **Logs**, **Tests**, and **Evals** pages in the sidebar.
2. Exposes the full set of steward and proactive prompts.

## Logs

The Logs page shows trace files from every run. Traces live on disk as `.log` files under the configured trace directory. For each source type (head, agent, steward, process) there's a `*-latest.log` symlink pointing at the most recent run, plus the last 50 per type (older ones are pruned automatically).

Each trace shows the assembled system prompt, the messages, tool calls and their results, and token counts. Enough to see exactly what the model saw and what came back.

### Logs are local

Traces are files in your Shrok workspace. They don't leave the machine. They grow over time (each source type is capped at 50 files, but those files can be large), so if the trace directory is getting heavy you can safely delete old files by hand.

## Tracing and timing

Two lower-level instrumentation tools exist alongside the Logs page:

- **The tracer** (`src/tracer.ts`) writes the `.log` files. It's always on. Files land under the configured `traceDir`; the dashboard just presents them.
- **The timing checkpoint log** (`src/timing.ts`) records `+ms` marks for internal events (activation start, LLM call start/end, steward dispatch, etc) to a file under the OS temp dir (`shrok-timing-*.log`). Gated on the `SHROK_TIMING` env flag, though the current code has it hardcoded on for debugging. Expect a timing file to appear every run until that's reverted.

## Tests

The Tests page runs Shrok's test suites from the dashboard. Two suites:

- **Unit** -- fast in-process tests, no external dependencies (`npm test`, which runs `vitest run`).
- **Integration** -- real LLM calls, requires a working `ANTHROPIC_API_KEY`, takes roughly 90s (`npm run test:integration`).

Tests are colocated with the code they cover (`src/**/*.test.ts`); integration tests live under `tests/integration/`. Both use [Vitest](https://vitest.dev), so from a shell you can also run a single file or test with `npx vitest run <path>` or `-t <pattern>`.

## Evals

Evals are scenario-based evaluations that test Shrok as close to real usage as possible. Where tests answer "does the code work," evals answer "does Shrok do the right thing in this situation." They're the primary tool for catching quality regressions that don't show up as broken code.

Each scenario lives in `scripts/eval/scenarios/<name>.ts` and exports:

- A rubric (dimensions to score)
- An `estimatedCostUsd`
- A category (`memory`, `identity`, `routing`, `reliability`, or `stress`)
- A `run()` function that drives a real conversation through the actual `ActivationLoop`

A judge model scores the output against the rubric and writes both a narrative walkthrough and per-dimension scores (0.0-1.0). Below 0.5 on any dimension fails the scenario.

### Running evals

From the dashboard: pick one or more scenarios, see the estimated cost, click Run. Progress streams live. Click a result to see the narrative and scores.

From the command line:

```bash
npm run eval                    # run everything
npm run eval:memory-formation   # run one by name
tsx scripts/eval/run.ts memory-formation archival-recall   # multiple
tsx scripts/eval/run.ts memory-formation --no-judge        # skip the judge
```

Results land in `eval-results/` as paired `.json` + `.txt` files, and are also persisted to the workspace DB so the dashboard can list past runs.

### Eval cost

Evals cost real money. Each scenario runs real model calls and the judge always calls Sonnet regardless of your provider. A single scenario is usually pennies to tens of cents; a full run across all scenarios can be a few dollars. The Evals page shows each scenario's estimated cost before you run so you can pick a subset.

## Related docs

- [identity-files.md](./identity-files.md) -- what each identity file does
- [stewards.md](./stewards.md) -- the steward prompts that become editable in dev mode
- [architecture.md](./architecture.md) -- context for what logs/tests/evals are exercising
