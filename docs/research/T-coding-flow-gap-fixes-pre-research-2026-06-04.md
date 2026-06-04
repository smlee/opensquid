# Pre-research — T-CODING-FLOW-GAP-FIXES (2026-06-04)

A 4-agent adversarial audit of the live `coding-flow` pack surfaced 9 gaps; dogfooding
this very fix exposed a 10th (the flow does not re-arm for a new track in a live
session). Each is VERIFIED against source (file:line — no guesses). Scope forks (§2)
were answered by the user during scoping; **no open questions remain**. The fix design
(§3) chooses the simplest correct solution per `docs/lexicon.md` (Simplicity,
no-implicit-state) — and for the EXECUTE boundary it REPLACES a leaky matcher with
enforcement at a boundary the system owns (git), which is total by construction.

## 0. Method + automation boundary

Audit = 4 parallel agents (FSM wiring [0 gaps], primitive/state wiring, gate-bypass
coverage, setup/load integrity); every accepted finding re-verified by direct read of
the cited lines. SCOPE is the interactive phase: the design forks in §2 were the residual
decisions and the user answered them. AUTHOR + EXECUTE are automated from here.

## 1. The core design insight (why the EXECUTE matcher is the wrong primitive)

The old `scope-before-code` / `execute-gate` gates ask _"does this tool call LOOK like a
code-write / a commit?"_ by pattern-matching tool args. The input space — every way to
write a file (`Write`, `Edit`, `echo >`, `tee`, `sed -i`, `git apply`, an IDE, a script)
and every way to spell a commit (`cd && git commit`, `FOO=bar git commit`, `git
--no-pager commit`, an alias) — is UNBOUNDED. A matcher over an unbounded input is a
denylist that can never be proven complete; "tightening" it is whack-a-mole, not a proof.
That violates Simplicity/no-implicit-state (the predicate is an open-ended heuristic, not
a total function).

**Invert: enforce on EFFECTS at a boundary git OWNS.** git invokes `pre-commit` /
`pre-push` on EVERY commit/push, unconditionally, handing the hook the REAL staged/pushed
diff (`git diff --cached --name-only`; `git diff --name-only <range>`). opensquid installs
a managed `pre-commit` + `pre-push` hook into gated repos; it reads the real changed files
(ground truth — no path-guessing) plus the same FSM/phase/spec state, and blocks there.
Total by construction: it does not matter HOW the code was written. This collapses three
findings (F2 regex, F3 Bash-writes, F4 path-classification) into one correct mechanism —
DELETING the regex and the path list rather than growing them. The only honest escape,
`git commit --no-verify`/`-n`, is a single CLOSED opt-out token that a narrow PreToolUse
detector covers soundly. `opensquid doctor` verifies the git hooks like it verifies the 6
Claude Code hooks.

**Session bridge (feasibility CONFIRMED):** a git hook runs outside the CC session, but
`resolveMcpSessionId()` (`src/runtime/hooks/session_id.ts:163-183`) already resolves the
live session out-of-band: `CLAUDE_PROJECT_DIR` → `resolveProjectUuid` → project-scoped
`.current-session` pointer, falling back to the global pointer. The git hook resolves the
session the same way, then reads `fsm-coding-flow`, `workflow.phases_logged`, and
`active-task.json` under `sessions/<id>/state/`.

## 2. Findings (verified evidence)

**Clean / no change:** FSM integrity (every `advance_fsm` event resolves to a real
transition incl. the `loopback_gate` flow; all states reachable+exitable;
`task_unscoped` wildcard cannot be starved — `src/runtime/fsm.ts:104-112`); schema /
discovery / trigger registration valid; content audits fail CLOSED on subagent timeout
(`src/functions/llm.ts:115-118` → `err` aborts the rule before the downstream advance).

- **F1 [HIGH] — SCOPE→AUTHOR handoff is dead.** `packs/builtin/task-spec-author/
manifest.yaml` has NO `usage:` field → defaults to `active` → `handoff-research-to-spec`
  (`entry-and-handoffs/skill.yaml:88-90`, `profession: task-spec-author`) is rejected
  `wrong-usage` by `profession_resolver.ts:59-63` and dropped (`dispatch.ts:444-450`).
  `scope-architect/manifest.yaml:30` correctly has `usage: both`. Masked by isolation tests
  (`packs=1`).
- **F2 [HIGH] — commit gate regex-evadable.** `execute-gate/skill.yaml:20`
  `^git\s+(?:-[cC]\s+\S+\s+)*commit\b` is `^git`-anchored against the whole command;
  `cd r && git commit`, `FOO=bar git commit`, `git --no-pager commit` bypass. → REPLACED by
  the pre-commit hook.
