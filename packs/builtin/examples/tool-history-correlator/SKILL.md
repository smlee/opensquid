# tool-history-correlator — AFTER (structured)

Three-file example demonstrating the structured-primitive-result access
pattern enabled by the H grammar's path + bracket-index syntax.

| File                           | Purpose                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| `BEFORE.md`                    | Prose-only equivalent + custom-primitive alternative           |
| `SKILL.md` (this file)         | Reader's guide — what the example demonstrates                 |
| `manifest.yaml`                | Pack identity (`name` / `version` / `scope` / `goal`)          |
| `skills/correlator/skill.yaml` | The structured rule itself — single `if:` clause does the work |

## What this example demonstrates

Accessing a primitive's structured return shape — both a scalar field
(`.count`) and an array element (`.tools[0]`) — inside one `if:`
clause. Two operator families the pre-H grammar could not express
combine into a single readable condition.

Reference clause:

```yaml
if: 'bash_history.count > 5 && bash_history.tools[0] == "Bash"'
```

## Grammar features exercised

- **Dotted-path access on a comparison operand** — `bash_history.count`
  feeds the LHS of a numeric comparison. Pre-H, numeric compare
  required a bare identifier on the LHS.
- **Bracket-index access (`[0]`)** — array element by integer index.
  Pre-H, no `[...]` syntax existed.
- **`&&` (logical AND)** — combine two clauses.
- **`==` (strict equality)** — string-to-string identity check on
  `bash_history.tools[0]`. Strict semantics per grammar guide §6
  Gotchas; no JS-style coercion.

## Primitive return shape used

```typescript
// src/functions/session_tool_history.ts (verified 2026-05-25)
{ tools: string[]; count: number }
```

The example accesses both fields. If a future task changes either
field name or type, the example must update in lockstep (and so must
any production pack using the same primitive — the `# Example — not
load-bearing` header is a self-warning).

### Spec-vs-reality adjustment

The original H.3 spec assumed the primitive returned `.calls[]` with
each call carrying a `.name` field. The actual primitive returns a
flat `tools: string[]` array of names. This example uses the real
shape — `.tools[0]` is a string, not an object — per the H.3
implementation note that spec example shapes must yield to primitive
reality, not the other way around.

## How to run it

The example is **not** registered in any `active.json`. To exercise it
in a dev session:

```bash
# 1. Validate it loads under the H.2 refinement
node -e "import('./dist/packs/loader.js').then(m => m.loadPack('packs/builtin/examples/tool-history-correlator')).then(p => console.log('OK', p.skills.length, 'skill(s)'))"

# 2. Run its fixtures via the test suite
pnpm vitest run test/example-skills.test.ts
```

## Fixtures

- `fixtures/many_bash.input.json` — 6 Bash calls in current turn →
  expected: **1 warn verdict** (both clauses true).
- `fixtures/few_bash.input.json` — 2 Bash calls in current turn →
  expected: **0 verdicts** (count clause short-circuits the `&&`).

## Why this example is in the docs

It demonstrates the third operator family unlocked by the H grammar
(indexing on primitive results) and shows the defensive-shape-check
pattern pack authors regularly want to express — "the primitive
returned what I asked for, AND the count exceeds my threshold." Both
clauses in one line, evaluator-gated at every Stop event.
