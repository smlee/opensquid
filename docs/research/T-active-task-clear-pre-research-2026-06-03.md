# Pre-research — FC.6: clear a COMPLETED task's active-task.json (no stale-scope linger)

**Date:** 2026-06-03. **Repo:** opensquid. **Trigger:** found while proving the gates
enforce — `active-task.json` held FC.4 _after_ completion, so `has_generated_spec` kept
returning `generated:true` off a done task, weakening the per-write scope gate (a stray
code write could ride a completed task's spec). **Research this turn:** `recall` (active-
task / completion discipline), Read of `session_state.ts:160-240`,
`active_task_mirror.ts` (full), `transcript_tasks.ts` (full); grep of the mirror test.

## 1. Empirical confirmation (not theory)

This session (`94c113a3…`) `active-task.json` STILL holds `{id:24, taskId:FC.4}` after
FC.4 was marked `completed` — and despite dozens of PreToolUse re-mirrors since, it has
never cleared. So the gap is real and has **no recovery path**: once the signal is stale,
it stays stale until a new task activates or SessionEnd archives it.

## 2. Root cause (verified, file:line)

The mirror (`active_task_mirror.ts::mirrorActiveTask`) re-derives `active-task.json` from
the session transcript on EVERY PreToolUse. `transcript_tasks.ts::parseTranscriptTasks`
correctly nulls `activeId` when the active task is `completed`/`deleted` (line 152-154),
so `readActiveTaskFromTranscript` returns `null` after completion.

But the transcript-path **defensive-keep** (ATM.3, `active_task_mirror.ts:160-173`) fires
on every subsequent non-`TaskUpdate` tool:

- `completingId = null` (tool isn't `TaskUpdate(completed/deleted)`)
- `active = null` (transcript shows the task completed)
- `prior = readActiveTask()` = the stale FC.4 signal
- guard `if (prior !== null && prior.id !== completingId) return;` → `"24" !== null` →
  **TRUE → keep**.

That guard was built to protect a _just-activated_ task during transcript lag (test
`active_task_mirror.test.ts:349` "KEEPS a just-set active task when the transcript lags").
But its predicate (`prior.id !== completingId`) cannot tell **"transcript hasn't caught up
yet, prior still open there"** from **"transcript shows prior is genuinely completed."**
So it preserves a finished task's signal forever.

## 3. Fix design (derived)

Make the keep/clear decision on the prior task's **actual transcript status**, not the
`completingId` heuristic. `parseTranscriptTasks` already computes `taskById` (latest
status per id). Expose it so the mirror can ask: is `prior.id` still OPEN
(`pending`/`in_progress`) in the transcript?

- prior still open in transcript → genuine lag → **keep** (preserves the ATM.3 fix).
- prior `completed`/`deleted`/absent in transcript → **clear** (the FC.6 fix; gives the
  missing recovery path).

Shape: add a helper `transcriptTaskStatus(transcriptPath, id, pending?) → string | null`
(thin wrapper over `parseTranscriptTasks` reusing the existing walk), and in the
transcript-path keep branch replace `prior.id !== completingId` with
`isOpen(await transcriptTaskStatus(transcriptPath, prior.id, pending))`. The store-path
keep (line 228, `tasks.some(t.id === prior.id)`) is already status-aware-ish but has the
same blind spot (keeps if present at ANY status) — apply the same open-only check there.

## 4. Test impact (acknowledged)

- KEEP green: `active_task_mirror.test.ts:349` (lag-keep) — prior still `in_progress` in
  transcript → still keeps.
- NEW case: prior `completed` in transcript + a non-`TaskUpdate` tool → **clears** (the
  bug, currently failing-by-absence). Mirror of the existing H4a/L1 clear cases.
- Store-path: add prior-present-but-`completed` → clears (today it keeps).

## 5. Open questions — none that block.

Strictness is intended: between tasks, `has_generated_spec` MUST read `generated:false`
so the next code write re-scopes. Keeping a lag-window for a genuinely-activating task is
the only reason to ever keep on `active===null`, and that window is identifiable by the
prior's transcript status.
