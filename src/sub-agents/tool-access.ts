/**
 * Tool allowlist resolution helper — single source of truth for both enforcement points.
 *
 * Two-state encoding (TOOLCFG-07, D-04):
 *   key absent (undefined) = INHERIT (fall through to the next layer)
 *   string[]               = SUBSET (only those tools; empty array = no tools)
 *
 * Legacy tolerance (D-05): a literal `null` passed in either argument is treated the same
 * as "absent for feature purposes" — it falls through to the next layer rather than
 * meaning "all tools". The UI and config write path never produce `null`; `null` is only
 * tolerated at the schema boundary for backward-compat with pre-v1.8 config.json values.
 *
 * exactOptionalPropertyTypes implication: callers must omit the key entirely (not pass
 * undefined explicitly) to represent the "inherit" state. `T | undefined` at the call
 * site is identical from JS's perspective, but Zod's .optional() / TypeScript's
 * exactOptionalPropertyTypes keeps the distinction real at the type level.
 */

/**
 * Resolve the effective tool allowlist for a given layer (head tools OR agent tools).
 *
 * Two-state model:
 *   - `perHeadOverride` is an array → return it as the resolved subset.
 *   - `perHeadOverride` is absent (undefined or legacy null) + `globalDefault` is an array → return global.
 *   - Both absent (undefined or legacy null) → return `[]` (no tools; callers supply a
 *     meaningful pre-feature default as `globalDefault` so this path is only reached when
 *     neither layer has ever been configured).
 *
 * @param perHeadOverride - The per-head override for this layer.
 *   - `string[]`: only those tools (may be empty — "everything off"); key must be present.
 *   - `undefined` (key absent): inherit from the global default.
 *   - `null`: legacy tolerated input; normalized to fall-through (same as absent).
 * @param globalDefault - The global default for this layer. Typically the pre-feature
 *   default constant (10 head-tool names or 25-tool agent array) so a no-config install
 *   reproduces pre-feature behavior exactly.
 *   - `string[]`: the layer's default subset.
 *   - `undefined` or `null`: not set — fall through to `[]`.
 * @returns `string[]` — the concrete resolved allowlist. Never returns `null`; the
 *   "all tools" concept is expressed by supplying the full layer-compatible pool as the
 *   globalDefault and omitting any override.
 */
export function resolveAllowlist(
  perHeadOverride: string[] | null | undefined,
  globalDefault: string[] | null | undefined,
): string[] {
  // Per-head override present (array) → wins over global.
  // null is treated as absent (legacy tolerance, D-05) — falls through.
  if (Array.isArray(perHeadOverride)) {
    return perHeadOverride
  }
  // No per-head array override; fall through to global default.
  if (Array.isArray(globalDefault)) {
    return globalDefault
  }
  // Neither layer has a concrete array — return empty (no tools).
  // In practice this path is never reached for the head layer (caller passes
  // HEAD_TOOL_NAMES as globalDefault) or agent layer (workerDefaults.allowedTools
  // ships a 25-tool array in base config.json).
  return []
}
