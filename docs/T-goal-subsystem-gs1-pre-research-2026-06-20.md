# Pre-research: goal-subsystem GS.1 (persistent goal + MCP set_goal/get_goal floor)

**Date:** 2026-06-20
**Track:** feature (GS) — net-new MCP surface + persistent state in the opensquid repo
(`~/projects/loop/opensquid`). Work-graph: wg-7e0290084eff. (Authored project-scoped here so the
coding-flow FSM anchors to this single-task spec; the implementation + its own docs live in the
opensquid repo.)

## Problem (cited evidence)

Work-graph item wg-7e0290084eff (T-goal-subsystem, open) is the **next build-ready item** per the
0.6.x ordering anchor wg-9fa8edb13a84 ("3. wg-7e0290084eff goal-subsystem — DESIGNED … NEXT
build-ready item"). Locked design (do NOT re-derive): "GS.1 persistent goal state (structured) + the
MCP set_goal/get_goal floor (works on every harness)". User directive 2026-06-15 (memory
feedback-set-goal-before-work): "every process when you start work … you should set goals. this
should be automated within opensquid." No goal surface exists today (`grep set_goal|get_goal src/`
in the opensquid repo returns nothing).

## Evidence: the patterns to mirror (NEVER-GUESS — cited, all in `~/projects/loop/opensquid`)

- **MCP tool registration** — `src/mcp/server.ts`: a `ToolHandlers` const (`{schema, handle}` each),
  lock-step `toolAnnotations: Record<ToolName,…>` + `descriptions: Record<ToolName,string>`
  (compile-enforced); handlers return `Promise<string>`, server wraps `{content:[{type:'text',text}]}`.
- **Per-session state** — `src/runtime/paths.ts` `sessionStateFile(sessionId,key)` →
  `~/.opensquid/sessions/<id>/state/<key>.json`; `src/runtime/atomic_write.ts` `atomicWriteFile` (tmp+rename).
- **Closest model = `src/runtime/phase_ledger.ts`** — typed per-session state, atomic write, reads that
  collapse missing/malformed → empty (never throw); `src/mcp/tools/read-state.ts` ENOENT → "null".
- **Session resolution** — `src/runtime/hooks/session_id.ts` `resolveMcpSessionId()` (env-first);
  `log_phase` throws on null session, `read_state` returns null.
- **Conventions** — Zod `.describe()`; annotations `READ_ONLY`/`LOCAL_WRITE`; MCP schemas via runtime
  `zodToJsonSchema` (no `schemas/*.json` regen); vitest with temp `OPENSQUID_HOME`; gate chain
  `pnpm typecheck && lint && test && build && format:check`; `server.test.ts` asserts the exact sorted
  tool-name list (must be updated when a tool is added).

## Decision surface (alternatives weighed — BEST-SOLUTION)

- **State location:** (a) new bespoke store vs (b) existing `sessionStateFile(sessionId,'goal')`.
  **Chosen (b)** — reuse the per-session scheme (readable by read_state, inherits atomic-write +
  fault-tolerant-read), no new mechanism.
- **State shape:** `{id,text,createdAt,updatedAt}` is the irreducible minimum (mirrors phase*ledger's
  typed-record approach). The one non-obvious field is `status` — weighed \_include-now vs defer-to-GS.5*
  and DECIDED include-now: `set_goal` accepts it at zero extra cost, a goal has a natural lifecycle, and
  the locked design (wg-7e0290084eff) names GS.5 "completion = no-open-scope" — a completion criterion
  that requires a per-goal status/completion signal. So `status` is the floor's forward-compatible field,
  not speculative scope. (Resolved by design citation; no open question.)
- **Tool surface:** mirror the `log_phase` write-tool template (session resolution + injection-seam deps
  for deterministic tests), not a new handler style.
- **Null-session policy:** `set_goal` throws (log_phase pattern); `get_goal` returns null (read_state pattern).

## Full-fix rationale (FULL-FIX, not a patch)

Proper typed persistent state + two first-class MCP tools wired through the lock-step
ToolHandlers/annotations/descriptions records (compile-enforced), atomic writes, fault-tolerant reads —
the designed FLOOR the rest of the subsystem builds on, to the same standard as existing tools (tests +
the server-list assertion updated). Not an ad-hoc blob or special-case branch.

## Design elements (the task set must cover 100% of these)

1. `src/runtime/goal_state.ts` — `GoalState` + `readGoalState`/`writeGoalState` (atomic, fault-tolerant).
2. `src/mcp/tools/set_goal.ts` — `SetGoalSchema` + `handleSetGoal` (mint-on-first, update-in-place).
3. `src/mcp/tools/get_goal.ts` — `handleGetGoal` (goal or null).
4. `src/mcp/server.ts` — wire both into ToolHandlers + toolAnnotations + descriptions.
5. Tests: `goal_state.test.ts`, `set_goal.test.ts`, `get_goal.test.ts`; update `server.test.ts` list.
6. CHANGELOG entry + patch version bump (current `package.json:version` = 0.5.492 → 0.5.493).

## Out of scope (explicit, not gaps)

- GS.2 default /goal summarizer, GS.3 pack-override, GS.4 coding-pack scanner, GS.5 completion=no-open-scope.
- Native harness `/goal` command + hook-injection surfaces (higher ladder rungs; the MCP floor is GS.1).
- server-instructions block (opensquid sets none today; the tool `descriptions` carry GS.1 guidance).

## Risks (carried into the spec)

- `server.test.ts` asserts the exact sorted tool list → must add `get_goal`/`set_goal` or it fails.
- Lock-step Records: a tool missing from `toolAnnotations`/`descriptions` fails typecheck.
- set_goal throws on null session vs get_goal returns null — intentional split (log_phase vs read_state).
- opensquid is a nested git repo gitignored inside loop — stage explicit paths, never `git add -A`.

## References

- wg-7e0290084eff (locked design); wg-9fa8edb13a84 (ordering); memory feedback-set-goal-before-work.
- `~/projects/loop/opensquid/src/mcp/server.ts`, `.../tools/log_phase.ts`, `.../tools/read-state.ts`,
  `.../runtime/phase_ledger.ts`, `.../runtime/paths.ts`, `.../runtime/atomic_write.ts`,
  `.../runtime/hooks/session_id.ts`.
- Task spec: `docs/tasks/T-goal-subsystem-gs1.md`.
