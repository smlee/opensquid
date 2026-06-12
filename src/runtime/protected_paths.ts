/**
 * The single writable home for the "is this change docs-only (non-code)?" predicate.
 *
 * Shared by the EXECUTE-gate boundary (`src/setup/cli/gate.ts`) and the in-session commit
 * nudge (via the `staged_docs_only` primitive, `src/functions/staged_docs_only.ts`) so the
 * two enforcement points can never diverge. A pure leaf — zero imports — so the hot
 * function-registry layer can import it without dragging in the gate's CLI/runtime chain.
 *
 * Imported by: src/setup/cli/gate.ts, src/functions/staged_docs_only.ts.
 */

/** The code prefixes the coding-flow protects. A change touching NONE of these is "docs-only"
 *  (non-code: README, banner, docs/, LICENSE, CI config…). Keep in sync with the
 *  scope-lifecycle write-gate substrings — the drift pin in gate.test.ts enforces it. */
export const PROTECTED_PREFIXES = ['src/', 'packs/', 'test/'] as const;

/** True iff every changed file is OUTSIDE the protected (code) prefixes. Empty set → `false`
 *  (fail closed: "nothing proves this docs-only"). Paths are git repo-relative. */
export const isDocsOnly = (files: string[]): boolean =>
  files.length > 0 && files.every((f) => !PROTECTED_PREFIXES.some((p) => f.startsWith(p)));
