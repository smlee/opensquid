# Multi-Clause Drift Detector — prose-only version (BEFORE)

This file shows the rule as it would live **without** the H grammar — as
free-form English inside a SKILL.md `prose:` block, with no structural
enforcement. The next-door `skills/drift/skill.yaml` is the **AFTER**:
the same logic compiled to a single `if:` clause that the evaluator
checks at every Stop event.

---

## The rule (prose form)

When the assistant ends a turn (Stop event):

- **IF** the assistant's last message contains any of the drift phrases
  (`per memory`, `deferred`, `i remember`), AND
- the message does **NOT** contain any verification phrases (`i checked`,
  `i ran`, `i confirmed`), AND
- **no** verification tools (`Bash`, `Read`, `Grep`,
  `mcp__opensquid__recall`, `mcp__opensquid__inspect_skill`) were
  invoked this turn,

**THEN** the assistant is most likely citing remembered state without
verifying it against ground truth (the failure mode flagged in the
`feedback_verify_code_before_memory` memory).

## Why prose-only was insufficient

Three compound conditions joined by `AND` over **two different data
sources** (assistant text + session tool history). Pre-H, the `if:`
grammar in opensquid was a thin regex set: bare names, single
equality checks, basic numeric comparisons. There was no way to express
"contains X AND no Y AND no tool calls" structurally — the rule could
only live as guidance for the agent to follow voluntarily, and the agent
would forget mid-task. That is the exact drift class
`feedback_verify_code_before_memory` was filed against.

## What the H grammar unlocks

The AFTER form (in `skills/drift/skill.yaml`) collapses the three
clauses into a single expression:

```yaml
if: 'len(drift_hits.matched) > 0 && len(verifications.matched) == 0 && tool_history.count == 0'
```

That clause is parsed at pack load time (Zod refinement via H.2) and
evaluated at every Stop event. The agent cannot forget the rule — the
evaluator runs it whether the agent remembers or not.

## Compression measure

| Form         | LOC of the gate | Enforcement                   |
| ------------ | --------------- | ----------------------------- |
| Prose (this) | ~12 lines       | None — guidance only          |
| Structured   | 1 line          | Evaluator-gated at every Stop |

The pedagogical point: the lift from "explained in English" to
"structurally enforced" is the H grammar's whole purpose. The more
expressive `if:` becomes, the more skill logic that used to be
aspirational prose can move into YAML where it is mechanically checked
on every event.
