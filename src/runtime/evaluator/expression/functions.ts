/**
 * Function allow-list registry — STUB for H.1.4 (real registry lands in H.1.5).
 *
 * The interpreter dispatches `call` nodes through this registry. H.1.5 will
 * populate the 5 pure functions (len, contains, match, startsWith, endsWith)
 * per pre-research §4. During H.1.4 the registry is empty so call-dispatch
 * tests inject their handler locally — `interpreter.test.ts` mutates the
 * registry inside a single test block and restores it after.
 *
 * Allow-list discipline (enforced in H.1.5): pure (no I/O, no time, no
 * random), documented coercion table, ≥3 tests per function, ReDoS callout
 * for regex-bearing functions. See docs/skill-grammar-guide.md.
 */

export type FnHandler = (...args: unknown[]) => unknown;

/**
 * Allow-listed functions. `interpreter.ts` looks up by name and throws
 * `InterpreterRuntimeError('unknown function: <name>')` on miss. Empty
 * during H.1.4 — populated in H.1.5.
 */
export const FUNCTIONS: Record<string, FnHandler> = {};
