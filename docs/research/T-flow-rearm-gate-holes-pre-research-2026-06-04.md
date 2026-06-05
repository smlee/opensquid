# Pre-research — T-FLOW-REARM-GATE-HOLES (close G-a + G-b)

**Date:** 2026-06-04 · **Repo:** opensquid · **Pack:** `coding-flow`
**Origin:** the two gate-hole findings recorded in
`docs/tasks/T-chat-finalize-remove-legacy.md` (§"Gate-hole findings"), which let the
author pause un-gated mid-run on 2026-06-04.

---

## 1. The two findings, as they actually exist in the code

### G-a — the SCOPE re-arm depends on a keyword regex, so plain-language new work never re-arms

The re-arm transition exists in the FSM and is correct:

> `packs/builtin/coding-flow/fsm.yaml:` `{ from: phases_complete, on: scope_start, to: scoping }` (GF.7).

The hole is in _who emits `scope_start`_. The ONLY prompt-time emitter is
`entry-and-handoffs/enter-scoping`, which advances `scope_start` **only on a keyword
match**:

> `packs/builtin/coding-flow/skills/entry-and-handoffs/skill.yaml` `enter-scoping`:
> `text_pattern_match` over `[\bspec…\b, \bscope\b, \bnew (task|track)\b,
\badd …(task|track)\b, \bdesign\b, \bplan\b]` → `advance_fsm scope_start` guarded by
> `len(intent.matched) > 0`.

