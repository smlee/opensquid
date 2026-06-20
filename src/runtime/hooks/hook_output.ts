/**
 * Hook-output helpers — the single place hook bins (pre-tool-use, stop,
 * user-prompt-submit) turn a `dispatchEvent` result into what Claude Code reads.
 *
 * Two concerns live here, both at the EMIT boundary (not in the dispatcher /
 * verdict layer, so skill YAML + dispatch internals stay clean):
 *   - the 🦑 squid marker on every user-facing drift/block message, and
 *   - the PreToolUse `permissionDecision:"deny"` envelope (T-RJ-FOLLOWUPS FU.11),
 *     which — unlike a bare `exit 2` — is honored under `--dangerously-skip-permissions`.
 */

export const SQUID = '🦑';

/**
 * Prefix a drift/block message with 🦑 so it's unmistakably opensquid speaking —
 * NOT the agent's own prose, NOT a chat message (chat replies via chat_send are
 * deliberately unprefixed). Idempotent; empty string passes through (nothing to
 * surface). Skill YAML `message:` fields stay clean — the marker is added here.
 */
export function squidPrefix(message: string): string {
  if (message.length === 0) return message;
  return message.trimStart().startsWith(SQUID) ? message : `${SQUID} ${message}`;
}

export interface PreToolUseDeny {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

/**
 * Build the PreToolUse deny envelope (squid-prefixed reason). Optional `guidance`
 * (the FC.2 forward map) is appended beneath the gate message so every block
 * points the agent FORWARD (current stage + next step), not just "no." Falls
 * back to a generic reason when none is given.
 */
export function buildPreToolUseDeny(reason: string, guidance?: string): PreToolUseDeny {
  const base = squidPrefix(reason.length > 0 ? reason : 'opensquid: blocked by a drift gate');
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        guidance !== undefined && guidance.length > 0 ? `${base}\n\n${guidance}` : base,
    },
  };
}

export interface PreToolUseContext {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'defer';
    additionalContext: string;
  };
}

/**
 * GI.5 — build the PreToolUse NON-BLOCKING context envelope (channel b of the per-gate push). Surfaces
 * `context` to the model as a system reminder BEFORE the tool runs, WITHOUT touching the permission
 * outcome: `permissionDecision: "defer"` ABSTAINS so the normal permission flow proceeds unchanged.
 *
 * Deliberately NOT `"allow"` (which the spec/work-graph first sketched): `allow` AUTO-APPROVES the tool
 * and bypasses the user's manual approval prompt, so emitting it on every non-deny tool call would
 * silently suppress all approvals for users not in bypassPermissions mode. `additionalContext` is
 * orthogonal to the decision, so `defer` carries the same context with zero permission side-effect.
 *
 * Returns null when there is nothing to surface (empty context) so the caller falls through to its
 * normal exit path (no spurious envelope). The injected bundle is NOT squid-prefixed — it is
 * instructional gate context, not a drift/block message (the 🦑 marker is reserved for those).
 */
export function buildPreToolUseContext(context: string): PreToolUseContext | null {
  if (context.length === 0) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'defer',
      additionalContext: context,
    },
  };
}

/**
 * The shared bin tail: surface a dispatch result's drift message on stderr
 * (squid-prefixed) and exit with its code. Used by stop + user-prompt-submit
 * (after any stdout envelope they emit) and by pre-tool-use's non-block path.
 * Returns `never` — it always exits.
 */
export function emitDriftStderrAndExit(exitCode: number, stderr: string): never {
  if (stderr.length > 0) process.stderr.write(squidPrefix(stderr) + '\n');
  process.exit(exitCode);
}
