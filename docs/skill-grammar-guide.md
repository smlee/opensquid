# opensquid `if:` grammar — author's guide

Version: 0.5.149 · Last updated: 2026-05-26 · Spec: H.1.x + H.2 + H.3

This guide is the reference for pack authors writing `if:` clauses
inside `skills/<name>/skill.yaml`. It documents the full expression
grammar shipped in Track H — what operators are available, what
functions can be called, what guarantees the sandbox makes, and which
gotchas to design around. Worked examples ship under
`packs/builtin/examples/` and are cross-referenced throughout.

---

## 1. Why `if:` matters — the MD-to-YAML thesis

opensquid's competitive position is **structural enforcement** of
anti-drift rules. The whole point of a pack is that the rule fires
whether the agent remembers it or not. That promise only holds if the
condition can actually be expressed in the pack — otherwise the rule
collapses back into prose inside SKILL.md, where it lives as
suggestion rather than enforcement.

The H grammar exists to widen the band of rules that survive that
migration. Every operator and function added below corresponds to a
real-world drift class that used to live in prose.

### The motivating story: a silently-broken production rule

The built-in `workflow` skill ships this rule in
`packs/builtin/default-discipline/skills/workflow/skill.yaml`:

```yaml
- id: phase-logged-before-commit
  process:
    - call: match_command
      args:
        pattern: 'git\s+commit\b'
        target: tool_args.command
      as: committing
    - call: read_state
      if: committing
      args:
        key: workflow.phases_logged
      as: phases
    - call: verdict
      if: 'committing && phases != "complete"' # ← this clause
      args:
        level: block
        message: 'BLOCKED: 7-phase workflow incomplete...'
```

The `if: 'committing && phases != "complete"'` clause **did nothing**
for the entire G-track lifetime. The pre-H regex grammar accepted
single equality (`==`) forms only — there was no `!=` in the
allow-list. The evaluator silently warned `unsupported expression` and
returned `false`, which collapsed the verdict to "skip the step." Every
commit went through. The rule was load-bearing on paper and a no-op in
fact.

H.1.6's chevrotain swap exposes this exact failure mode: the same
clause is now valid grammar, parses cleanly at pack load, and starts
emitting block verdicts on the first incomplete-workflow commit. The
G-track CHANGELOG flagged this as a downstream behavior change — the
rule was "fixed" the moment H.1.6 shipped, without anyone editing the
pack yaml.

That is the MD-to-YAML thesis in one example: **the more expressive
`if:` becomes, the more skill logic moves out of MD prose (where the
agent can forget it) into YAML (where the evaluator enforces it).**
Track H widens the door from "single equality + bare names" to the
full operator + function set documented below.

### The three operator families H unlocks

| Family                                   | Pre-H status                                       | Post-H                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Logical (`&&`, `\|\|`, `!`)              | `&&` only (G.5); no `\|\|`/`!`                     | full                                                                                                                         |
| Comparison (`==` `!=` `<` `<=` `>` `>=`) | `==` only (G.5 added numeric `<=` `<` etc bounded) | full                                                                                                                         |
| Function calls + path/index access       | only the `length` special-case                     | `len()` + `contains()` + `match()` + `startsWith()` + `endsWith()` + arbitrary dotted paths + `[int]` and `["str"]` indexing |

The three worked examples under `packs/builtin/examples/` each
exercise one family. See §5 for the full mapping.

---

## 2. Grammar reference

### 2.1 Top-level grammar

The full grammar in informal EBNF:

```ebnf
expression  ::= orExpr
orExpr      ::= andExpr ('||' andExpr)*
andExpr     ::= notExpr ('&&' notExpr)*
notExpr     ::= '!'? compareExpr
compareExpr ::= primary (compareOp primary)?      # at most one compareOp
primary     ::= '(' expression ')' | literal | callOrPath
callOrPath  ::= identifier ( call | pathSegment* )
call        ::= '(' (expression (',' expression)*)? ')'
pathSegment ::= '.' identifier | '[' (number | string) ']'
literal     ::= stringLit | numberLit | 'true' | 'false' | 'null'
compareOp   ::= '==' | '!=' | '<' | '<=' | '>' | '>='
```

Notes:

- **No chained comparison.** `a < b < c` is a parse error. The
  `compareExpr` rule allows at most one comparison operator per
  sub-expression. Use `a < b && b < c` instead.
