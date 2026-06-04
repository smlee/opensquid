# Track T-CODING-FLOW-COMPLETENESS — make the pack enforce the full personal workflow

**Pre-research:** `docs/research/T-coding-flow-completeness-pre-research-2026-06-04.md`
(three evidence-backed audits + the user's two rulings: boundaries gate on audited
content-completeness, uniform across SCOPE→AUTHOR→EXECUTE; AUTHOR is complete only when the
tasks cover 100% of the scoped design). Five tasks cover 100% of the five audited gaps.

Cross-cutting: every gate stays fail-CLOSED (no clear PASS verdict ⇒ no advance / blocked);
adversarial audits reuse the `subagent_call` shape (model: reasoning, timeout_ms: 120000)
that guess-audit/spec-audit already use; Simplicity = fold into `coding-flow`, no new pack.

### Task AF.1: Make the SCOPE boundary gating + content-complete (req 3)

**Required skills:** opensquid skill.yaml author expert; FSM/dispatch ordering expert; adversarial-audit (subagent_call) expert; Vitest dispatch-test expert; Audit / code review expert
**Deliverable:** the `scoping/researching → researched` advance fires ONLY when the SCOPE content is complete: (a) the guess-audit returns `GUESS_FREE`, (b) the pre-research has NO unresolved `OPEN QUESTION` marker (all questions answered), (c) research depth (recall+Read+Grep ≥3 this turn) is met, (d) the BEST solution is found per the criteria — the scope audit additionally verifies that alternatives were weighed and the simplest-correct one chosen (lexicon Simplicity + the alternatives/inversion/spike criteria). Today `advance-on-research` is unconditional + first, and guess-audit is warn-only — so the advance is advisory. After AF.1 the advance is coupled to the audit (no advisory pass); open questions, shallow depth, or a not-best/over-complected solution each block it.
**Depends on:** None.

**Files affected:**

- `packs/builtin/coding-flow/skills/scope-lifecycle/skill.yaml` (modify) — couple `advance-on-research` to the guess-audit verdict; add an `OPEN QUESTION` block; add the depth gate.
- `test/builtin/coding-flow.test.ts` (modify) — gating fixtures.

**Key code shapes:**

```yaml
# scope-lifecycle — the research advance now depends on the audit + depth + no open Qs.
# Re-order so the audit runs BEFORE the advance, and the advance reads its verdict.
- id: scope-advance
  process:
    - call: tool_name
      as: tool
    - call: tool_args
      as: targs
    - call: session_tool_history
      args: { scope: current_turn, filter_names: [mcp__opensquid__recall, Read, Grep] }
      as: depth
    - call: subagent_call # the guess-audit (unchanged prompt), captured here
      if: '(tool == "Write" || tool == "Edit") && contains(targs.file_path, "docs/research/") && contains(targs.file_path, "-pre-research-")'
      args: { model: reasoning, timeout_ms: 120000, prompt: '<NEVER-GUESS prompt>' }
      as: audit
    - call: advance_fsm # advance ONLY when content-complete
      if: 'isResearchWrite && contains(audit, "VERDICT: GUESS_FREE") && !contains(targs.content, "OPEN QUESTION") && depth.count >= 3'
      args: { event: research_done }
    - call: verdict # block while open questions remain unresolved
      if: 'isResearchWrite && contains(targs.content, "OPEN QUESTION")'
      args:
        {
          level: block,
          message: 'SCOPE incomplete: resolve every OPEN QUESTION (AskUserQuestion → record the answer + cite it) before authoring. Scoping is where gaps get filled.',
        }
    - call: verdict # block on insufficient research depth (folded DPC.5)
      if: 'isResearchWrite && depth.count < 3'
      args:
        {
          level: block,
          message: 'SCOPE shallow: do recall + Read + Grep (>=3 this turn) before the pre-research write.',
        }
```

**Test fixtures:** a pre-research write with an `OPEN QUESTION` line → BLOCKED, FSM stays `scoping`/`researching` (no `research_done`). A write with depth.count<3 (seed <3 tool history) → BLOCKED. A GUESS_FREE write, no open Qs, depth≥3 → advances to `researched`. A guess-audit `UNRESOLVED` verdict → does NOT advance.

**Acceptance criteria:**

- [ ] `research_done` fires ONLY on GUESS_FREE + no `OPEN QUESTION` + depth≥3
- [ ] an unresolved open question BLOCKS the advance (not warn)
- [ ] depth gate folded in from scope-architect, as a block
- [ ] guess-audit loopback still works (UNRESOLVED → stays researching)
- [ ] `pnpm typecheck && pnpm lint && pnpm vitest run && pnpm build && pnpm format:check`