A new unit of work described in **plain language** ("the null handling is broken — make
it robust", "the pause gates are leaking, go fix them") matches **none** of those
keywords. So `scope_start` is never emitted, the FSM stays parked at `phases_complete`,
and that is a denylist over an open set of phrasings — the exact evadable-heuristic smell
the user rejects ("no structure to vibe coding"). [[feedback-simple-logical-solutions]]

The other re-arm path — `task-start/unscoped-task-rescopes` (`TaskUpdate(in_progress)` +
`has_generated_spec==false` → `task_unscoped` → scoping) — only fires if the agent goes
through `TaskUpdate`. An agent that jumps straight from a plain-language prompt into a
code `Write` never trips it.

**Why the parked state is harmful — the pause-gates read it as "depleted" and switch OFF.**
Run-active is derived (not stored):

> `src/functions/active_task.ts` `OpenTaskCount` doc + `pause-prevention`/`pause-stop-guard`:
> run-active = `FSM != idle AND (open_task_count > 0 OR FSM != phases_complete)`.

At `phases_complete` with the backlog depleted (`open==0`):
run-active = `true AND (false OR false)` = **FALSE**. Consequences (all verified against
the skills):

- `pause-prevention/no-pause-language` is gated on run-active → **no-ops entirely** (so G-b
  can't even fire here — the two findings compound).
- `pause-stop-guard/no-stop-mid-run` fires for `… || (st == "phases_complete" && open.count > 0)`
  → at `open==0` it does **not** block → a turn-ending Stop is allowed.
- Net: after a depleted run, the agent can end a turn with permission-fishing prose and a
  plain Stop, un-flagged — which is exactly the 2026-06-04 incident.
  [[feedback-resolve-decisions-into-facts-not-forks]]

### G-b — the pause-LANGUAGE detector is a denylist that misses the decision-deferral class

> `packs/builtin/coding-flow/skills/pause-prevention/skill.yaml` `no-pause-language`:
> `text_pattern_match` on `priorAssistantText` over three groups —
> (1) `should i (continue|proceed) | want me to | ready to … | shall i | is (this|the plan) (ok|good|right)`,
> (2) `i'?ll pause | let me (check|pause|confirm) … | pausing (here|now) | checkpoint here`,
> (3) `context … limit | at the … limit | running (low|out) of context`.

Missing the **decision-deferral** family the user flagged verbatim: _"your call"_,
_"unless you redirect"_, _"unless you'd rather"_, _"up to you"_, _"let me know which"_,
_"which / none of these"_, _"say the word"_. Same denylist-over-open-set smell as G-a.

---

## 2. What this is NOT (scope boundary, cited)

- `scope-before-code` (the in-session code nudge) is **not** the hole here. At
  `phases_complete` with no active task, `has_generated_spec` returns `generated:false`
  (`active_task.ts` `HasGeneratedSpec`: `readActiveTask===null → {present:false,
generated:false}`), so the warn's first disjunct (`spec.generated == false`) already
  fires on un-scoped code. And the hard guarantee is the git pre-commit/pre-push gate
  (GF.2). So the CODE path is already covered (warn + fail-closed git gate). The
  uncovered surface is specifically the **pause path before any code is written.**
  [[project-coding-flow-gap-fixes-boundary-ownership]]
- The hard pause-ACTION blocks (`no-stop-mid-run`, `no-question-after-scope`) are the real
  enforcement and are correct; they only need the FSM to be in a run-active state to
  engage — which is precisely what G-a denies them.

---

## 3. Alternatives weighed → the simplest correct solution

### G-a

| #     | Option                                                                                                                                                                                                                                                                                          | Verdict                                                                                                                                                                                                                                                                                |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | **Expand the keyword list** (`fix`, `bug`, `make`, `handle`, …)                                                                                                                                                                                                                                 | ❌ Relocates the slop; still a denylist over an open set; the next plain phrasing re-opens the hole. The user's explicit anti-pattern.                                                                                                                                                 |
| B     | **Unconditional re-arm on every prompt from `idle` OR `phases_complete`**                                                                                                                                                                                                                       | ❌ Over-fires `handoff-rescope-nudge` (scope-architect directive) on every cold-session conversational turn ("hi", "thanks"); largest blast radius.                                                                                                                                    |
| C     | **On backlog-depletion, reset `phases_complete → idle`, keep keyword entry**                                                                                                                                                                                                                    | ❌ Merely relocates the keyword dependency from `phases_complete` to `idle`; the plain-language hole survives at `idle`.                                                                                                                                                               |
| D     | **Remove `phases_complete` from `scope-before-code`'s allow-set**                                                                                                                                                                                                                               | ❌ Breaks the legitimate backlog loop: `handoff-task-complete` does `TaskUpdate(next, in_progress)` and the next _already-specced_ task starts coding while the FSM still reads `phases_complete` (before its first `log_phase → phase_started`). The allow-set entry is load-bearing. |
| **E** | **Structural re-arm, scoped to depleted-terminal.** In `enter-scoping`, add `read_fsm_state` + `open_task_count`, and add the disjunct `st == "phases_complete" && open.count == 0` to BOTH the `scope_start` advance AND the `track=feature` reset — in addition to the existing keyword path. | ✅ **Chosen.**                                                                                                                                                                                                                                                                         |

**Why E is the simplest correct solution** (per the lexicon — every transition explicit,
the predicate a pure function of state, no heuristic on the enforcement path):

- It re-arms on a **structural fact** (the run is terminal _and_ the backlog is empty →
  any further prompt begins a new interaction), not a guess about the prompt's words.
- The `open.count == 0` guard keeps the **backlog loop intact**: when open tasks remain
  (`open > 0`) the prompt does NOT re-arm, so `handoff-task-complete` still sees
  `st == phases_complete` and drives report→next-task.
- Landing in `scoping` is **safe**: scoping is the interactive phase — `AskUserQuestion`
  is allowed, Stop is allowed, and `scope-before-code` only bites on an actual code Write.
  A conversational ack lands in scoping, the agent no-ops the scope nudge, no harm.
- Scoped to `phases_complete` (NOT `idle`) for **minimal blast radius**: it targets the
  exact hole (the post-run pause leak) and leaves the cold-start path unchanged.
- The track defaults to `feature` (strictest) on the structural re-arm, since a
  plain-language track can't be classified — fail-safe, matching the existing FU.3 reset.
- FSM unchanged — `phases_complete --scope_start--> scoping` already exists (GF.7); E only
  changes _when `scope_start` is emitted_.

### G-b

| #     | Option                                                                                                                                                                                                                               | Verdict                                                                                                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | **Replace the regex with a `subagent_call` reasoning judge** (like guess-audit)                                                                                                                                                      | ❌ Too costly: `no-pause-language` fires on every `prompt_submit` + `tool_call` during an active run; a per-event reasoning call would dominate run latency. The rule is a _retrospective WARN backstop_, not worth a reasoning call. |
| B     | **Promote the rule to `block`**                                                                                                                                                                                                      | ❌ Retrospective — the prose already shipped; blocking the next (possibly unrelated) tool can't undo it and risks locking the session. Existing documented rationale; the ACTION blocks are the hard gates.                           |
| **C** | **Add ONE coherent alternation group for the decision-deferral class**, framed + documented as the explicit best-effort retrospective backstop (the hard Stop/Question blocks — re-armed by G-a — remain the guarantee). Stays WARN. | ✅ **Chosen.**                                                                                                                                                                                                                        |

**Why C is correct, not "relocated slop":** natural-language pause-detection is
irreducibly heuristic; the slop would be _pretending the regex is the enforcement_. Here
the enforcement is structural (the hard Stop/Question blocks, now correctly armed by G-a);
the regex is an honest, clearly-labelled secondary nudge. We add one **named class**
(decision-deferral) rather than ad-hoc phrases, and a false positive is a non-blocking WARN
(exit 0) — the recall-over-precision asymmetry is the same one already accepted for the
`no-verify` over-block.

**The two are coupled** (justifies one track): G-a re-arms run-active → ON for a new track,
which is the precondition for G-b's WARN to fire at all. G-b without G-a would still no-op
at depleted `phases_complete`.

---

## 4. Inversion — how could this be wrong?

- **E breaks the backlog loop?** Guarded: the loop case has `open > 0`, so E's
  `open == 0` predicate is false and `handoff-task-complete` still fires. Covered by a test
  (plain prompt at `phases_complete` WITH a pending task → does NOT re-arm).
- **E spuriously re-arms on a conversational ack?** Yes, by design — and it is harmless:
  scoping is interactive (no forced action, no code gate without a code write). Accepted,
  documented trade-off: arming the gate by default after a run is the correct conservative
  posture; the scope-architect nudge is advisory and the agent no-ops it when idle.
- **C over-matches legitimate prose** (e.g. "let me know if you hit an error" in a report)?
  Possible — but it is a non-blocking WARN; a false positive is a harmless surfaced nudge,
  never a block. Recall is the priority for a retrospective detector.

## 5. Empirical spike

The test fixtures ARE the spike, asserted through the real dispatcher
(`test/builtin/coding-flow.test.ts` harness — `dispatchEvent`, `drivePhasesComplete`,
`putPendingTask`, `registry`):

1. **G-a re-arm:** at depleted `phases_complete`, `AskUserQuestion` is BLOCKED (exit 2,
   past-SCOPE); after a **plain-language** prompt (no scope keyword) it is ALLOWED (exit 0)
   — proving the FSM re-armed to `scoping` and run-active engaged.
2. **G-a loop-safety:** the same plain prompt with a pending task present (`open>0`) leaves
   `AskUserQuestion` BLOCKED — the loop driver is intact.
3. **G-b:** `priorAssistantText: "…your call."` / `"unless you redirect"` during an active
   run → WARN (exit 0, stderr matches `/DRIFT/`).

## 6. Decomposition

- **RH.1** — G-a: structural re-arm in `entry-and-handoffs/enter-scoping` (+ FSM
  re-arm-from-`*`? no — reuse existing GF.7 transition) + 2 integration tests.
- **RH.2** — G-b: decision-deferral alternation group in `pause-prevention/no-pause-language`
  - integration tests.
- **RH.3** — doc sync: `docs/tasks/T-chat-finalize-remove-legacy.md` (mark G-a/G-b resolved,
  link this track) + `docs/lexicon.md` if a principle label is touched (none new).

No OPEN QUESTIONS — the design is fully determined by the code and the labeled principles.
