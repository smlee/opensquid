# FC follow-ups — backlog (un-specced)

These were surfaced 2026-06-03 while proving the coding-flow gates enforce (the
PostToolUse/SessionStart stale-settings investigation). They are NOT yet on the formal
task list: `taskcreate-spec-required` (correctly) blocks un-specced TaskCreate. Each
graduates to a task once it has a `docs/tasks/T-*.md` spec (pre-research → spec-author).

## FC.5 — `opensquid doctor`: detect stale/missing hook registrations

**Problem:** a stale `~/.claude/settings.json` silently disabled whole enforcement
classes (PostToolUse → FSM phase-advance dead; SessionStart → handoff enforcement dead),
discovered only by suspicion. `doctor` should catch it.

**Shape:** in the `doctor` command, read `~/.claude/settings.json` (+ project settings),
and for each event in `OPENSQUID_BIN_FOR_EVENT` (the 6 keys in
`src/setup/wizard/settings-writer.ts`): (a) assert a hook group exists carrying the
`@opensquid` marker, and (b) assert the bin (`opensquid-hook-*`) resolves on PATH
(`which`/`fs.existsSync` on the nvm bin dir). WARN/FAIL with the exact remediation:
`opensquid setup wizard hooks`.

**Files:** `src/setup/cli/doctor.ts` (the check), `src/setup/wizard/settings-writer.ts`
(reuse `OPENSQUID_BIN_FOR_EVENT` + the `@opensquid` marker recognition).

## FC.6 — Clear `active-task.json` on task completion

**Problem:** `TaskUpdate(status=completed)` does NOT clear the session
`active-task.json`. FC.4 lingered as "active" after completion, so the prior task's scope
persists between tasks — a stray code write could ride a completed task's spec
(`has_generated_spec.generated == true` off a done task), weakening the per-write gate.

**Shape:** on the task-completed transition, clear (or mark inactive) the session
`active-task.json` so `has_generated_spec` returns `generated:false` between tasks,
forcing a fresh scope/activation before the next code write.

**Files:** the TaskUpdate/completion handler that writes `active-task.json`
(`src/runtime/hooks/active_task_mirror.ts` or the session-state writer); `has_active_task`
/ `has_generated_spec` in `src/functions/active_task.ts` (consumers — no change expected).
