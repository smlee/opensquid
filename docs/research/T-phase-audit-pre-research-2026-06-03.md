# Pre-research — T-FSM-UNIFY FU.10 (the phase-audit: gate log_phase on evidence)

**Date:** 2026-06-03. **Repo:** opensquid. **Trigger:** the user asked "does that
[log_phase] need to be a gate itself?" — `log_phase` is a bare marker, so the
execute-gate verifies phases are LOGGED, not DONE. Research this turn: Read of
`src/functions/session_tool_history.ts`, `src/mcp/tools/log_phase.ts`,
`src/runtime/session_state.ts` (the per-turn ledger). Cited.

## 1. Root cause (verified, file:line)

`log_phase` writes the engine ledger + the gate state with NO check that the phase was
actually performed (`src/mcp/tools/log_phase.ts` — given a phase name, it appends).
So the execute-gate's `workflow_phases_complete` can be satisfied by claiming phases.
This is the same "marker without a content gate = checkbox" pattern, one level inside
EXECUTE. (`pre_research` already has a proxy: scope-architect's DPC.5 research-activity
gate.)

## 2. Fix design (derived; gate only what has mechanical evidence)

A `phase-audit` guard on the `log_phase` tool_call checks per-turn tool-ledger evidence
via `session_tool_history(scope: current_turn, filter_names: […])`
(`session_tool_history.ts:36-64` — returns `{tools, count}` of names this turn,
reset on UserPromptSubmit per `session_state.ts:138`):

- `code` / `fix` → require a Write/Edit/NotebookEdit this turn (`count > 0`), else block.
- `test` → require a Bash this turn (a run), else block.
- `learn` / `audit` / `post_research` → ACCEPT (no mechanical proxy — judgment; the
  recursion bottoms out here, you cannot gate intuition).
- `pre_research` → already gated by DPC.5 (out of scope here).

Fires on `tool == "mcp__opensquid__log_phase"`, reading `tool_args.phase`. A block on
an insufficient phase is the verdict.

## 3. Decisions (no unresolved guess)

1. **Gate only the mechanically-verifiable phases** (code/fix → writes; test → a run)
   — derived: `session_tool_history` gives tool NAMES this turn, enough for "wrote
   code" / "ran something", not enough to gate learn/audit/post_research.
2. **`current_turn` scope** — derived: a phase is logged in the turn it was done
   (`session_state.ts:138` resets the turn slice on UserPromptSubmit).
3. **test = any Bash this turn** is a HEURISTIC (a Bash is not provably a test) —
   accepted as the limit of the mechanical check; documented as such.

## 4. Open questions — none that block. (A stricter test check — matching the Bash

COMMAND, not just the tool name — would need a richer ledger; deferred.)
