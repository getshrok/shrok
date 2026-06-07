/**
 * Tool allowlist resolution helper — single source of truth for both enforcement points.
 *
 * Tri-state encoding (TOOLCFG-07):
 *   undefined  = key absent  = INHERIT (fall through to the next layer)
 *   null       = key present = ALL tools
 *   string[]   = key present = SUBSET (only those tools)
 *
 * exactOptionalPropertyTypes implication: callers must omit the key entirely (not pass
 * undefined explicitly) to represent the "inherit" state. `T | undefined` at the call
 * site is identical from JS's perspective, but Zod's .optional() / TypeScript's
 * exactOptionalPropertyTypes keeps the distinction real at the type level.
 */

/**
 * Resolve the effective tool allowlist for a given layer (head tools OR agent tools).
 *
 * @param perHeadOverride - The per-head override for this layer.
 *   - `undefined` (key absent): inherit from the global default
 *   - `null`: all tools
 *   - `string[]`: only those tools (may be empty — "everything off")
 * @param globalDefault - The global default for this layer.
 *   - `undefined` (key absent): treat as "all tools"
 *   - `null`: all tools
 *   - `string[]`: only those tools
 * @returns
 *   - `null`     → all tools are allowed
 *   - `string[]` → only those tools are allowed (empty array = no tools allowed)
 */
export function resolveAllowlist(
  perHeadOverride: string[] | null | undefined,
  globalDefault: string[] | null | undefined,
): string[] | null {
  if (perHeadOverride !== undefined) {
    // Per-head override is explicitly set — use it regardless of global default.
    // null = all tools, array = that subset (including empty = no tools).
    return perHeadOverride
  }
  if (globalDefault !== undefined) {
    // No per-head override; fall through to global default.
    // null = all tools, array = that subset.
    return globalDefault
  }
  // Neither layer is set — all tools allowed.
  return null
}
