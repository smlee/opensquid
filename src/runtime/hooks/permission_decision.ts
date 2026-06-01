/**
 * PreToolUse permission-decision envelope (T-RJ-FOLLOWUPS FU.11).
 *
 * A PreToolUse hook signals a block in one of two ways:
 *   - `exit 2` — the simple path, BUT `--dangerously-skip-permissions`
 *     (= `bypassPermissions` mode) silently IGNORES it (proven live: a
 *     `git commit` the gate should block ran anyway).
 *   - a `permissionDecision: "deny"` JSON envelope on stdout (exit 0) — HONORED
 *     even under `bypassPermissions` (proven live: the call was denied).
 *
 * So opensquid emits the JSON envelope on every block, making drift gates
 * enforce in BOTH normal and bypass permission modes. Pure builder so the shape
 * is unit-testable without spawning the hook bin.
 */

export interface PreToolUseDeny {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

/** Build the deny envelope; falls back to a generic reason when none is given. */
export function buildPreToolUseDeny(reason: string): PreToolUseDeny {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason.length > 0 ? reason : 'opensquid: blocked by a drift gate',
    },
  };
}
