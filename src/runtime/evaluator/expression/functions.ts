/**
 * Function allow-list registry — Task H.1.5.
 *
 * ALLOW-LIST ONLY. The interpreter dispatches `call` nodes through this
 * frozen registry; missing names throw `InterpreterRuntimeError('unknown
 * function: <name>')`. To add a new function, follow the 5-point expansion
 * checklist (pre-research §4.4):
 *
 *   1. **Cite a real skill** that needs it. Speculative adds rejected.
 *   2. **Confirm pure** — deterministic + side-effect-free (no I/O, no time,
 *      no random). Tests must include a determinism case.
 *   3. **Document new attack surface** —
 *        - Regex-accepting → ReDoS pattern (follow `match()` precedent).
 *        - String-returning → bounded length (cap ~10k chars to prevent
 *          step-cap evasion via huge strings).
 *        - Object-returning → must `Object.create(null)` the result.
 *   4. **Coercion table** documented per-input-type, every input → defined
 *      output, `undefined`/`null` defined, never throw.
 *   5. **≥3 tests** — happy + type-mismatch + edge (empty / null). Add a
 *      fuzz/adversarial case for any function touching strings.
 *
 * Comparable sets (post-research §4.2):
 *   - **Cerbos CEL:** size, contains, startsWith, endsWith, matches, in,
 *     filter, map, exists, all, sort (+ arithmetic, IP, time, path).
 *   - **GitHub Actions:** contains, startsWith, endsWith, format, join,
 *     toJSON, fromJSON, hashFiles, success, failure, always, cancelled.
 *   - Our 5 align with Cerbos's core string ops + GHA's core matchers. We
 *     deliberately OMIT `format`/`join`/`toJSON` (handled by `{{var}}`
 *     interpolation), `in` (sugar for `contains` with swapped args), and
 *     arithmetic (no skill needs math in v1).
 *
 * Coercion + signature reference (pre-research §4.3):
 *
 *   | Name         | Signature                              | Type-mismatch |
 *   | ------------ | -------------------------------------- | ------------- |
 *   | len(x)       | string|array|object → number           | returns 0     |
 *   | contains     | string × string → bool                 | returns false |
 *   | startsWith   | string × string → bool                 | returns false |
 *   | endsWith     | string × string → bool                 | returns false |
 *   | match        | string × string → bool                 | returns false |
 *
 * Handlers do NOT throw on type-mismatch — they return `false`/`0` (matches
 * the relational-op convention from `interpreter.ts:applyCompare`). Only
 * the interpreter's unknown-function path throws `InterpreterRuntimeError`.
 * Wrong arity is acceptable failure mode: missing args arrive as
 * `undefined` and the type guards coerce to the default.
 */

/** Handler signature: positional args are passed evaluated and unmodified. */
export type FnHandler = (...args: unknown[]) => unknown;

/** `len(x)` — string char count, array length, object key count, else `0`. */
const len: FnHandler = (x) => {
  if (typeof x === 'string') return x.length;
  if (Array.isArray(x)) return x.length;
  if (x !== null && typeof x === 'object') return Object.keys(x).length;
  return 0;
};

/** `contains(s, sub)` — substring test; false unless both args are strings. */
const contains: FnHandler = (s, sub) =>
  typeof s === 'string' && typeof sub === 'string' && s.includes(sub);

/** `startsWith(s, p)` — prefix test; false unless both args are strings. */
const startsWith: FnHandler = (s, p) =>
  typeof s === 'string' && typeof p === 'string' && s.startsWith(p);

/** `endsWith(s, p)` — suffix test; false unless both args are strings. */
const endsWith: FnHandler = (s, p) =>
  typeof s === 'string' && typeof p === 'string' && s.endsWith(p);

/**
 * `match(s, pattern)` — RegExp test; false on type-mismatch or invalid
 * pattern (the `new RegExp(p)` throw is swallowed by the try/catch).
 *
 * ReDoS risk (pre-research §12.1 LOCKED): v1 uses plain V8 `RegExp`, which
 * is vulnerable to catastrophic backtracking on adversarial patterns like
 * `(a+)+$` against long `aaaa...b` inputs. Acceptable for v1 because the
 * production threat model is first-party packs only — zero production
 * `if:` clauses use `match()` today, and there is no third-party pack
 * ecosystem to attack through yet. The fix is tracked as task **H.4
 * (redos-hardening)**: swap to `re2-wasm`'s `RE2` constructor (identical
 * API surface, ~250KB blob, ReDoS-immune by construction). Do NOT add a
 * `// TODO` here — comments rot; the H.4 task slot tracks the work.
 *
 * Comparable projects: Cerbos uses Go's stdlib `regexp` (RE2-derived, safe
 * for free from the language). Cloudflare Workers ships `re2-wasm` because
 * they run third-party untrusted code; opensquid v1 is structurally closer
 * to Cerbos's threat model.
 */
const match: FnHandler = (s, pattern) => {
  if (typeof s !== 'string' || typeof pattern !== 'string') return false;
  try {
    return new RegExp(pattern).test(s);
  } catch {
    return false;
  }
};

/**
 * Frozen allow-list registry. Built on a null-prototype base so author-
 * supplied call names like `__proto__` / `constructor` / `toString` can't
 * resolve to inherited Object.prototype methods on lookup. `Object.freeze`
 * prevents bracket-assignment mutation at runtime; the audit grep on the
 * registry name (see H.1.5 spec verification commands) enforces no late
 * mutation at source-review time. Both layers are intentional — runtime
 * + source-time defense.
 */
export const FUNCTIONS: Readonly<Record<string, FnHandler>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, FnHandler>, {
    len,
    contains,
    startsWith,
    endsWith,
    match,
  }),
);
