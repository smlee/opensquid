/**
 * Function allow-list registry — Task H.1.5 + H.4 (ReDoS-hardened `match()`).
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
 *        - Regex-accepting → use RE2 (ReDoS-immune by construction; follow
 *          `match()` precedent).
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
 *   | match        | string × string → bool (RE2 grammar)   | returns false |
 *
 * Handlers do NOT throw on type-mismatch — they return `false`/`0` (matches
 * the relational-op convention from `interpreter.ts:applyCompare`). Only
 * the interpreter's unknown-function path throws `InterpreterRuntimeError`.
 * Wrong arity is acceptable failure mode: missing args arrive as
 * `undefined` and the type guards coerce to the default.
 */

import { RE2JS } from 're2js';
import {
  toolValueContains,
  toolValueEndsWith,
  toolValueMatchesPattern,
  toolValueStartsWith,
  toolValueString,
} from '../../../integrations/pi/tool_aliases.js';

/** Handler signature: positional args are passed evaluated and unmodified. */
export type FnHandler = (...args: unknown[]) => unknown;

/** `len(x)` — string char count, array length, object key count, else `0`. */
const len: FnHandler = (x) => {
  const toolString = toolValueString(x);
  if (toolString !== null) return toolString.length;
  if (typeof x === 'string') return x.length;
  if (Array.isArray(x)) return x.length;
  if (x !== null && typeof x === 'object') return Object.keys(x).length;
  return 0;
};

/** `contains(s, sub)` — substring test; false unless both args are strings. */
const contains: FnHandler = (s, sub) => {
  if (typeof sub !== 'string') return false;
  const toolContains = toolValueContains(s, sub);
  if (toolContains !== null) return toolContains;
  const text = toolValueString(s);
  return typeof text === 'string' && text.includes(sub);
};

/** `startsWith(s, p)` — prefix test; false unless both args are strings. */
const startsWith: FnHandler = (s, p) => {
  if (typeof p !== 'string') return false;
  const toolStartsWith = toolValueStartsWith(s, p);
  if (toolStartsWith !== null) return toolStartsWith;
  const text = toolValueString(s);
  return typeof text === 'string' && text.startsWith(p);
};

/** `endsWith(s, p)` — suffix test; false unless both args are strings. */
const endsWith: FnHandler = (s, p) => {
  if (typeof p !== 'string') return false;
  const toolEndsWith = toolValueEndsWith(s, p);
  if (toolEndsWith !== null) return toolEndsWith;
  const text = toolValueString(s);
  return typeof text === 'string' && text.endsWith(p);
};

/**
 * `match(s, pattern)` — RE2 test; false on type-mismatch or invalid pattern.
 *
 * ReDoS-immune by construction (H.4, pre-research §12.1 rollback). Backed
 * by `re2js` — a pure-JS port of Google's RE2 engine — which matches in
 * linear time relative to input length. A pattern like `(a+)+$` against
 * `"aaa…b"` no longer hangs the event loop; it returns `false` in <10ms
 * regardless of input length.
 *
 * **PCRE features RE2 rejects** (`RE2JS.compile()` throws
 * `RE2JSSyntaxException`, which the catch below converts to `false`):
 *
 *   - **Backreferences** — `\1`, `\2`, …  (e.g. `(\w+)\s+\1`)
 *   - **Lookaheads** — `(?=...)`, `(?!...)`
 *   - **Lookbehinds** — `(?<=...)`, `(?<!...)`
 *   - **Possessive quantifiers** — `a++`, `a*+`, `a?+`
 *   - **Atomic groups** — `(?>...)`
 *   - **Embedded conditionals** — `(?(cond)yes|no)`
 *
 * These features all rely on backtracking, which is precisely the
 * mechanism RE2 trades away to guarantee linear-time matching. Pack
 * authors using `match()` must stay inside the RE2 subset; everything
 * else (character classes, alternation, basic quantifiers `*` `+` `?`
 * `{n,m}`, capturing groups `(...)`, named captures `(?P<name>...)`,
 * anchors `^` `$` `\b`, Unicode classes) works identically to V8 RegExp.
 *
 * **Cost.** `re2js` adds ~868KB to `node_modules` (no native build,
 * no WASM cold-start — pure JS); first-call compile of any new pattern
 * is the warm-up. Skill packs typically reuse a small set of patterns,
 * so amortized per-call cost is dominated by the linear-time DFA match
 * after the first compile.
 *
 * **Breaking-change classification.** Semantically breaking: any pack
 * authoring an `if:` clause that uses a PCRE-only feature now returns
 * `false` instead of evaluating the regex. opensquid still bumps PATCH
 * (0.5.149 → 0.5.150) per the pre-1.0 + agent-only-PATCH SemVer rules
 * locked in pre-research. None of the shipped `packs/builtin/` clauses
 * use rejected features (verified by H.3 implementer + post-research
 * §6 sweep against the RE2 syntax reference).
 *
 * **Comparable projects.** Cerbos uses Go's stdlib `regexp` (RE2-derived,
 * safe for free from the language). Cloudflare Workers ships `re2-wasm`
 * (also RE2 in a different transport) on their third-party-code surface.
 * Both made the same trade for the same threat-model reason.
 */
const match: FnHandler = (s, pattern) => {
  const text = toolValueString(s);
  if (typeof text !== 'string' || typeof pattern !== 'string') return false;
  try {
    const compiled = RE2JS.compile(pattern);
    const toolMatch = toolValueMatchesPattern(s, compiled);
    if (toolMatch !== null) return toolMatch;
    return compiled.test(text);
  } catch (err) {
    // RE2JSSyntaxException covers PCRE-rejected features + malformed
    // patterns (e.g. `(`, `[`, trailing `\`). Catching the base class
    // keeps behavior consistent with the legacy V8-RegExp try/catch:
    // any compile-time failure → false. We DO swallow other exceptions
    // defensively, but the only documented thrown type is the syntax one.
    void err;
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