- **F3 [HIGH] — scope-before-code ignores Bash writes.** `scope-lifecycle/skill.yaml:177,
180` gate only `Write`/`Edit`; `echo > src/x.ts`, `tee`, `sed -i`, `git apply` are
  ungated. → caught at the commit boundary (staged diff includes them); the PreToolUse
  side stays a best-effort nudge by user decision (no Bash-write gate).
- **F4 [HIGH] — path matcher misses real code.** Raw substrings `src/`∪`packs/`∪`test/`
  (`contains` = `String.includes`, `evaluator/expression/functions.ts:64`); top-level
  `index.ts`, `scripts/`, `bin/`, `lib/`, `*.config.ts` slip through. → the commit hook
  sees the repo's REAL changed files; the PreToolUse nudge uses git's own tracked-ness
  (`git check-ignore`/`git ls-files`) instead of substrings.
- **F5 [HIGH] — track downgrade sticky + global.** `coding-flow-track` set by a keyword
  match on the whole prompt (`entry-and-handoffs/skill.yaml:42-73`); ONE `fix|bug|doc|…`
  token makes `taskcreate-spec-required` (`scope-lifecycle/skill.yaml:206-213`) skip the
  AUTHOR audit for EVERY TaskCreate that session.
- **F6 [MED] — blocking gates fail OPEN on a thrown primitive.** `dispatch.ts:462`
  `if (result.kind !== 'verdict') continue;` skips an errored rule → default
  `exitCode: 0` (`dispatch.ts:554`). `has_generated_spec`/`has_active_task`/
  `workflow_phases_complete` (`active_task.ts:54-56,82-88,135-141`) `return err(...)` on a
  caught exception → block does NOT fire. Header comment (`active_task.ts:11-14`) claims
  "never fail-open" — contradicted.
- **F7 [MED] — scope-before-code accepts `researched` + mere spec-file existence.**
  `scope-lifecycle/skill.yaml:180` allows when `spec.generated == true` ∧ state ∈
  {`researched`,`spec_authored`,…}; `has_generated_spec` (`active_task.ts:120-143`) only
  checks the spec path resolves on disk — not that it passed the audit (`spec_complete`).
- **F8 [MED] — pause-gates advisory + a prose question uncovered.** Three `warn` verdicts
  (`pause-prevention/skill.yaml:24,48`, `pause-stop-guard/skill.yaml:18`) → exit 0; cannot
  hard-stop. `no-stop-mid-run` fires only for FSM ∈ {spec_authored,spec_complete,
  tasks_loaded,phases_in_flight} — a turn ending at `researched` or `phases_complete`-with-
  open-tasks isn't flagged.
- **F9 [LOW] — task-start nudge dropped.** `task-start/skill.yaml:13-14` triggers
  `tool_call` but the rule emits a `level: directive` (`:31-40`); directives surface only
  on `prompt_submit` (`dispatch.ts:432`) → dropped. The FSM reset on the same tool_call
  still works.
- **F10 [HIGH] — the flow does NOT re-arm for a new track in a live session.** (Found by
  dogfooding THIS fix.) `scope_start` is valid only from `idle` (`fsm.yaml:25`). Once a run
  reaches `phases_complete`, there is no transition back to `scoping` except `task_unscoped`
  (needs an unscoped-task activation). A new scope-authoring prompt in the same session is a
  silent no-op (`enter-scoping`'s `advance_fsm scope_start` does nothing from
  `phases_complete`), so the SCOPE gate never re-engages. Live evidence: session
  `94c113a3…` sat at `phases_complete` (stamped 2026-06-03T23:44) across all of today's
  work; the gap-fix pre-research write fired its `write_state` side-effects but the
  `research_done` advance was an invalid-from-`phases_complete` no-op. Compounded by
  `.current-session` getting clobbered to `doctor-probe` by `opensquid doctor` (the probe
  session records itself as live — `session_id.ts:63-85` via the doctor path).

## 3. Scope decisions (user-answered — no open questions)

1. **Breadth:** fix ALL findings (F1–F10).
2. **EXECUTE boundary:** install BOTH `pre-commit` and `pre-push` git hooks (not matchers).
3. **PreToolUse code check:** KEEP as a best-effort nudge using git's own tracked-ness; the
   git hooks are the guarantee. Do NOT gate arbitrary Bash writes.
4. **Pause-gates:** escalate the three to `block`.

## 4. Fix design (simplest correct, per lexicon) — 7 tasks (100% finding coverage)

- **GF.1 — Restore cross-pack profession wiring (F1, F9).** Add `usage: profession` to
  `task-spec-author/manifest.yaml` (mirrors scope-architect). Move the re-scope nudge from
  `task-start` (tool_call, dropped) to a `prompt_submit` handoff in `entry-and-handoffs`
  keyed on the `scoping` state (where directives surface); delete the dead directive from
  `task-start` but KEEP its `advance_fsm` reset. Test: a cross-pack dispatch asserts
  `handoff-research-to-spec` resolves (not `wrong-usage`); a `scoping`-state prompt_submit
  surfaces the nudge.
