/**
 * Shared specification for the `description` input parameter on in-scope tool schemas.
 *
 * Every in-scope tool (bash, bash_no_net, spawn_agent [both sub-agent registry and
 * HEAD_TOOLS variants], write_file, edit_file, web_fetch, send_file) places this text
 * as its `description` parameter's schema description. Single source of truth — editing
 * one schema by accident is caught by the table-driven unit test in
 * src/tool-description.test.ts.
 *
 * Verbatim from REQUIREMENTS.md TOOL-03. Do not paraphrase.
 */
export const DESCRIPTION_PARAM_SPEC =
  'One short sentence (~15 words) explaining the intent of this call in active voice. Prefer the non-obvious why over restating visible arguments. Written for a user skimming a chat feed, not a changelog.'
