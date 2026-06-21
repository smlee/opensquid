# T-goal-subsystem GS.1 — persistent goal + MCP set_goal/get_goal floor

**Scope:** Per wg-7e0290084eff (locked design) + `docs/research/T-goal-subsystem-gs1-pre-research-2026-06-20.md`.
The MCP floor of the goal-subsystem: structured per-session goal state + `set_goal`/`get_goal` tools, in the
opensquid repo (`~/projects/loop/opensquid`). GS.4 scanner + GS.5 completion are later layers.
**Tasks:** 1 (GS.1)
**Cross-references:** wg-7e0290084eff; wg-9fa8edb13a84 (0.6.x ordering); memory feedback-set-goal-before-work.

---

### Task GS.1: persistent goal state + MCP set_goal/get_goal

**Required skills:** MCP tool design expert (@modelcontextprotocol/sdk, TS); Zod schema design expert; per-session filesystem state design expert (atomic write, fault-tolerant read); vitest expert
**Deliverable:** `set_goal`/`get_goal` MCP tools backed by `runtime/goal_state.ts` persisting one goal per session at `sessions/<id>/state/goal.json`, registered + live in `src/mcp/server.ts`; full pnpm gate chain green.
**Depends on:** existing `src/mcp/server.ts` ToolHandlers; `runtime/{paths,atomic_write,session_state,phase_ledger}.ts`; `runtime/hooks/session_id.ts`. (All in `~/projects/loop/opensquid`.)

**Files affected:**

- `src/runtime/goal_state.ts` (new) — GoalState type + read/write
- `src/runtime/goal_state.test.ts` (new)
- `src/mcp/tools/set_goal.ts` (new) — SetGoalSchema + handleSetGoal
- `src/mcp/tools/get_goal.ts` (new) — handleGetGoal
- `src/mcp/tools/set_goal.test.ts` (new) · `src/mcp/tools/get_goal.test.ts` (new)
- `src/mcp/server.ts` (modify) — wire both into ToolHandlers + toolAnnotations + descriptions (lock-step)
- `src/mcp/server.test.ts` (modify) — add get_goal/set_goal to the asserted sorted tool list
- `CHANGELOG.md` (modify) + `package.json` (modify) — 0.5.492 → 0.5.493

**Key code shapes:**

```ts
// src/runtime/goal_state.ts
export type GoalStatus = 'active' | 'completed' | 'cancelled';
export interface GoalState { id: string; text: string; status: GoalStatus; createdAt: string; updatedAt: string; }
export const GOAL_STATE_KEY = 'goal';
function isGoalState(v: unknown): v is GoalState {
  if (v === null || typeof v !== 'object') return false;
  const g = v as Record<string, unknown>;
  return typeof g.id === 'string' && typeof g.text === 'string' &&
    (g.status === 'active' || g.status === 'completed' || g.status === 'cancelled') &&
    typeof g.createdAt === 'string' && typeof g.updatedAt === 'string';
}
export async function readGoalState(sessionId: string): Promise<GoalState | null> {
  try { const raw = await readFile(sessionStateFile(sessionId, GOAL_STATE_KEY), 'utf8');
    const parsed = JSON.parse(raw) as unknown; return isGoalState(parsed) ? parsed : null; } catch { return null; }
}
export async function writeGoalState(sessionId: string, goal: GoalState): Promise<void> {
  await atomicWriteFile(sessionStateFile(sessionId, GOAL_STATE_KEY), JSON.stringify(goal, null, 2));
}

// src/mcp/tools/set_goal.ts — status OPTIONAL so a text-only update PRESERVES a completed/cancelled goal
export const SetGoalSchema = z.object({
  text: z.string().min(1).max(500),
  status: z.enum(['active','completed','cancelled']).optional(),
});
export async function handleSetGoal(args: SetGoalArgs, deps: { now?: () => string; genId?: () => string } = {}): Promise<GoalState> {
  const sessionId = await resolveMcpSessionId();
  if (sessionId === null) throw new Error('set_goal: cannot resolve session — no CLAUDE_SESSION_ID / OPENSQUID_SESSION_ID env and .current-session absent.');
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const existing = await readGoalState(sessionId);
  const goal: GoalState = existing
    ? { ...existing, text: args.text, status: args.status ?? existing.status, updatedAt: now } // omitted status PRESERVES existing
    : { id: (deps.genId ?? (() => `goal-${randomBytes(8).toString('hex')}`))(), text: args.text, status: args.status ?? 'active', createdAt: now, updatedAt: now };
  await writeGoalState(sessionId, goal); return goal;
}

// src/mcp/tools/get_goal.ts
export async function handleGetGoal(): Promise<GoalState | null> {
  const s = await resolveMcpSessionId(); return s === null ? null : readGoalState(s);
}

// src/mcp/server.ts — lock-step wiring + the exact description copy (the GS.1 automation guidance)
set_goal: { schema: SetGoalSchema, handle: (a: SetGoalArgs) => handleSetGoal(a).then((r) => JSON.stringify(r)) },
get_goal: { schema: z.object({}), handle: () => handleGetGoal().then((r) => JSON.stringify(r)) },
// toolAnnotations:  set_goal: LOCAL_WRITE,  get_goal: READ_ONLY
// descriptions:
//   set_goal: "Set or update this session's goal (what must be completed before the work is done). " +
//             "Persists across turns; omitting status preserves the existing status. " +
//             "Returns {id, text, status, createdAt, updatedAt}."
//   get_goal: "Get this session's current goal, or null if unset."
// Lifecycle (GS.1): NO automatic transitions — set_goal is the only writer; status is whatever is
// explicitly passed (omitted → preserved on update, 'active' on create). GS.5 adds completion logic.
```

