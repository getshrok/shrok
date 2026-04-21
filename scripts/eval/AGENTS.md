# Eval System

## Philosophy

Evals are the primary tool for real-world quality testing — they replace user testing and cover what unit/integration tests cannot: does the system actually behave well in realistic conversation flows?

The guiding principle is **real-world fidelity**: evals should mirror how Shrok is actually used, not shortcut around it. This means:

- Conversations must feel authentic — natural language, topic drift, specific details the system should remember
- History must accumulate realistically — no shortcutting by clearing state; if the test needs archival to trigger, fill the store with enough messages that archival fires naturally
- System paths must be real — use actual `ActivationLoop`, real memory chunking, real agent runners, not stubs

If you find yourself "simulating" a step by directly manipulating state instead of running through the real code path, that's a signal the eval is not testing what it claims to test.

## Running evals

```bash
npm run eval                          # run all 25 scenarios
npm run eval:memory                   # run one scenario by name
npm run eval:memory archival          # run multiple (space-separated)
tsx scripts/eval/run.ts memory --no-judge   # skip judge, dump raw output
tsx scripts/eval/run.ts memory --replay ./eval-results/2026-01-01-memory.json
```

Results are written to `eval-results/` as `<timestamp>-<scenario>.json` + `.txt`, and persisted to the Shrok workspace DB if it's available (migration `018_eval_results.sql`).

## Scenario structure

Each scenario file in `scenarios/` exports:

```typescript
export const name = 'scenario-name'
export const description = 'One-line explanation of what is being tested'
export const category = 'memory' // memory | identity | routing | reliability | stress
export const estimatedCostUsd = 0.12
export const rubric = [
  'dimension_name — what to look for and how to score it',
]

export async function run(opts: {
  replayHistory?: EvalMessage[]
  noJudge?: boolean
  runId?: string
}): Promise<void>
```

The `rubric` and `estimatedCostUsd` exports are module-level — not inline inside `run()`. This allows the dashboard to display them without running the scenario.

### estimatedCostUsd

A best-effort estimate of what this scenario costs to run end-to-end assuming Anthropic Sonnet throughout. The judge always uses `claude-sonnet-4-6` regardless of the configured provider, so this number is never zero even for subscription-based providers. Use it to distinguish cheap from expensive before clicking Run.

**Update `estimatedCostUsd` when you change a scenario** in ways that meaningfully affect cost: adding/removing filler messages, changing the number of archival passes, adding or removing `runHeadQuery` calls, or substantially changing fixture size. Rough cost signals (Anthropic Sonnet assumption):

| Indicator | Approximate cost per instance |
|---|---|
| Single `runHeadQuery` | +$0.02–0.05 |
| `archiveUntilGone` with 80 filler msgs | +$0.05–0.10 |
| `archiveUntilGone` with 320+ filler msgs | +$0.15–0.25 |
| Full `ActivationLoop` E2E sub-scenario | +$0.03–0.08 |
| 10+ dense fixture sessions | +$0.20+ |
| 30 repeated trials | +$0.50+ |

## Writing a new scenario

1. **Pick the right category**: memory (retrieval, archival, continuity), identity (preferences, corrections, learning), routing (skill delegation, agent relay), reliability (hallucination, silence, loops), stress (combined load, edge cases)

2. **Design the history first**: what does the user say? what details should the system remember or act on? Write the seed for `generateHistoryCached()` to produce that conversation. Be specific — names, numbers, dates give the judge something concrete to verify.

3. **Use `makeProductionEnvironment()`** for any eval that tests Head or agent behavior. This creates a temp workspace with the full production directory structure (identity files, skills dir, AMBIENT.md, config with real workspacePath). Override specific pieces via `EnvironmentOverrides` — don't build the environment manually. For lower-level library tests (memory chunking, archival), `freshHeadBundle()` + `freshServices()` are still appropriate.

4. **Write a tight rubric**: each dimension should be independently testable and roughly binary — either the system did X or it didn't. Avoid vague dimensions like "response quality". Good: `updated_preference_recalled — does the response reflect the CHANGED preference (prose, not bullets)?`. Bad: `overall_quality — was the response good?`

5. **Pass `runId` and `category` to `writeResults()`**:
   ```typescript
   await writeResults(name, history, output, judgment, { runId: opts.runId, category })
   ```

6. **Register in `run.ts`**: import the module and add it to `ALL_SCENARIOS`.

7. **Add the npm script in `package.json`**:
   ```json
   "eval:your-scenario": "tsx scripts/eval/run.ts your-scenario"
   ```

