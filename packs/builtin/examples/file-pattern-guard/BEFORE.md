# File Pattern Guard — prose-only version (BEFORE)

This file shows the rule as it would live **without** the H grammar's
`match()` function — as English guidance inside SKILL.md `prose:`. The
next-door `skills/guard/skill.yaml` is the **AFTER**: the same logic
compiled to a single-line `if:` clause that the evaluator checks before
every Edit tool call.

---

## The rule (prose form)

When the assistant is about to edit a file:

- **IF** the target file path matches any of:
  - `node_modules` — vendored dependency tree
  - `/dist/` or `/build/` — generated build output
  - `/.git/` — version-control internals
  - `.lock$` — package manager lockfiles (regenerate, never hand-edit)

**THEN** block the edit and instruct the assistant to use the
appropriate generator tool instead.

## Why prose-only was insufficient

The rule is a single regex check against one event-payload field
(`tool_input.file_path`). Under the pre-H grammar, `if:` accepted
bare names and a fixed set of equality / numeric-comparison forms
hard-coded in the evaluator's regex set. There was no `match()`
primitive — regex tests could not be expressed at all in `if:` clauses.

The workaround was either:

1. Move the regex check into a custom primitive function in
   `src/functions/` (engine code change, requires a release).
2. Document the rule in prose and hope the agent remembers.

Option 1 turns every per-skill regex check into a runtime PR. Option 2
relies on the agent's discipline — the exact failure mode opensquid
exists to fix.

## What the H grammar unlocks

The AFTER form (`skills/guard/skill.yaml`) collapses the rule into:

```yaml
if: 'match(tool_input.file_path, "node_modules|/dist/|/build/|/.git/|.lock$")'
```

That clause is parsed at pack load time (Zod refinement via H.2) and
evaluated at every PreToolUse event. New regex categories are now a
pack-author edit — no runtime release needed.

## Compression measure

| Form                                        | LOC of the gate | Enforcement                             |
| ------------------------------------------- | --------------- | --------------------------------------- |
| Prose (this)                                | ~6 lines        | None — guidance only                    |
| Custom primitive function in src/functions/ | ~30 lines TS    | Enforced, but requires runtime release  |
| Structured `if:` with `match()`             | 1 line          | Enforced, pack-author authors and ships |

## Note on regex safety (H.4 follow-up)

The `match()` function currently uses V8's `new RegExp(p).test(s)`. The
pattern in the AFTER form is a simple alternation — no nested
quantifiers, no backreferences, no lookarounds — so it runs in linear
time on any input. The H.4 task will swap the implementation to RE2
(linear-time by construction) to harden against pack-author authoring
mistakes that would otherwise produce ReDoS exposure. See
`docs/skill-grammar-guide.md` §6 Gotchas for the full discussion.