**Risk callouts:** the advance MUST be coupled to the audit verdict, not merely ordered after it (the current advisory bug). `session_tool_history(current_turn)` is per-turn — a continuation turn that only writes the doc may read depth 0; the OPEN-QUESTION + GUESS_FREE blocks still hold, and depth is satisfied on the turn the research is actually done. Keep fail-CLOSED: a subagent timeout (no GUESS_FREE) ⇒ no advance.
**References:** `scope-lifecycle/skill.yaml:17-67` (advance-on-research + guess-audit), `scope-architect/skills/pre-research-authoring/skill.yaml` (DPC.5 depth, being folded), `src/functions/session_tool_history.ts`.
**Verification commands:** `pnpm vitest run test/builtin/coding-flow.test.ts && pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run && pnpm build`.
**7-phase steps:** 1 pre-research: DONE (advisory-advance + dormant-DPC.5 gaps). 2 learn: lock the coupled-advance + the two blocks. 3 code: re-order scope-lifecycle, add OPEN-QUESTION + depth blocks. 4 test: open-Q/depth/GUESS_FREE fixtures. 5 audit: advance truly coupled, fail-closed. 6 post-research: n/a. 7 fix.

### Task AF.2: AUTHOR batch-completeness — tasks cover 100% of the scoped design (req 1)

