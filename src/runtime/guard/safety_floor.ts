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
import { toolMatches } from '../../integrations/pi/tool_aliases.js';
import type { SafetyPolicy } from './safety_policy.js';

export type SafetyAction = Extract<Action, 'pass' | 'warn' | 'block' | 'halt'>;

export interface SafetyResult {
  action: SafetyAction;
  message?: string;
  /** The matched rule's id (or its argPattern when unnamed) — lets a `warn` be recorded as a typed drift. */
  ruleId?: string;
}

export interface SafetyCall {
  tool: string;
  args: unknown;
}

/**
 * Tier-downgrade options. The ONLY relaxation the floor permits: move the `dangerous` tier from `block` to
 * `warn` (the call PROCEEDS but is surfaced) when `dangerousToWarn` is set. The `hardline` tier is NEVER
 * affected — `rm -rf /`, substrate writes, `.env` exfil always `halt`, regardless of this option. Enforced
 * in code (below), not config, so a misconfigured policy or env can never relax a hardline rule.
 */
export interface SafetyOptions {
  dangerousToWarn?: boolean;
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
  if (call.tool === 'Bash') {
    return `${call.tool} ${str(a.command) || JSON.stringify(call.args ?? '')}`;
  }
  if (toolMatches(call.tool, /^(Write|Edit|NotebookEdit)$/)) {
    return `${call.tool} ${str(a.file_path)}`;
  }
  if (call.tool === 'Read') {
    return `${call.tool} ${str(a.file_path) || JSON.stringify(call.args ?? '')}`;
  }
  return `${call.tool} ${JSON.stringify(call.args ?? '')}`;
}

/**
 * Evaluate a tool call against the policy:
 *   ALLOW first (an explicitly-permitted action — e.g. the agent-authored `context.md` — is never denied),
 *   then forbid: hardline→halt (ALWAYS, even under yolo), dangerous→block — OR →warn when `dangerousToWarn`
 *   is set (yolo mode: the ONE downgrade the floor permits). Unmatched → pass (FAIL OPEN).
 *
 * The downgrade is structurally confined to the `dangerous` tier: `hardline` returns `halt` before the
 * downgrade branch is ever reached, so no option, config, or env can relax `rm -rf /`, substrate DELETE,
 * or `.env` exfil.
 */
export function checkSafety(
  call: SafetyCall,
  policy: SafetyPolicy,
  opts: SafetyOptions = {},
): SafetyResult {
  const hay = actionText(call); // the ACTION, not incidental content
  // ALLOW wins: an action on an explicitly-permitted path is never denied (checked before forbid).
  for (const a of policy.allow ?? []) {
    if (a.tool !== undefined && !toolMatches(call.tool, a.tool)) continue;
    if (hay.includes(a.argPattern)) return { action: 'pass' };
  }
  for (const r of policy.forbid) {
    if (r.tool !== undefined && !toolMatches(call.tool, r.tool)) continue;
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
    const ruleId = r.id ?? r.argPattern;
    if (r.tier === 'hardline') return { action: 'halt', message: r.message, ruleId }; // never downgradable
    // dangerous: the ONE tier yolo can move block→warn (the call then proceeds but is surfaced + recorded).
    return {
      action: opts.dangerousToWarn === true ? 'warn' : 'block',
      message: r.message,
      ruleId,
    };
  }
  return { action: 'pass' }; // FAIL OPEN — an unmatched call is never denied
}