**Test fixtures:**

- readGoalState(unset) → null; write→read round-trip; malformed JSON → null; shape mismatch → null
- handleSetGoal first set (deps fixed now/genId) → {id:'goal-fixed', createdAt==updatedAt}; second set with explicit status → keeps id+createdAt, bumps updatedAt, new text/status
- handleSetGoal update with status OMITTED → text changes, **status preserved** (regression guard for the default-reset bug); first-create with omitted status → 'active'
- handleSetGoal with no resolvable session → throws /cannot resolve session/
- handleGetGoal no session → null; after set → returns the goal
- server.test.ts tool list includes get_goal + set_goal (sorted)

**Acceptance criteria:**

- [ ] set_goal (LOCAL_WRITE) + get_goal (READ_ONLY) present in ToolHandlers + toolAnnotations + descriptions, surfaced in tools/list (live path: registered in the running MCP server)
- [ ] goal persists at sessions/<id>/state/goal.json (atomic); reads fault-tolerant (→ null)
- [ ] `status` is OPTIONAL on set_goal; an omitted-status update PRESERVES the existing status (tested regression guard); descriptions non-empty and set_goal's states status-preservation
- [ ] server.test.ts asserted tool list updated; full vitest suite passes
- [ ] pnpm typecheck && lint && test && build && format:check all green

**Risk callouts:**

- server.test.ts asserts the exact sorted tool list — add get_goal/set_goal or it fails (compile-/test-enforced).
- Lock-step Records: a tool missing from toolAnnotations/descriptions fails typecheck (`Record<ToolName,…>`).
- set_goal throws on null session (log_phase pattern); get_goal returns null (read_state pattern) — intentional split.
- opensquid is a nested git repo gitignored inside loop — stage explicit paths, never `git add -A`.

**References:**

- wg-7e0290084eff (locked design); `docs/research/T-goal-subsystem-gs1-pre-research-2026-06-20.md`
- `~/projects/loop/opensquid/src/mcp/tools/log_phase.ts`; `.../tools/read-state.ts`; `.../runtime/phase_ledger.ts`

**Verification commands:**

```bash
cd ~/projects/loop/opensquid && pnpm typecheck && pnpm lint && pnpm test -- run && pnpm build && pnpm format:check
```

**7-phase steps:**

1. **pre-research:** Read server.ts ToolHandlers/annotations/descriptions, log_phase + read-state tools, phase_ledger, session_state, paths, atomic_write, session_id. (Done — pre-research doc.)
2. **learn:** Lock GoalState shape {id,text,status,createdAt,updatedAt}; null-session split (throw vs null); state key 'goal'.
3. **code:** goal_state.ts → set_goal.ts → get_goal.ts → wire server.ts (ToolHandlers/annotations/descriptions).
4. **test:** goal_state/set_goal/get_goal vitest + update server.test.ts sorted tool list.
5. **audit:** pnpm typecheck/lint/build/format:check green; CHANGELOG 0.5.493 + package.json bump.
6. **post-research:** confirm parity with phase_ledger (typed atomic state) + log_phase/read_state (session resolution).
7. **fix:** prettier-write goal_state.ts; add get_goal/set_goal to server.test.ts's asserted list.
