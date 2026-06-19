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

/**
 * The ACTION-relevant text to match against — NOT the whole stringified args. Matching everything
 * conflates the dangerous ACTION with incidental CONTENT: a `Write`/`Edit` whose BODY merely mentions
 * `~/.opensquid/...` or `rm -rf /` (a doc, a test, a memory) is not performing that action. So:
 *   - Bash  → the command string (where the dangerous action lives).
 *   - Write/Edit → the TARGET file_path only (writing INTO a path is the action; the content is not).
 *   - Read  → the file_path (reading a path is the action).
 *   - other → fall back to the stringified args.
 */
function actionText(call: SafetyCall): string {
  const a = (call.args ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  switch (call.tool) {
    case 'Bash':
      return `${call.tool} ${str(a.command) || JSON.stringify(call.args ?? '')}`;
    case 'Write':
    case 'Edit':
      return `${call.tool} ${str(a.file_path)}`;
    case 'Read':
      return `${call.tool} ${str(a.file_path) || JSON.stringify(call.args ?? '')}`;
    default:
      return `${call.tool} ${JSON.stringify(call.args ?? '')}`;
  }
}

/** Evaluate a tool call against the policy: hardline→halt, dangerous→block, else pass (fail-open). */
export function checkSafety(call: SafetyCall, policy: SafetyPolicy): SafetyResult {
  const hay = actionText(call); // the ACTION, not incidental content
  for (const r of policy.forbid) {
    if (r.tool !== undefined && r.tool !== call.tool) continue;
    if (!hay.includes(r.argPattern)) continue; // exact/substring/path rule — never a heuristic
    // optional refinement so a substring only fires in its dangerous form (avoids false-denies):
    if (r.match === 'pipe_to_shell' && !/\|\s*(sh|bash)\b/.test(hay)) continue; // needs `| sh`/`| bash`
    if (
      r.match === 'delete_verb' &&
      !/\b(rm|unlink|shred|truncate)\b/.test(hay) &&
      // a redirect whose TARGET is a substrate path. The load-bearing condition is the TARGET, not what
      // precedes `>`: any redirect (`>`, `>>`, or fd-prefixed `2>`/`2>>`) that truncates a `.opensquid`
      // file is destructive, while `2>/dev/null`, `>/dev/null`, and `2>&1` target non-substrate and never
      // match. Requiring the target excludes the benign-read false-positive WITHOUT the previous
      // `(^|\s)` anchor, which wrongly let a no-space overwrite (`cmd>~/.opensquid/x`) slip past.
      !/>>?\s*[^\s|;&<>]*\.opensquid/.test(hay)
    )
      continue; // needs a delete verb or a substrate-TARGETED redirect
    return { action: r.tier === 'hardline' ? 'halt' : 'block', message: r.message };
  }
  return { action: 'pass' }; // FAIL OPEN — an unmatched call is never denied
}