## Fixture caching

`generateHistoryCached()` generates a conversation on first run and saves it to `fixtures/<name>.json`. Subsequent runs replay the cached fixture for determinism and cost savings. Cached fixtures are committed to the repo.

If a scenario's history needs to change (the seed changed, or new details are needed), delete the fixture file and re-run — it will regenerate.

## Interpreting results

The judge scores each dimension 0.0–1.0:
- **≥ 0.8** — working well
- **0.5–0.8** — working but with issues worth investigating
- **< 0.5** — failing this dimension (also causes overall PASS: false)
- **PASS** — true only if every dimension ≥ 0.5

The `narrative` field in the judgment is a step-by-step walkthrough of what happened and why each dimension scored the way it did — read this first before looking at individual scores.

A scenario can PASS with low scores (e.g. all dimensions at 0.6). A PASS just means nothing is broken; the narrative tells you whether the system is doing the right thing for the right reasons.

## Harness utilities

See `harness.ts` for full documentation. Key helpers:

- `freshHeadBundle()` — isolated in-memory DB + stores + mock channel router for E2E Head tests
- `runHeadQuery()` — run a single message through the full ActivationLoop
- `generateHistoryCached()` — generate + cache a conversation fixture
- `freshServices()` — minimal DB services for library-level tests (memory, archival)
- `seedFillerMessages()` — pad the message store with mundane conversation to push historical content into the archival window
- `archiveUntilGone()` — loop archival until specified messages are gone from the live store
- `makeEvalIdentityDir()` — fresh identity dir seeded from defaults with BOOTSTRAP.md cleared
- `makeProductionEnvironment()` — **preferred for new evals** — full production-faithful workspace (see below)
- `cleanupEnvironment()` — clean up a production environment's temp workspace
- `judge()` — LLM-as-judge using claude-sonnet-4-6; always uses `rubric` (the module-level export)

## Production environment

`makeProductionEnvironment(overrides?)` creates a temp workspace that mirrors a real Shrok install:

```
{tempDir}/
  identity/       ← seeded from defaults, BOOTSTRAP.md cleared
  sub-agents/     ← agent identity defaults
  skills/         ← empty (seed via overrides.skills)
  data/           ← for traces
  media/          ← empty
  AMBIENT.md      ← default bland ambient (override via overrides.ambientContent)
```

Returns an `EvalEnvironment` with `bundle`, `workspaceDir`, `identityDir`, `skillsDir`, `config`, and `ambientPath`. Pass `env.workspaceDir` to `runHeadQuery`/`runHeadEvent` via the `workspaceDir` opt so agents get a real workspace path.

**Overrides:**
- `config`: merge into eval config
- `ambientContent`: `string` = custom, `undefined` = default bland ambient, `null` = no AMBIENT.md
- `identityFiles`: `{ 'USER.md': 'custom content' }` to override specific identity files
- `skills`: `[{ name: 'my-skill', content: '---\nname: ...' }]` to seed skills

**Why this matters:** Every feature that reads from the workspace (AMBIENT.md, identity files, skills) needs to be present in evals or you're testing a different system than what runs in production.

## Failure modes to watch for

**Shortcut smell**: the scenario manually clears history, directly writes to memory, or patches state instead of running through real code paths. Real scenarios feed messages and let the system respond.

**Rubric dimensions that aren't independently testable**: if two dimensions always move together (both pass or both fail), they're probably measuring the same thing — collapse them or make one more specific.

**Judge context that's too sparse**: the judge only knows what you put in `context`. If the judge can't tell whether recall_memory was called, include the tool call transcript. If it can't verify a specific fact, include the relevant history excerpt.

**Curated bullet summaries cause false fabrication flags**: if your rubric asks "did the system avoid fabricating details from the conversation?", the judge must see the actual conversation — not a hand-written summary of it. A summary of 4 key facts will cause the judge to flag anything outside those 4 facts as unverified or fabricated, even if it was clearly stated in the fixture. The fix is to include the relevant session(s) in full: `${session.map(m => \`[\${m.role.toUpperCase()}] \${m.content}\`).join('\n\n')}`. This costs more tokens in the judge call but produces accurate verdicts. When a scenario has a "no_fabrication" dimension, ask yourself: does the judge have enough raw context to actually distinguish fabrication from legitimate recall? If not, add the source material.

**Fixture staleness**: if a scenario consistently passes but behavior has changed, the cached fixture may no longer reflect the system's actual capability. Delete and regenerate.
