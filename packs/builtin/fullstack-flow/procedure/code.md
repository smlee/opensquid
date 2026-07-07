# CODE — implement the task through the 7-phase cycle (two research layers)

You are in the CODE stage. Drive the active task to a shipped, gated unit. CODE has TWO research layers.

## Research BEFORE coding (pre_research / learn)

- FAN OUT parallel subagents with the appropriate skills: a task-verifier (re-confirm the spec vs current
  `file:line`/live API), an external-docs reader per library/version touched (primary docs), a local-expander
  (affected files + reusable defs + non-deprecated syntax). They burn their context; you keep the synthesis.
- VERIFY the task against current reality (`file:line` / the live API) — a task claim the code contradicts is
  surfaced, not coded around.
- EXPAND to concrete implementation detail (affected files, existing defs to reuse, current non-deprecated
  syntax) and ALIGN to the scoped element (no silent widening).
- READ THE DOCS: for any external API/library/version the task touches, consult the official primary docs
  (record the WebSearch/WebFetch). (Existing-solution discovery was done at AUTHOR — not here.)

## Do — the 7-phase cycle, and LOG every phase

Run pre_research → learn → code → test → audit → post_research → fix. **Log ALL 7 via `log_phase`** as you
complete them — this is the agent-controllable completion signal the gate reads. Run the readiness surfacers.

- **`test` runs the project's DECLARED verifySuite, VERBATIM.** Read `.opensquid/active.json` `verifySuite`
  (for opensquid: `bash scripts/pre-push.sh` — `pnpm lint` → `typecheck` → `build` → the FULL test suite →
  `format:check`) and run EXACTLY that command, repo-wide, requiring EXIT 0. This is the SAME command DEPLOY
  runs (`procedure/deploy.md` §1) — CODE must not self-select a subset. Do NOT log the `test` phase (4/7)
  complete on a partial / single-file / slice run: a slice that passes while the full suite is red is a
  FALSE GREEN (the exact regression this closes — a 116-test slice hid 4 real reds). `code_ready` now gates on
  the recorded full-suite result (`code.suite_green`), so a slice run cannot advance CODE.

## Research AFTER coding (audit) — another layer

- FAN OUT adversarial audit subagents with the appropriate skills, one per lens, each trying to REFUTE that
  the code is done: alignment, proper doc-use, existing-solution double-check, full-fix, re-audit-the-spec.
  Synthesize the survivors; a finding that survives refutation is a real gap to fix.
- ALIGNMENT: the written code matches the goal/scoped element. PROPER DOC USE: APIs used per their primary
  docs (no deprecated/misused calls). EXISTING-SOLUTION DOUBLE-CHECK: nothing reinvented. FULL-FIX, not a
  band-aid. RE-AUDIT the AUTHOR spec (still guess-free at code time?).

## Own the fix loop when DEPLOY is not triggered

DEPLOY's capability check is SKIPPED when no deploy env is wired — so in most flows DEPLOY does not actively
verify. When DEPLOY won't run, CODE is the LAST real gate: your `test` + `audit` phases MUST catch any bug and
the `fix` phase MUST resolve it (re-test until clean) before you advance. Do NOT advance on red — there is no
later stage to catch it. This is CODE starting the same fix loop DEPLOY would otherwise delegate (author→code).

## Gate to advance (code → deploy): `code_ready`

Passes when `code.phases_complete` (all 7 phases logged for the active task) ∧ `code.readiness_ran` ∧
`code.deprecated_clean` (readiness found NO deprecated call) ∧ `code.suite_green` (the FULL declared verifySuite
was run and recorded green — not a slice). Log all 7, run readiness clean, AND run the whole verifySuite green
(EXIT 0), and it advances.
