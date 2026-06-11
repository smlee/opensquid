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
 * Imports from: (none — node globals only).
 * Imported by: the six hook bins (pre-tool-use, post-tool-use,
 *   session-start, session-end, stop, user-prompt-submit).
 */

export function isOpensquidSubagent(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENSQUID_SUBAGENT === '1';
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