- **Left-associativity for `&&` and `||`.** `a && b && c` folds as
  `((a && b) && c)`.
- **`&&` binds tighter than `||`.** `a || b && c` parses as
  `a || (b && c)`. Use parens to flip: `(a || b) && c`.
- **`!` binds tighter than comparison.** `!hit == false` parses as
  `(!hit) == false`. Almost always you want `hit == false` or `!hit`
  alone; reach for `!` rarely.

### 2.2 Operators — precedence and associativity

| Precedence | Operators                   | Associativity |
| ---------- | --------------------------- | ------------- |
| 1 (loose)  | `\|\|`                      | left          |
| 2          | `&&`                        | left          |
| 3          | `!` (unary)                 | right         |
| 4          | `==` `!=` `<` `<=` `>` `>=` | none (single) |
| 5 (tight)  | function call, `.`, `[ ]`   | left          |

### 2.3 Path access and indexing

A bare identifier is a binding lookup. Following it with `.<name>` or
`[<int>]` or `["<string>"]` walks the value:

```yaml
if: 'user.profile.role == "admin"'             # dotted path
if: 'roles[0] == "owner"'                       # integer index
if: 'config["api.key"] != null'                 # string index (use for keys with dots)
if: 'matches.length > 0'                        # length special-case for arrays/strings
```

The path resolver is **proto-pollution safe** — every property access
runs `Object.hasOwn(target, name)` before reading. Accessing
`__proto__`, `constructor`, or `prototype` returns `undefined` rather
than reaching into the prototype chain. The one exception is the
`length` property on arrays and strings, which is special-cased
because it is a non-own getter (this preserves backward compatibility
with the G.5 `matches.length > 0` form).

### 2.4 Literals

| Form    | Example          | Notes                                    |
| ------- | ---------------- | ---------------------------------------- |
| String  | `"hello"`        | Double-quoted. `\"` and `\\` escapes ok. |
| Integer | `42`             | Parsed as JS number.                     |
| Float   | `3.14`           | Parsed as JS number.                     |
| Boolean | `true` / `false` | Word-boundary keyword.                   |
| Null    | `null`           | Word-boundary keyword.                   |

Note that the literal `null` and the JavaScript value `undefined` are
distinct here: `x == null` does NOT match `undefined`. If you want
"missing or null", write `x == null || x == undefined` (the binding
will resolve `undefined` to itself).

### 2.5 Worked clause examples

```yaml
# bare binding (truthy check)
if: hit

# negated binding
if: '!hit'

# string equality
if: 'classification == "BLOCK"'

# numeric comparison on a path
if: 'session.tool_count > 50'

# compound clause
if: 'committing && phases != "complete"'

# parens flipping precedence
if: '(automation || dry_run) && verdict_count == 0'

# function call
if: 'len(drift_hits.matched) > 0'

# regex check
if: 'match(tool_input.file_path, "node_modules|/dist/|/.git/")'

# bracket index on a binding's array result
if: 'tool_history.tools[0] == "Bash"'
```

Every clause above is verified parsing-clean by the meta-test at
`test/example-skills.test.ts` (see §5 for the testing setup).

---

## 3. Function reference

The H grammar ships **five** allow-listed functions. Adding more is a
deliberate process — see §8 for the expansion checklist.

| Function            | Signature                            | Returns                                | Fails to                                       |
| ------------------- | ------------------------------------ | -------------------------------------- | ---------------------------------------------- |
| `len(x)`            | `string \| array \| object → number` | length / item count / own-key count    | `0` for any other type                         |
| `contains(s, sub)`  | `string, string → boolean`           | true iff `s.includes(sub)`             | `false` for non-string args                    |
| `startsWith(s, p)`  | `string, string → boolean`           | true iff `s.startsWith(p)`             | `false` for non-string args                    |
| `endsWith(s, p)`    | `string, string → boolean`           | true iff `s.endsWith(p)`               | `false` for non-string args                    |
| `match(s, pattern)` | `string, string → boolean`           | true iff `new RegExp(pattern).test(s)` | `false` for non-string args or malformed regex |

### 3.1 Coercion table

The functions are deliberately **type-strict** — type mismatch returns
the falsy result (or `0` for `len`) instead of coercing. This matches
the §6 gotcha on strict equality: opensquid never silently coerces in
either comparisons or function calls. The reason is to fail closed —
"the clause evaluated false because the type was wrong" beats "the
clause evaluated true because we coerced silently and now the verdict
fired for the wrong reason."

