# file-pattern-guard — AFTER (structured)

Three-file example demonstrating the regex-check migration pattern
enabled by the H grammar's allow-listed `match()` function.

| File                      | Purpose                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `BEFORE.md`               | Prose-only equivalent + per-skill custom primitive alternative |
| `SKILL.md` (this file)    | Reader's guide — what the example demonstrates                 |
| `manifest.yaml`           | Pack identity (`name` / `version` / `scope` / `goal`)          |
| `skills/guard/skill.yaml` | The structured rule itself — single `if:` clause does the work |

## What this example demonstrates

A regex path-pattern check expressed in one line of YAML, executable at
every PreToolUse event without a runtime release. Replaces both
prose-only guidance and the alternative of writing a per-rule custom
primitive function.

Reference clause:

```yaml
if: 'match(tool_input.file_path, "node_modules|/dist/|/build/|/.git/|.lock$")'
```

## Grammar features exercised

- **`match()` (allow-listed function)** — regex test on a string field,
  pack-authored pattern. Returns `false` for non-string operands and
  for malformed regex patterns (fail-closed, see grammar guide §3).
- **Dotted path access on event payload** — `tool_input.file_path`
  resolves through the binding map. The `tool_input` binding is the
  raw `tool_input` field from the PreToolUse event payload (see
  src/runtime/hooks/pre-tool-use.ts for the wiring).

## Primitive return shapes used

This example does not consume any primitive's return shape — `match()`
operates directly on `tool_input.file_path`, which the runtime binds
from the PreToolUse event payload before any process step runs.

## ReDoS posture (H.4 follow-up)

`match()` currently wraps `new RegExp(p).test(s)`. The pattern in this
example is a flat alternation (`a|b|c|...`) with no nested quantifiers,
backreferences, or lookarounds — V8 handles it in linear time on any
input. The H.4 task will swap the implementation to RE2 to harden
against future pack-author authoring mistakes. See
`docs/skill-grammar-guide.md` §6 Gotchas for the full discussion.

## How to run it

The example is **not** registered in any `active.json`. To exercise it
in a dev session:

```bash
# 1. Validate it loads under the H.2 refinement
node -e "import('./dist/packs/loader.js').then(m => m.loadPack('packs/builtin/examples/file-pattern-guard')).then(p => console.log('OK', p.skills.length, 'skill(s)'))"

# 2. Run its fixtures via the test suite
pnpm vitest run test/example-skills.test.ts
```

## Fixtures

- `fixtures/edit_node_modules.input.json` — Edit on
  `node_modules/lodash/index.js` → expected: **1 block verdict** (rule
  fires; the path matches `node_modules`).
- `fixtures/edit_src.input.json` — Edit on `src/index.ts` → expected:
  **0 verdicts** (rule short-circuits; the path matches none of the
  alternation arms).

## Why this example is in the docs

It is the canonical demonstration that the `match()` function moves
regex policy out of TypeScript (per-rule custom primitives) and into
YAML (pack-author edits). Any future "block edits to X" or "warn on
shell commands matching Y" rule can now be a one-line `if:` clause
authored by the user without touching the runtime.
