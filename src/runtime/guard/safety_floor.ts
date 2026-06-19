/**
 * T2 — the Safety floor (T-fsm-actor-rescope §T2).
 *
 * The substrate's SAFETY floor: an absolute policy of forbidden actions, checked BEFORE a tool runs
 * (wired into `pre-tool-use.ts`) so a match DENIES the call rather than detecting it after the fact.
 * STATELESS — a forbidden action is forbidden on its FIRST occurrence, not after a threshold — so there
 * is no `*_state.ts`; it is a pure function over (call, policy).
 *
 * A HARDLINE match → `halt` (absolute); a DANGEROUS match → `block`; otherwise `pass` (FAIL OPEN — the
 * floor never denies an unmatched call). The policy is config-driven (`safety_policy.ts`); the `match`
 * refinement keeps a path/command substring from over-matching its benign form.
 */
import type { Action } from '../gate/kernel.js';
import type { SafetyPolicy } from './safety_policy.js';

export type SafetyAction = Extract<Action, 'pass' | 'block' | 'halt'>;

export interface SafetyResult {
  action: SafetyAction;
  message?: string;
}

export interface SafetyCall {
  tool: string;
  args: unknown;
}

/** Evaluate a tool call against the policy: hardline→halt, dangerous→block, else pass (fail-open). */
export function checkSafety(call: SafetyCall, policy: SafetyPolicy): SafetyResult {
  const hay = `${call.tool} ${JSON.stringify(call.args ?? '')}`;
  for (const r of policy.forbid) {
    if (r.tool !== undefined && r.tool !== call.tool) continue;
    if (!hay.includes(r.argPattern)) continue; // exact/substring/path rule — never a heuristic
    // optional refinement so a substring only fires in its dangerous form (avoids false-denies):
    if (r.match === 'pipe_to_shell' && !/\|\s*(sh|bash)\b/.test(hay)) continue; // needs `| sh`/`| bash`
    if (
      r.match === 'delete_verb' &&
      !/\b(rm|unlink|shred|truncate)\b/.test(hay) &&
      // a SHELL REDIRECT to a path (`> ~/…`, `>/dev/…`) — NOT a `->` arrow (which prose/code uses):
      // require `>` reached after a space/word-char and pointing at a path, so `-> halt` does not match.
      !/(^|[\s\w])>\s*[~/.]/.test(hay)
    )
      continue; // needs a delete verb or a real path-redirect
    return { action: r.tier === 'hardline' ? 'halt' : 'block', message: r.message };
  }
  return { action: 'pass' }; // FAIL OPEN — an unmatched call is never denied
}