| Arg type → fn        | `len`         | `contains`     | `match`        | `startsWith`   | `endsWith`     |
| -------------------- | ------------- | -------------- | -------------- | -------------- | -------------- |
| `string`             | length        | passes through | passes through | passes through | passes through |
| `array`              | length        | `false`        | `false`        | `false`        | `false`        |
| `object`             | own-key count | `false`        | `false`        | `false`        | `false`        |
| `number`             | `0`           | `false`        | `false`        | `false`        | `false`        |
| `boolean`            | `0`           | `false`        | `false`        | `false`        | `false`        |
| `null` / `undefined` | `0`           | `false`        | `false`        | `false`        | `false`        |

### 3.2 `match()` and the RE2 grammar subset

`match()` is backed by [`re2js`](https://github.com/le0pard/re2js), a
pure-JS port of Google's RE2 engine. RE2 matches in **linear time**
relative to input length — patterns like `(a+)+$` that crash V8's
RegExp engine via catastrophic backtracking complete in single-digit
milliseconds under RE2 regardless of input length. **opensquid's
`match()` is ReDoS-immune by construction** (shipped in 0.5.150, task
H.4).

The trade for linear-time matching is that RE2 rejects a handful of
PCRE features that fundamentally require backtracking. Patterns using
any of the following return `false` (the compile-time syntax error is
swallowed by `match()`'s try/catch):

- **Backreferences** — `\1`, `\2`, … (e.g. `(\w+)\s+\1`)
- **Lookaheads** — `(?=...)`, `(?!...)`
- **Lookbehinds** — `(?<=...)`, `(?<!...)`
- **Possessive quantifiers** — `a++`, `a*+`, `a?+`
- **Atomic groups** — `(?>...)`
- **Embedded conditionals** — `(?(cond)yes|no)`

Everything else works identically to V8 RegExp: character classes,
alternation, basic quantifiers (`*` `+` `?` `{n,m}`), capturing
groups, named captures, anchors (`^` `$` `\b`), and Unicode classes.
The [RE2 syntax reference](https://github.com/google/re2/wiki/Syntax)
is the authoritative grammar — opensquid follows it directly.

Author guidelines:

- **Prefer flat alternation** — `"a|b|c"` is the canonical safe shape.
- **Reach for primitives** instead of regex when expressing
  authorization, set membership, or structured field shape. `match()`
  is a string-pattern primitive, not a logic primitive.
- **If you genuinely need a PCRE-only feature**, the right move is
  almost always to move the check into a primitive (skill-side TS) and
  expose its result as a binding. Don't try to work around the RE2
  subset in the regex itself.

### 3.3 Bindings

Bindings come from two sources:

1. **Event payload fields** — the runtime auto-binds the event object's
   top-level fields by name (`tool_input`, `assistantText`, `tool_name`,
   etc.). The exact set depends on the event kind; see
   `src/runtime/types.ts`'s `Event` discriminated union for the
   authoritative list.
2. **`as:` aliases on prior process steps** — each step in a rule's
   `process:` array can capture its result into a named binding via
   `as: <name>`. Subsequent steps' `if:` clauses read those bindings.

Example:

```yaml
process:
  - call: text_pattern_match # primitive call
    args: { text_field: assistantText, patterns: [drift] }
    as: hits # binds the result as `hits`
  - call: verdict
    if: 'len(hits.matched) > 0' # reads the binding by name
    args: { level: warn, message: ... }
```

---

## 4. Sandbox guarantees

The interpreter at `src/runtime/evaluator/expression/interpreter.ts`
makes five guarantees, codified at the H.1.4 acceptance criteria:

| Guarantee           | Limit / mechanism                                                    |
| ------------------- | -------------------------------------------------------------------- |
| No code injection   | No `eval`, no `new Function`, no `Function.prototype.call`           |
| No prototype access | All property reads go through `Object.hasOwn` own-check              |
| Bounded recursion   | Depth cap **64**; deeper trees throw `InterpreterLimitError`         |
| Bounded total work  | Step cap **10 000**; longer traversals throw `InterpreterLimitError` |
| Strict equality     | `==` and `!=` use JS `===` / `!==`; no `String()` coercion           |

A pack-authored `if:` clause that hits any limit fails closed: the
clause evaluates to `false`, a `console.warn` surfaces the layer (lex
/ parse / AST / interpreter-limit / interpreter-runtime), and the
verdict step is skipped. There is no path by which an `if:` clause
can crash the evaluator or escape into the host process.

Pack-author practical implications:

- **Compound clauses are fine.** 10–20 operands joined by `&&` / `||`
  fits comfortably under the step cap.
- **Deeply nested paths are fine.** `a.b.c.d.e.f.g.h` is depth 8 in
  the AST; well under the 64 cap.
- **A pathological clause is your bug.** If the interpreter cap fires
  on a clause you wrote, the answer is to rewrite the clause, not to
  raise the cap.

---

## 5. Common patterns

Three worked examples ship under `packs/builtin/examples/`. Each
demonstrates a distinct operator family and follows the three-file
pattern documented in §9.

### 5.1 Multi-clause drift detection

Pattern: combine a positive signal (drift phrase seen) with two
negative signals (no verification phrase, no verification tool call)
in a single `if:` clause.

Reference: `packs/builtin/examples/multi-clause-drift-detector/`

```yaml
if: 'len(drift_hits.matched) > 0 && len(verifications.matched) == 0 && tool_history.count == 0'
```

Demonstrates: `&&`, `len()`, comparison on path access. Replaces the
prose-only rule that used to live in `feedback_verify_code_before_memory`.

### 5.2 File-path policy guard

Pattern: regex-check an event payload's file path against a list of
forbidden locations.

Reference: `packs/builtin/examples/file-pattern-guard/`

```yaml
if: 'match(tool_input.file_path, "node_modules|/dist/|/build/|/.git/|.lock$")'
```

Demonstrates: `match()`. Replaces the alternative of writing a
per-rule custom primitive in `src/functions/`.

### 5.3 Tool-history count threshold

Pattern: combine a count threshold with an identity check on the
first element of an array result.

Reference: `packs/builtin/examples/tool-history-correlator/`

```yaml
if: 'bash_history.count > 5 && bash_history.tools[0] == "Bash"'
```

Demonstrates: numeric `>` on path, bracket-index access, defensive
shape check. Replaces the alternative of hoisting the comparison into
a custom primitive's TypeScript body.

### 5.4 Other patterns worth knowing

These don't have a dedicated example skill but appear frequently:

- **Truthy check on a state read:**

  ```yaml
  if: claimed
  ```

  (Shipped throughout `packs/builtin/default-discipline/skills/honesty-ledger/`.)

- **Negated truthy:**

  ```yaml
  if: '!automation.value'
  ```

- **Empty-vs-nonempty without `len`:**

  ```yaml
  if: 'matches.length > 0'
  ```

  (Special-case on `length` for arrays + strings — see §2.3.)

- **Class-of-event filter:**

  ```yaml
  if: 'tool_name == "Bash" || tool_name == "Edit"'
  ```

- **Boolean coercion of object existence:**
  ```yaml
  if: 'session.feature_flag == true'
  ```
  (The strict-equality semantic means you really want `== true`, not
  just `session.feature_flag` — see the §6 gotcha on truthy bindings.)

---

## 6. Gotchas

### 6.1 Strict equality — no JS-style coercion

`1 == "1"` is **false**. `true == 1` is **false**. `null == undefined`
is **false**. The interpreter uses JS `===` / `!==` exclusively per
the H pre-research §12.3 lock.

The motivating reason is fail-closed semantics: if a future pack
author writes `count == "5"` (string literal on the RHS, numeric on
the LHS), the clause should evaluate `false` so the verdict skips,
not silently coerce and fire the wrong way.

**Author rule:** keep types consistent. `count` is a number, so
compare against a number literal. `classification` is a string, so
compare against a string literal. Mixed-type comparisons are
intentionally non-matching.

### 6.2 Empty `if:` is truthy

An `if:` field that is present but empty (or whitespace-only)
evaluates to `true`. This matches the runtime semantics for "no `if:`
field at all" so YAML trailing-whitespace doesn't accidentally skip
steps. The H pre-research §12.2 documents the lock.

```yaml
- call: verdict
  if: '' # ← evaluates true, verdict runs
  args: { ... }
```

If you genuinely want to skip a step, omit the step entirely or use
`if: false`.

### 6.3 `match()` uses RE2 — PCRE-only features reject

See §3.2 above for the full reference. Summary: `match()` is backed
by `re2js` (Google's RE2 engine, ported to pure JS) and is
**ReDoS-immune by construction** — linear-time matching, no
catastrophic backtracking. The trade is that RE2 rejects these PCRE
features at compile time, which `match()` surfaces as `false`:

- Backreferences (`\1`)
- Lookaheads / lookbehinds (`(?=...)`, `(?<=...)`)
- Possessive quantifiers (`a++`, `a*+`)
- Atomic groups (`(?>...)`)

If your existing pattern uses one of these, move the check into a
primitive (skill-side TS) and bind its result with `as:` — don't
fight the RE2 grammar inside the `if:` clause.

### 6.4 No chained comparison

`a < b < c` is a parse error. The grammar's `compareExpr` rule
deliberately allows at most one comparison operator per
sub-expression — chained comparison ambiguity is a footgun in every
language that allows it. Write `a < b && b < c` instead.

### 6.5 `length` is the one non-own property the resolver follows

Arrays and strings expose `length` as a non-own getter. The path
resolver special-cases this one name so the G.5-era `matches.length > 0`
form keeps working. **No other** non-own property is reachable —
`__proto__`, `constructor`, `prototype`, and inherited methods all
return `undefined`.

If you need the count of items in an object's own keys, use `len()`
on the object, not `.length` (objects do not have a `length` property).

### 6.6 Bracket-index returns `undefined` past the end

`arr[10]` on a 3-element array returns `undefined`. The expression
does not throw. Subsequent path access on `undefined` also returns
`undefined`. This means a defensive shape check like
`arr[0] == "expected"` will correctly evaluate `false` on an empty
array — not throw, not match, just `false`.

### 6.7 `as:` aliases shadow event payload fields

If a process step captures `as: tool_input` and the event payload also
has a `tool_input` field, the `as:` alias wins for subsequent steps in
the same rule. Avoid name collisions by prefixing custom aliases with
something other than `tool_` / `prompt_` / `event_`.

---

## 7. Future grammar features

These are out of scope for the H track but candidates for follow-ups:

| Feature                        | Track                                  | Notes                                                                       |
| ------------------------------ | -------------------------------------- | --------------------------------------------------------------------------- |
| Arithmetic (`+` `-` `*` `/`)   | H.5+ (only if a real use case appears) | Pack authors should prefer doing math in a primitive, not in `if:` clauses. |
| Ternary (`a ? b : c`)          | H.5+                                   | Currently use `(cond && a) \|\| b`. Ternary is sugar.                       |
| `in` operator                  | H.5+                                   | `"x" in obj` — currently use `obj.x != null`.                               |
| Template literals (`{{name}}`) | Separate Phase-2 templating task       | NOT a grammar extension — would live in a `template:` field, not `if:`.     |

The H track is the home of expression-grammar evolution. Additional
operators ship as `H.5`, `H.6`, etc. in this same track, not as new
tracks.

---

## 8. Function allow-list expansion checklist

Adding a sixth function to `src/runtime/evaluator/expression/functions.ts`
is a deliberate process. Run this 5-point checklist before adding:

1. **Cite the production skill that needs the function.** "Maybe useful
   someday" is not a reason. A real pack-author has tried to write the
   clause and been unable to.
2. **Confirm the function is pure.** No I/O, no time, no randomness.
   The same arguments must always produce the same result; otherwise
   the LRU parse cache and the wider memoization layer break.
3. **Document the new attack surface.** Regex functions bring ReDoS.
   String functions bring length-cap considerations. Object-returning
   functions bring proto-pollution considerations. Spell out the
   relevant defenses in the function's JSDoc.
4. **Author the coercion table** in JSDoc — what does each input type
   produce? Match the existing five functions' type-strict, fail-closed
   posture (return the falsy value, not a coerced approximation).
5. **Ship at least 3 tests** — happy path, type-mismatch, edge case
   (empty / null / boundary).

The allow-list is `Object.freeze`'d at module load. Adding a function
is an explicit, reviewable code change — never a runtime registration.

---

## 9. Authoring examples convention

Every worked example under `packs/builtin/examples/` follows the
**three-file pattern** introduced with this guide (verified novel via
the H.3 pre-research §8.2: zero matches in the pre-H repo for either
`BEFORE.md` or `SKILL.md`). The convention:

| File                       | Content                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BEFORE.md`                | Prose-only version of the rule, the way it would live in SKILL.md without H. Includes the "Why prose-only was insufficient" section and a compression-measure table. |
| `SKILL.md`                 | Reader's guide. What the example demonstrates, which grammar features it exercises, primitive return shapes used, how to run it, fixture index.                      |
| `manifest.yaml`            | Pack manifest (`name` / `version` / `scope` / `goal`). MUST start with `# Example — not load-bearing` header comment to prevent calcification (see callout below).   |
| `skills/<name>/skill.yaml` | The actual rule with the `if:` clause that does the work.                                                                                                            |
| `fixtures/`                | At least two `*.input.json` + matching `*.expected.json` pairs: one that fires the verdict and one that does not.                                                    |

### `# Example — not load-bearing` callout

Every example manifest MUST begin with the comment:

```yaml
# Example — not load-bearing. ...
```

The reason: examples are _teaching artifacts_, not production rules.
If a pack-author copies an example into their own scope's `active.json`
and the example breaks under a future grammar change, the breakage is
on the user, not on opensquid. The header makes that contract explicit
in the file itself — anyone reading the manifest sees immediately that
this code exists to demonstrate, not to ship.

The H.3 audit phase greps for this header in every example manifest;
absence fails the audit.

### Testing examples

A single test file at `test/example-skills.test.ts` walks every
example under `packs/builtin/examples/`:

1. Calls `loadPack()` on each example directory and asserts no errors
   (validates that every `if:` clause in the example's `skill.yaml`
   parses cleanly under the H.2 Zod refinement).
2. For each `fixtures/*.input.json` + matching `*.expected.json` pair,
   reads the `if:` clause + `bindings` map from the input file, calls
   `evalCondition`, and asserts the boolean result matches the
   expected verdict.

A second meta-test in the same file extracts every fenced ```yaml`
code block from `docs/skill-grammar-guide.md` and feeds every `if:`
line through `parseExpression()`. This guarantees the guide stays in
sync with the grammar — if a sample becomes invalid (e.g. a future
operator change), the test catches it before the change ships.

---

## 10. Reference: production skills that already use the grammar

The following production skills exercise specific operator families,
which makes them useful real-world reading alongside the worked
examples:

| Skill                                                               | Feature exercised                                                                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packs/builtin/default-discipline/skills/d9-guard/skill.yaml`       | `automation.value == true` (BOOL_CMP) + `automation.value == true && classification == "BLOCK"` (compound `&&` over BOOL_CMP — impossible under the pre-H regex grammar) |
| `packs/builtin/default-discipline/skills/workflow/skill.yaml`       | `committing && phases != "complete"` — the §1 motivating story, latent rule fixed by H.1.6                                                                               |
| `packs/builtin/cycle-pack/skills/lesson-capture/skill.yaml`         | `candidates == "NONE"` — simplest non-bare form, good intro to `==`                                                                                                      |
| `packs/builtin/default-discipline/skills/honesty-ledger/skill.yaml` | 14× `if: claimed` — bare-binding (truthy) pattern, useful shared-binding anchor                                                                                          |

---

## Appendix A — Comparison to peer policy languages

opensquid's `if:` grammar is intentionally smaller than the major
peer policy languages. Pack authors familiar with one of these will
find the H grammar a strict subset:

| Language              | Allows arithmetic | Allows chained comparison | Allows custom funcs  | opensquid analog        |
| --------------------- | ----------------- | ------------------------- | -------------------- | ----------------------- |
| Cerbos CEL conditions | yes               | no                        | from a sealed set    | this guide              |
| GitHub Actions `if:`  | no                | no                        | from a sealed set    | this guide              |
| OPA Rego              | yes               | yes                       | yes (Rego is a lang) | broader than this guide |

We are deliberately closer to Cerbos / GHA than to Rego: the grammar
is small enough to memorize, audit-grep, and reason about
sandbox-safely. The 5-function allow-list and the absent arithmetic
both push pack authors toward putting heavy logic in primitives (where
it has type checking, tests, and a deliberate review process) and
keeping the `if:` clause as the orchestration glue.

---

## Appendix B — Where to file feedback

- Grammar bugs or interpreter crashes: open an issue at
  https://github.com/smlee/opensquid/issues with a minimum-repro
  `if:` clause + bindings.
- Function allow-list expansion requests: same issue tracker; please
  cite the production skill that needs the function (per §8 step 1).
- Documentation gaps in this guide: PRs welcome — `docs/skill-grammar-guide.md`.
