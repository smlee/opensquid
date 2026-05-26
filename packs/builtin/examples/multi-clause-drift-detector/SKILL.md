# multi-clause-drift-detector — AFTER (structured)

Three-file example demonstrating the prose → YAML migration pattern
enabled by the H grammar.

| File                      | Purpose                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `BEFORE.md`               | Prose-only equivalent, shown for direct comparison             |
| `SKILL.md` (this file)    | Reader's guide — what the example demonstrates                 |
| `manifest.yaml`           | Pack identity (`name` / `version` / `scope` / `goal`)          |
| `skills/drift/skill.yaml` | The structured rule itself — single `if:` clause does the work |

## What this example demonstrates

A single compound `if:` clause replacing what used to be a paragraph of
prose. Three primitive calls feed bindings into one verdict gate; the
gate evaluates `len(...)` + `&&` + numeric comparison + dotted path
access — every operator family the H grammar unlocked over the bounded
G.5 / G.13 regex grammar.

Reference clause:

```yaml
if: 'len(drift_hits.matched) > 0 && len(verifications.matched) == 0 && tool_history.count == 0'
```

## Grammar features exercised

- **`&&` (logical AND)** — two clauses joined; both must be true to fire
- **`len()` (allow-listed function)** — array length over a primitive
  result's `.matched` field
- **`>` and `==` (numeric comparison)** — strict equality + strict
  ordering, no JS-style coercion (see grammar guide §6 Gotchas)
- **Dotted path access** — `drift_hits.matched` resolves through the
  binding map without `Object.hasOwn` proto pollution risk (sandbox
  guarantee, grammar guide §4)

## Primitive return shapes used

The example's bindings assume the actual primitive shapes exported by
`src/functions/` as of 2026-05-25:

```typescript
// src/functions/text_pattern_match.ts
{ matched: string[]; phrases: { phrase: string; offset: number }[] }

// src/functions/session_tool_history.ts
{ tools: string[]; count: number }
```

If a future task changes either shape, this example must update in
lockstep with the primitive — the `# Example — not load-bearing`
header signals exactly that fragility expectation.

## How to run it

The example is **not** registered in any `active.json`. To exercise it
in a dev session:

```bash
# 1. Validate it loads under the H.2 refinement
node -e "import('./dist/packs/loader.js').then(m => m.loadPack('packs/builtin/examples/multi-clause-drift-detector')).then(p => console.log('OK', p.skills.length, 'skill(s)'))"

# 2. Run its fixtures via the test suite
pnpm vitest run test/example-skills.test.ts
```

## Fixtures

- `fixtures/drift_no_verify.input.json` — drift phrases present + no
  verification language + no verification tool calls → expected: **1
  warn verdict** (rule fires).
- `fixtures/drift_with_verify.input.json` — drift phrases present + at
  least one verification phrase OR tool call → expected: **0 verdicts**
  (rule short-circuits).

The test harness at `test/example-skills.test.ts` walks every
`*.input.json` + `*.expected.json` pair under each example's
`fixtures/` directory and feeds the `if:` clause through `evalCondition`
with the binding map encoded in the input fixture.

## Why this example is in the docs

It is the strongest single demonstration that the H grammar's structural
expressiveness lets MD-prose rules graduate to YAML enforcement.
`feedback_verify_code_before_memory` is a user-flagged drift class; the
prose-only version of this rule is exactly the kind of guidance that
gets forgotten under context pressure. The structured version cannot
be forgotten — the evaluator runs it whether the agent remembers it or
not.
