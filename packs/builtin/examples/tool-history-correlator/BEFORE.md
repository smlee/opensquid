# Tool History Correlator — prose-only version (BEFORE)

This file shows the rule as it would live **without** the H grammar's
bracket-index access — as English guidance inside SKILL.md `prose:`.
The next-door `skills/correlator/skill.yaml` is the **AFTER**: the
same logic compiled to a single-line `if:` clause that the evaluator
checks at every Stop event.

---

## The rule (prose form)

When the assistant ends a turn (Stop event):

- **IF** more than 5 Bash invocations were issued this turn, AND
- the most-recent entry in the session tool history is in fact a Bash
  call,

**THEN** warn the assistant to consolidate consecutive Bash calls into
one multi-line script (or a `&&`-chained one-liner) so the tool trace
stays scannable in the transcript.

## Why prose-only was insufficient

The rule needs to access a structured primitive result:

- Threshold comparison: `len(bash_history) > 5` (or `bash_history.count > 5`).
- Element-identity check: the first element in `bash_history.tools` must
  be the string `"Bash"`.

Pre-H, the `if:` grammar accepted bare names + a fixed set of equality
forms hard-coded in the evaluator's regex set. There was no path access
deeper than a single dot, no array-index access at all, and no `len()`
function. Any check that needed to read structured primitive output
either lived as prose or was hoisted into a custom TypeScript primitive
that did the comparison internally and returned a single boolean.

## What the H grammar unlocks

The AFTER form (`skills/correlator/skill.yaml`) collapses the rule into:

```yaml
if: 'bash_history.count > 5 && bash_history.tools[0] == "Bash"'
```

That clause exercises **two grammar features the pre-H regex set could
not express**:

1. **Numeric comparison on a dotted-path operand** (`bash_history.count > 5`)
   — pre-H, the numeric-compare regex required a bare identifier on
   the LHS. Dotted-path access on a comparison operand is new.
2. **Bracket-index access** (`bash_history.tools[0]`) — pre-H had no
   `[index]` syntax at all. Arrays could only be checked for emptiness
   via the `length` special-case on the `length` property name.

## Compression measure

| Form                                        | LOC of the gate | Enforcement                             |
| ------------------------------------------- | --------------- | --------------------------------------- |
| Prose (this)                                | ~5 lines        | None — guidance only                    |
| Custom primitive function in src/functions/ | ~20 lines TS    | Enforced, but requires runtime release  |
| Structured `if:` with bracket-index access  | 1 line          | Enforced, pack-author authors and ships |

## A note on the bracket-index check

The second clause (`bash_history.tools[0] == "Bash"`) is technically
redundant given the `filter_names: [Bash]` arg on the primitive call —
if any tools matched, they're guaranteed Bash. The clause is kept as a
**defensive check**: if a future task changes the primitive's filter
semantics (e.g. fuzzy match), the rule fails closed rather than
silently mis-firing. Pack authors regularly want this kind of
belt-and-suspenders shape check inside their `if:` clauses; the H
grammar makes it expressible.