- **GF.2 — Owned-boundary EXECUTE gate: git pre-commit + pre-push (F2, F3, F4-core).** New
  CLI gate `opensquid-hook-precommit` / `opensquid-hook-prepush` (or `opensquid gate
commit|push`): resolve the session (`resolveMcpSessionId`), read the staged/pushed diff,
  read FSM/phase/active-task state, exit non-zero (block) unless the active task is
  `phases_complete` with a `spec_complete`-audited spec AND a complete 7-phase ledger.
  Managed hook scripts (carry an `@opensquid` marker) + an installer
  (`setup/wizard/git-hooks.ts`, reusing the settings-writer marker idiom) + a `doctor
git-hooks` check. Fix the `.current-session` clobber: `opensquid doctor` must NOT record
  its probe session as live (skip `recordCurrentSession` for the probe). Test: a staged code
  change with the FSM not `phases_complete` → hook exits non-zero; with a completed run →
  exit 0.
- **GF.3 — Demote the PreToolUse code gate to a best-effort nudge + `--no-verify` detector
  (F4-nudge, F3-accepted).** `scope-before-code` becomes `warn` (early feedback), deciding
  "is this tracked source" via git (`check-ignore`/`ls-files`) not substrings; add a one-line
  accepted-limitation note that Bash-mediated writes are caught at the commit boundary, not
  here. Add a narrow PreToolUse `block` on `git commit … --no-verify|-n` (and `git push
--no-verify`) — the single closed opt-out token. Test: a `Write` to a tracked `src` file
  pre-scope → warn (not block); a `--no-verify` commit → block.
- **GF.4 — Fail CLOSED + require spec-audited (F6, F7).** Make `has_generated_spec` /
  `has_active_task` / `workflow_phases_complete` return the CONSERVATIVE `ok` (not `err`) on
  a caught exception — total contract, block fires, header comment becomes true. Tighten
  `scope-before-code`'s allow set to state ∈ {spec_complete,tasks_loaded,phases_in_flight,
  phases_complete} (drop `researched`,`spec_authored`). Test: a forced-throw primitive →
  gate blocks; `researched` + stub spec → blocked.
- **GF.5 — Scope the track downgrade per-intent (F5).** Downgrade to fix/doc/trivial ONLY
  when a fix/doc/trivial keyword is present AND no feature-intent keyword
  (`build|add|feature|implement|new\s+(feature|module|endpoint)|refactor`); mixed intent →
  stay `feature` (strictest). Keep the per-scope-entry reset to `feature`. Test: "build X and
  fix the header" → stays feature → TaskCreate blocked; pure "fix the flaky test" → fix →
  AUTHOR skipped.
- **GF.6 — Pause-gates hard-block + widen coverage (F8).** Escalate the three `warn` →
  `block`. Widen `no-stop-mid-run` to also fire at `researched` and at `phases_complete` WHEN
  `open_task_count > 0`; preserve the depletion auto-OFF (idle OR phases_complete∧0-open).
  Test: stop at researched/phases_in_flight/phases_complete+open → block; stop at
  idle/phases_complete+0-open → allow; AskUserQuestion after scope → block.
- **GF.7 — Re-arm the flow for a new track (F10).** Add transition `{from: phases_complete,
on: scope_start, to: scoping}` — a new scope-authoring prompt after depletion re-arms the
  SCOPE gate (totality preserved; mid-run scope_start from other states stays a no-op).
  Test: from `phases_complete`, a scope-intent prompt advances → `scoping` and the SCOPE gate
  re-engages; the existing `idle → scoping` path unchanged.

## 5. Risks + invariants

- GF.4 fail-closed flip only changes the rare throw path; happy path unchanged.
- GF.6 must preserve the depletion auto-OFF (the `open_task_count` condition is load-bearing,
  else a finished run is blocked from stopping).
- GF.3 nudge must exclude `docs/` (SCOPE artifacts + specs are pre-code writes the flow
  REQUIRES).
- GF.2 hook must FAIL CLOSED on session-resolution failure for a gated repo (no resolvable
  session ⇒ cannot prove the flow ran ⇒ block) — but must not block in a NON-gated repo
  (no `.opensquid` / pack inactive ⇒ allow), else it breaks unrelated commits.
- GF.7's new transition is the only FSM topology change; re-run `validateFsm` totality.
- Only GF.7 touches `fsm.yaml`; GF.2 adds a CLI + installer (new files) + doctor; the rest
  are pack-yaml + 3 primitive bodies + tests.
