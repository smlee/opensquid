/**
 * T-handoff-nested-session-spam SUB.1 — opensquid-spawned reviewer subagents
 * (subscription_cli sets OPENSQUID_SUBAGENT=1 at the spawn boundary) must
 * never run the hook pipeline: no FSM mint, no tool-ledger, no SessionEnd
 * handoff dump, no nested cached_audit (the observed recursion class —
 * wg-627effbb2c38: a timed-out audit child re-ran the coding flow on the
 * artifact embedded in its prompt and spawned its own grandchild audit).
 *
 * Pure read of process.env — no I/O, no side effects. NOTE: this is the
 * HOOK-POLICY marker; the kill-tree marker (OPENSQUID_SUPERVISED, SUB.2) is
 * deliberately separate — agent-bridge children are supervised but fully
 * hooked (GDC lock: working agents stay gated).
 *
 * A SECOND, ORTHOGONAL marker lives here too (T-in-lap-gating, scope-1):
 * OPENSQUID_LOOP_LAP marks a ralph LAP. Unlike OPENSQUID_SUBAGENT it does NOT
 * silence hooks — a lap runs FULLY hooked (PreToolUse enforcement, stage_inject
 * injection, and the PostToolUse FSM write-through all fire). It is
 * recursion-ONLY: it blocks a lap from starting a NESTED loop (the `opensquid
 * loop` entrypoint guard) and suppresses the two genuinely-interactive bin
 * actions (the stop responder, the session-end handoff dump). It NEVER feeds
 * `exitIfSubagent`. Reviewers and laps have OPPOSITE hook policies (reviewer
 * silenced, lap hooked), so the two markers must NEVER be merged — the exact
 * `spawn_lifecycle.ts:30-37` orthogonal-marker idiom (cf. OPENSQUID_SUBAGENT
 * vs OPENSQUID_SUPERVISED).
 *
 * Imports from: (none — node globals only).
 * Imported by: the six hook bins (pre-tool-use, post-tool-use,
 *   session-start, session-end, stop, user-prompt-submit); the `opensquid loop`
 *   entrypoint + lap spawn (setup/cli/ralph.ts) + cli.ts (isLoopLap).
 */

export function isOpensquidSubagent(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENSQUID_SUBAGENT === '1';
}

/** The recursion-only ralph-lap marker env var — orthogonal to OPENSQUID_SUBAGENT (never merged). */
export const LOOP_LAP_ENV = 'OPENSQUID_LOOP_LAP';

/**
 * True in a ralph LAP process. A lap runs FULLY hooked (enforcement/injection/FSM all fire) — this marker is
 * recursion-only: it blocks a lap from starting a NESTED loop (the `opensquid loop` entrypoint guard) and
 * suppresses the two genuinely-interactive bin actions (stop responder, session-end handoff). It NEVER feeds
 * `exitIfSubagent` — that stays keyed ONLY on the reviewer-silencing OPENSQUID_SUBAGENT (:20). Orthogonal
 * markers, never merged (cf. OPENSQUID_SUBAGENT vs OPENSQUID_SUPERVISED, spawn_lifecycle.ts:30-37).
 */
export function isLoopLap(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LOOP_LAP_ENV] === '1';
}

/**
 * Exit-0 short-circuit for hook bins — called BEFORE stdin is read so a
 * marked child's hook performs zero reads and zero state writes. Exit 0 is
 * the "allow" code for every Claude Code hook type, so the ordering is safe
 * across all six bins. Returns only when NOT a subagent.
 */
export function exitIfSubagent(hookName: string): void {
  if (isOpensquidSubagent()) {
    process.stderr.write(`opensquid: ${hookName} skipped (OPENSQUID_SUBAGENT)\n`);
    process.exit(0);
  }
}