**Required skills:** opensquid skill.yaml author expert; transcript-task enumeration expert; adversarial coverage-audit expert; Vitest dispatch-test expert; Audit / code review expert
**Deliverable:** the FIRST EXECUTE action (a `src/∪packs/∪test/` write OR a `log_phase`) is BLOCKED until (a) a COVERAGE audit verdicts the open task set covers 100% of the scoped design artifact, AND (b) every open task's own spec is SPEC_COMPLETE. So you cannot start the 7-layer with a partial backlog.
**Depends on:** [AF.1](#task-af1-make-the-scope-boundary-gating--content-complete-req-3).

**Files affected:**

- `packs/builtin/coding-flow/skills/scope-lifecycle/skill.yaml` (modify) — a `batch-author-complete` gate consulting the open task list + a coverage subagent.
- `src/functions/...` — reuse `readOpenTasksFromTranscript` (no new primitive if a `coverage_complete`-style check is expressible; else a thin `open_task_specs` primitive returning each open task's spec resolvability).
- `test/builtin/coding-flow.test.ts` (modify).

**Key code shapes:**

```yaml
# scope-lifecycle — block the first EXECUTE action until 100% design coverage + all specced.
- id: batch-author-complete
  process:
    - call: tool_name
      as: tool
    - call: tool_args
      as: targs
    - call: open_tasks # {tasks:[{id, spec_present}], all_specced: bool}
      as: open
    - call: read_state
      args: { key: coding-flow-pre-research-path } # the scoped design artifact
      as: design
    - call: subagent_call # coverage audit: design vs task set
      if: 'isExecuteStart && open.all_specced == true'
      args:
        {
          model: reasoning,
          timeout_ms: 120000,
          prompt: 'You verify TASK COVERAGE. Given the SCOPE design artifact and the task list, begin with VERDICT: COVERAGE_COMPLETE only if EVERY design element maps to a task; else VERDICT: GAP + one bullet per uncovered element. DESIGN:\n{{design_content}}\nTASKS:\n{{open_list}}',
        }
      as: coverage
    - call: verdict
      if: 'isExecuteStart && (open.all_specced == false || !contains(coverage, "VERDICT: COVERAGE_COMPLETE"))'
      args:
        {
          level: block,
          message: 'AUTHOR incomplete: tasks must cover 100% of the scoped design AND each be spec-audited. Finish authoring the full list before any 7-layer. Coverage:\n{{coverage}}',
        }
```

**Test fixtures:** open tasks where one lacks a spec → first code-write/`log_phase` BLOCKED. All specced but coverage verdict `GAP` → BLOCKED. All specced + `COVERAGE_COMPLETE` → first EXECUTE allowed. No open tasks (nothing authored) → BLOCKED (can't execute an empty/unscoped backlog).

**Acceptance criteria:**

- [ ] first EXECUTE action blocks while any open task is un-specced
- [ ] first EXECUTE action blocks while coverage verdict ≠ COVERAGE_COMPLETE
- [ ] passes once 100% coverage + all-specced
- [ ] does NOT block subsequent EXECUTE actions once opened (per-task 7-layer proceeds)
- [ ] full gate chain green

**Risk callouts:** "first EXECUTE action" must be detected without blocking the WHOLE 7-layer repeatedly — gate on a transition into the EXECUTE region (e.g. fires while FSM < tasks_loaded OR on the first `log_phase` of the batch), not on every code write (scope-before-code already covers per-task scoped-ness). The coverage audit is fail-CLOSED. The `design` artifact is the pre-research path captured by AF.1's `write_state`.
**References:** `src/runtime/hooks/transcript_tasks.ts` (`readOpenTasksFromTranscript`), `scope-lifecycle/skill.yaml` (gate ordering), AF.1's `coding-flow-pre-research-path` state.
**Verification commands:** `pnpm vitest run test/builtin/coding-flow.test.ts && pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run && pnpm build`.
**7-phase steps:** 1 pre-research: DONE (no batch-completeness gate today). 2 learn: lock the open-task enumeration + coverage-audit shape + "first EXECUTE" trigger. 3 code: open_tasks consult + coverage subagent + the block. 4 test: un-specced / GAP / COVERAGE_COMPLETE / empty fixtures. 5 audit: blocks only the ENTRY to EXECUTE, fail-closed. 6 post-research: n/a. 7 fix.

### Task AF.3: EXECUTE loop driver — report each task, then next, no pause (req 2)

**Required skills:** opensquid skill.yaml author expert; FSM handoff/directive expert; chat-integration expert; Vitest dispatch-test expert; Audit / code review expert
**Deliverable:** on `phases_complete` for a task, the pack emits a directive that (a) sends the per-task 7-layer report to the main chat (`project:telegram`, topic 15) and (b) moves straight to the next pending task — making report-each-task + no-pause structural rather than agent-memory.
**Depends on:** [AF.2](#task-af2-author-batch-completeness--tasks-cover-100-of-the-scoped-design-req-1).

**Files affected:**

- `packs/builtin/coding-flow/skills/entry-and-handoffs/skill.yaml` (modify) — a `phases_complete` handoff rule.
- `test/builtin/coding-flow.test.ts` (modify).

**Key code shapes:**

```yaml
# entry-and-handoffs — the EXECUTE→report→next-task handoff (the missing phases_complete handler).
- id: handoff-task-complete
  process:
    - call: read_fsm_state
      as: st
    - call: workflow_phases_complete
      as: phases
    - call: verdict
      if: 'st == "phases_complete" && phases.complete == true'
      args:
        level: directive
        next_action:
          tool: mcp__opensquid-chat__chat_send
          args: { channel: 'project:telegram' }
          rationale: >-
            Task 7-layer COMPLETE. Send the plain-header 7-layer completion report to the
            main chat (topic 15), THEN immediately TaskUpdate(next pending task, in_progress)
            and continue — no pause. Loop until the backlog is depleted.
```

**Test fixtures:** dispatch reaching `phases_complete` with `workflow_phases_complete.complete == true` → a `directive` verdict naming `chat_send` + the next-task instruction. `phases_complete` but phases incomplete → no directive (cannot happen post-execute-gate, but assert the guard).

**Acceptance criteria:**

- [ ] a `phases_complete` directive fires, naming the chat report + next-task continuation
- [ ] the directive references `project:telegram` (topic 15) + TaskUpdate(next, in_progress)
- [ ] no directive when phases are incomplete
- [ ] full gate chain green

**Risk callouts:** a directive cannot FORCE the agent to continue (it directs); pairing it with AF.2's batch-gate + the task-start reset means the next task re-enters the loop correctly. Use the exact chat tool name `mcp__opensquid-chat__chat_send` (the hyphenated MCP id). Keep it a directive (level: directive), not a block — the report is an obligation surfaced at the right moment, not a tool-blocker.
**References:** `entry-and-handoffs/skill.yaml:74-89` (the resume handoff to mirror), `workflow_phases.ts` (`workflow_phases_complete`), `mcp__opensquid-chat__chat_send`.
**Verification commands:** `pnpm vitest run test/builtin/coding-flow.test.ts && pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run && pnpm build`.
**7-phase steps:** 1 pre-research: DONE (no phases_complete handler). 2 learn: lock the directive shape + next-action. 3 code: the handoff-task-complete rule. 4 test: directive-fires / guard fixtures. 5 audit: directive not block, correct channel. 6 post-research: n/a. 7 fix.

### Task AF.4: Apply the lexicon — a Simplicity criterion in the audits (req 4)

**Required skills:** opensquid skill.yaml author expert; lexicon / design-principles expert; adversarial-audit prompt expert; Vitest expert; Audit / code review expert
**Deliverable:** the spec-audit (and the SCOPE guess-audit) additionally enforce the lexicon's Simplicity Principle — the spec/solution must be the SIMPLEST correct one (no proliferating special-cases; explicit total-transition state; pure transforms) per `docs/lexicon.md`. The verdict fails when a spec smells over-complected.
**Depends on:** [AF.1](#task-af1-make-the-scope-boundary-gating--content-complete-req-3).

**Files affected:**

- `packs/builtin/coding-flow/skills/scope-lifecycle/skill.yaml` (modify) — extend the spec-audit prompt with the Simplicity criterion (a second pass condition, fail-closed).
- `test/builtin/coding-flow.test.ts` (modify).

**Key code shapes:**

```yaml
# spec-audit prompt — append the Simplicity criterion to the 11-field contract.
prompt: >-
  ... (existing 11-field + real-code contract) ... AND the design is the SIMPLEST correct
  solution per docs/lexicon.md: no proliferating special-cases (that signals a missed
  decomposition), every lifecycle an explicit total-transition FSM, every transform a pure
  function. Begin with VERDICT: SPEC_COMPLETE only if BOTH the 11-field contract AND the
  Simplicity criterion hold; else VERDICT: INCOMPLETE + one bullet per failing item.
```

**Test fixtures:** the existing SPEC_COMPLETE / INCOMPLETE dispatch fixtures still pass (the prompt-aware subagent stub returns the configured verdict). Add a fixture whose stubbed verdict is `INCOMPLETE` citing an over-complected design → stays `spec_authored`, TaskCreate blocked.

**Acceptance criteria:**

- [ ] spec-audit prompt includes the Simplicity / lexicon criterion
- [ ] verdict is fail-closed on either the 11-field OR the Simplicity criterion
- [ ] existing spec-audit fixtures remain green
- [ ] full gate chain green

**Risk callouts:** keep it ONE audit (extend the prompt) — do NOT add a separate audit skill (Simplicity itself: don't multiply gates). The criterion is an LLM judgment (inherent), but it makes the principle an applied criterion, not just documentation. Reference `docs/lexicon.md` by name so the principle is discoverable.
**References:** `scope-lifecycle/skill.yaml:85-119` (spec-audit), `docs/lexicon.md:10-26` (the principles).
**Verification commands:** `pnpm vitest run test/builtin/coding-flow.test.ts && pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run && pnpm build`.
**7-phase steps:** 1 pre-research: DONE (lexicon documented-not-enforced). 2 learn: lock the appended criterion. 3 code: extend the spec-audit prompt. 4 test: over-complected INCOMPLETE fixture + existing pass. 5 audit: one audit not two, fail-closed. 6 post-research: n/a. 7 fix.

### Task AF.5: Retire the dormancy + cleanup (req 5 — no gates left behind)

**Required skills:** opensquid pack-cutover expert; grep/cross-ref expert; test-rename expert; Audit / code review expert
**Deliverable:** no gate is left behind. AF.1 folded scope-architect's SCOPE gates into coding-flow; AF.5 confirms scope-architect has no remaining live-but-dormant gate the live umbrellas need (port any remainder or document why not), and purges stale `scope-fsm`/`workflow-fsm` names from LIVE comments + renames `scope_fsm_guess_prevention.test.ts`.
**Depends on:** [AF.1](#task-af1-make-the-scope-boundary-gating--content-complete-req-3).

**Files affected:**

- `packs/builtin/coding-flow/skills/*/skill.yaml`, `fsm.yaml`, `manifest.yaml` (modify) — re-word the `# Ports scope-fsm/workflow-fsm` provenance comments to reference the unified `coding-flow` history (or drop).
- `src/runtime/hooks/{user-prompt-submit,pre-tool-use,session-end}.ts`, `src/mcp/tools/log_phase.ts` (modify) — refresh stale old-pack-name comments.
- `src/runtime/hooks/scope_fsm_guess_prevention.test.ts` → rename to `coding_flow_guess_prevention.test.ts`; update its in-test pack name.
- `docs/` — add a one-line "superseded by coding-flow" note where old track docs name the retired packs.

**Key code shapes:** (mechanical) `grep -rn "scope-fsm\|workflow-fsm" packs src docs` → for each LIVE hit (not CHANGELOG history), re-word to name `coding-flow`; `git mv` the test file + update its `name:` literal.

**Test fixtures:** the renamed test still passes unchanged (same assertions, new filename + in-test pack name). `grep -rn "scope-fsm\|workflow-fsm" packs/ src/` returns only CHANGELOG/historical hits (0 live).

**Acceptance criteria:**

- [ ] `grep` of packs/ + src/ for the old pack names → only historical/CHANGELOG hits
- [ ] scope-architect's gates are accounted for (folded by AF.1 or explicitly N/A)
- [ ] the renamed guess-prevention test passes
- [ ] full gate chain green

**Risk callouts:** do NOT rewrite CHANGELOG history (the names are real there). This is cosmetic + dormancy-closing; no behavior change beyond AF.1's fold. Verify the rename doesn't break import paths / vitest globs.
**References:** the Agent-3 audit's stale-ref list (`fsm.yaml:10`, `phase-advance:3`, `entry-and-handoffs:3-4`, `scope-lifecycle:3,6,178`, `user-prompt-submit.ts:129`, `pre-tool-use.ts:126,143`, `log_phase.ts:80`, `session-end.ts:132`, `scope_fsm_guess_prevention.test.ts`).
**Verification commands:** `grep -rn "scope-fsm\|workflow-fsm" packs/ src/ | grep -v CHANGELOG; pnpm vitest run && pnpm typecheck && pnpm lint && pnpm format:check && pnpm build`.
**7-phase steps:** 1 pre-research: DONE (stale-ref + dormancy list). 2 learn: confirm AF.1 covered scope-architect's gates. 3 code: re-word comments, rename test, doc notes. 4 test: rename passes, grep clean. 5 audit: no live old-name refs, no behavior drift. 6 post-research: n/a. 7 fix.

### Task AF.6: The automation boundary — questions belong to SCOPE only (the keystone)

**Required skills:** opensquid skill.yaml author expert; FSM-state-gating expert; agent-behavior / drift-gate expert; Vitest dispatch-test expert; Audit / code review expert
**Deliverable:** the pack encodes "interrupt in SCOPE, automate after." `AskUserQuestion` is permitted while the FSM is in SCOPE (`idle`/`scoping`/`researching`/`researched`); once past SCOPE (`spec_authored` onward — authoring + execute), an `AskUserQuestion` is flagged as DRIFT (it should have been resolved during scoping). The only valid post-scope interrupt is a user-initiated review request (out of band; the pack does not block those). This makes the interactive→automated handoff structural, not agent-memory.
**Depends on:** [AF.1](#task-af1-make-the-scope-boundary-gating--content-complete-req-3).

**Files affected:**

- `packs/builtin/coding-flow/skills/scope-lifecycle/skill.yaml` (modify) — an `automation-after-scope` rule on the `AskUserQuestion` tool_call.
- `test/builtin/coding-flow.test.ts` (modify).

**Key code shapes:**

```yaml
# scope-lifecycle — questions are a SCOPE tool. Past researched, they are drift.
- id: automation-after-scope
  process:
    - call: tool_name
      as: tool
    - call: read_fsm_state
      as: st
    - call: verdict
      if: '(tool == "AskUserQuestion") && st != "idle" && st != "scoping" && st != "researching" && st != "researched"'
      args:
        level: warn
        message: >-
          DRIFT: AskUserQuestion past SCOPE (state past `researched`). Questions belong to
          the interactive SCOPE phase — everything after scope is automated. If a real
          design gap surfaced, the prior SCOPE was incomplete (re-scope it); do NOT pause
          the automated AUTHOR/EXECUTE run for a question that should have been asked earlier.
```

**Test fixtures:** dispatch `AskUserQuestion` at `st=scoping` → no verdict (allowed). At `st=spec_authored` → `warn` drift. At `st=phases_in_flight` → `warn` drift. At `st=researched` → allowed (still scope boundary).

**Acceptance criteria:**

- [ ] `AskUserQuestion` allowed in idle/scoping/researching/researched
- [ ] `AskUserQuestion` flagged drift (warn) at spec_authored/spec_complete/tasks_loaded/phases_in_flight/phases_complete
- [ ] warn (directs), not block — a genuinely-needed re-scope is still possible
- [ ] full gate chain green

**Risk callouts:** `warn` not `block` — a hard block could trap a legitimate "the scope was wrong, I must re-open it" case; the message directs re-scoping instead. `researched` is the SCOPE terminal (scope-complete) so it stays on the allowed side. This pairs with AF.1 (which makes scope-complete real) so that "ask everything in scope" is enforced from both sides.
**References:** `scope-lifecycle/skill.yaml` (gate ordering), `fsm.yaml:13-22` (the states), AF.1 (scope-complete definition).
**Verification commands:** `pnpm vitest run test/builtin/coding-flow.test.ts && pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run && pnpm build`.
**7-phase steps:** 1 pre-research: DONE (the interactive-scope/automated-after ruling). 2 learn: lock the allowed-states set + warn-not-block. 3 code: the automation-after-scope rule. 4 test: allowed-in-scope / drift-after fixtures. 5 audit: warn not block, researched on allowed side. 6 post-research: n/a. 7 fix.
