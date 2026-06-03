# Track T-ACTIVE-TASK-CLEAR — clear a completed task's active-task signal

**Pre-research:** `docs/research/T-active-task-clear-pre-research-2026-06-03.md`
(empirically confirmed: FC.4's `active-task.json` persisted after completion; the ATM.3
defensive-keep preserves a finished task's signal forever — no recovery path).

### Task FC.6: Keep the active-task signal only on genuine transcript lag, not after completion

**Required skills:** opensquid runtime / session-state expert; Claude Code transcript-parsing expert; Race-condition / idempotent-hook expert; Vitest fixtures expert; Audit / code review expert

**Deliverable:** after a task is `completed`/`deleted`, the next PreToolUse re-mirror clears `active-task.json` (so `has_generated_spec` → `generated:false` between tasks), while a genuinely just-activated task whose transcript hasn't caught up is still KEPT. The decision is driven by the prior task's actual transcript status, not the `completingId` heuristic.

**Depends on:** None (refines existing ATM.3 / T-ACTRACE.1 logic).

**Files affected:**

- `src/runtime/hooks/transcript_tasks.ts` (modify) — export a status helper over the existing walk.
- `src/runtime/hooks/active_task_mirror.ts` (modify) — replace the keep heuristic in both the transcript path and the store path.
- `src/runtime/hooks/active_task_mirror.test.ts` (modify) — add completed-prior-clears cases; keep the lag-keep case green.

**Key code shapes:**

```ts
// transcript_tasks.ts — thin reuse of parseTranscriptTasks (no second walk semantics).
export async function transcriptTaskStatus(
  transcriptPath: string,
  id: string,
  pending?: PendingUpdate,
): Promise<string | null> {
  const { taskById } = await parseTranscriptTasks(transcriptPath, pending);
  return taskById.get(id)?.status ?? null;
}
// CLOSED, not open: a genuine lag leaves the prior ABSENT from the transcript
// (status null) — `isOpenStatus(null)` would be false and wrongly clear it, breaking
// ATM.3. Keep unless EXPLICITLY closed (null/open → keep; completed/deleted → clear).
export const isClosedStatus = (s: string | null): boolean => s === 'completed' || s === 'deleted';
```

```ts
// active_task_mirror.ts — transcript path, replacing the `prior.id !== completingId`
// keep guard (was lines ~160-172). The prior's transcript status (with the in-flight
// TaskUpdate overlaid) distinguishes genuine lag from a real completion.
const prior = await readActiveTask(sessionId);
if (prior !== null) {
  const priorStatus = await transcriptTaskStatus(transcriptPath, prior.id, pending);
  if (!isClosedStatus(priorStatus)) return; // lag (null) or still open → keep
}
await clearActiveTask(sessionId); // prior explicitly completed/deleted → clear (FC.6)
return;
```

```ts
// active_task_mirror.ts — store path (older CC), same blind spot at line ~228:
// keep ONLY if the prior is present AND still open, not present at ANY status.
if (
  prior !== null &&
  prior.id !== completingId &&
  tasks.some((t) => t.id === prior.id && !isClosedStatus(t.status))
) {
  return; // transient mid-write of an open task — keep
}
```

**Test fixtures:** a transcript JSONL with TaskCreate(→#24) + TaskUpdate(24,in_progress) + TaskUpdate(24,completed); a pre-existing `active-task.json` for id 24; invoke `mirrorActiveTask` with a non-`TaskUpdate` tool (e.g. `Bash`) and `pending=undefined`. Lag fixture: same but transcript ends at `in_progress` (no completed record), `pending=undefined`.

**Acceptance criteria:**

- [ ] completed prior + non-TaskUpdate tool → `active-task.json` is CLEARED (currently fails: it persists)
- [ ] `active_task_mirror.test.ts:349` lag-keep stays GREEN (prior still in_progress in transcript → kept)
- [ ] store-path: prior present at `completed` → cleared; prior present at `in_progress` → kept
- [ ] full suite + tsc clean

**Risk callouts:** must NOT regress the ATM.3 lag-keep (that race re-introduces the "log_phase: no active task" failure). The discriminator is precisely the prior's transcript status WITH the `pending` overlay — at the completing tick the overlay marks it completed (clear), on a true lag the transcript shows the prior absent (null) or still open (keep) — only an explicit completed/deleted clears. Reuse `parseTranscriptTasks` — do not fork the walk.

**References:** `src/runtime/hooks/active_task_mirror.ts:160-173` (transcript keep), `:200-236` (store keep), `src/runtime/hooks/transcript_tasks.ts:142-157` (activeId nulling on completion), `active_task_mirror.test.ts:330-360` (ATM.3 suite).

**Verification commands:** `npx vitest run src/runtime/hooks/active_task_mirror.test.ts src/runtime/hooks/transcript_tasks.test.ts && npx vitest run && npx tsc -p tsconfig.build.json --noEmit`.

**7-phase steps:** 1 pre-research: DONE (the transcript-lag vs completion distinction). 2 learn: lock the `isOpenStatus(transcriptTaskStatus(...))` discriminator. 3 code: helper + both keep-branch replacements. 4 test: add completed-clears cases, keep lag-keep green, full suite. 5 audit: confirm no ATM.3 regression + `has_generated_spec` now flips false post-completion. 6 post-research: n/a. 7 fix.
