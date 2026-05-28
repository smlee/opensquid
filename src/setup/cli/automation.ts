/**
 * `opensquid automation on|off|status` CLI verb group (G.12).
 *
 * Thin wrapper around the `runtime/automation_state.ts` flag-file helpers.
 * The flag at `~/.opensquid/sessions/<session-id>/automation.flag` is the
 * canonical signal for "is this session in an automation loop?"; the
 * `is_automation_mode` primitive reads it (OR'd with `OPENSQUID_AUTOMATION=1`)
 * to gate skills like `d9-guard`.
 *
 * Session-id resolution (Phase-2 lock #5):
 *   1. `--session-id <id>` flag (explicit override)              source: 'flag'
 *   2. `OPENSQUID_SESSION_ID` env var                             source: 'env'
 *   3. `.current-session` pointer (UserPromptSubmit hook writes)  source: 'pointer'
 *   4. fresh `randomUUID()` — printed to stderr so the user can   source: 'random'
 *      paste it into a follow-up `status` / `off` call.
 *
 * ASG.2 plausibility gate: only `source === 'pointer'` is gated. The pointer
 * can go stale (a leaky test or contamination), so the CLI cross-checks that
 * `sessions/<id>/active-task.json` or `state/tool-ledger.json` was modified
 * within `OPENSQUID_SESSION_FRESH_MS` (default 30min). Stale ⇒ refuse +
 * `process.exitCode = 2` unless `--force`. See `runtime/hooks/session_liveness.ts`.
 *
 * Exit codes:
 *   - `on` / `off`     — 0 (idempotent), or 2 if the pointer's stale
 *   - `status`         — 0 if any signal is on, 1 if completely off, 2 if the
 *                        pointer's stale (gate fires before on/off check)
 *
 * Imports from: node:crypto, commander, ../../runtime/automation_state.js.
 * Imported by: src/cli.ts.
 */

import { randomUUID } from 'node:crypto';

import {
  automationFlagPath,
  clearAutomationFlag,
  isAutomationFlagSet,
  setAutomationFlag,
} from '../../runtime/automation_state.js';
import { readCurrentSession } from '../../runtime/hooks/session_id.js';
import {
  isSessionPlausible,
  type PlausibilityResult,
} from '../../runtime/hooks/session_liveness.js';

import type { Command } from 'commander';

export interface AutomationCliDeps {
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  randomSessionId?: () => string;
  /** Reads the live-session pointer written by the UserPromptSubmit hook. */
  readCurrentSession?: () => Promise<string | null>;
  /**
   * Plausibility probe — default: the real `isSessionPlausible` over the
   * filesystem. Tests inject a stub so they don't depend on real fs mtimes.
   */
  isSessionPlausible?: (sid: string) => Promise<PlausibilityResult>;
}

interface Resolved {
  out: (s: string) => void;
  err: (s: string) => void;
  randomSessionId: () => string;
  readCurrentSession: () => Promise<string | null>;
  isSessionPlausible: (sid: string) => Promise<PlausibilityResult>;
}

interface VerbOpts {
  sessionId?: string;
  /** Bypass the stale-pointer plausibility gate (ASG.2). Emits a stderr ⚠. */
  force?: boolean;
}

/** Source the resolved session id came from — drives whether the gate fires. */
type ResolvedSource = 'flag' | 'env' | 'pointer' | 'random';

interface ResolvedSid {
  sid: string;
  source: ResolvedSource;
}

function buildDeps(d: AutomationCliDeps): Resolved {
  return {
    out: d.stdout ?? ((s: string): void => void process.stdout.write(s)),
    err: d.stderr ?? ((s: string): void => void process.stderr.write(s)),
    randomSessionId: d.randomSessionId ?? ((): string => randomUUID()),
    readCurrentSession: d.readCurrentSession ?? readCurrentSession,
    isSessionPlausible: d.isSessionPlausible ?? ((sid: string) => isSessionPlausible(sid)),
  };
}

/**
 * Resolution precedence: `--session-id` → `OPENSQUID_SESSION_ID` →
 * `.current-session` (recorded each turn by the UserPromptSubmit hook, so the
 * CLI targets the session the hooks actually key on) → a fresh random id.
 *
 * Returns the source as well so {@link gateOrFail} can gate ONLY the
 * pointer-derived path (the only stale-prone source). Explicit `--session-id`
 * and `OPENSQUID_SESSION_ID` are user/wrapper intent; a fresh random id
 * obviously has no state yet — none of those need the plausibility check.
 */
async function resolveSessionId(opts: VerbOpts, r: Resolved): Promise<ResolvedSid> {
  if (opts.sessionId !== undefined && opts.sessionId !== '') {
    return { sid: opts.sessionId, source: 'flag' };
  }
  const envId = process.env.OPENSQUID_SESSION_ID;
  if (envId !== undefined && envId !== '') return { sid: envId, source: 'env' };
  const current = await r.readCurrentSession();
  if (current !== null && current !== '') return { sid: current, source: 'pointer' };
  const fresh = r.randomSessionId();
  r.err(
    `opensquid automation: no --session-id, OPENSQUID_SESSION_ID, or live session pointer; using ${fresh}\n`,
  );
  return { sid: fresh, source: 'random' };
}

/**
 * ASG.2 plausibility gate. Returns `true` to proceed with the verb's side
 * effect; `false` to abort (caller returns early). Sets `process.exitCode = 2`
 * on rejection — distinct from `status`'s `exit 1` ("automation off"), so
 * wrappers can tell "the gate refused" apart from "automation is off."
 *
 * Only `source === 'pointer'` is gated. `--force` bypasses with a stderr ⚠
 * note (the audit trail for an intentional bypass).
 */
async function gateOrFail(resolved: ResolvedSid, opts: VerbOpts, r: Resolved): Promise<boolean> {
  if (resolved.source !== 'pointer') return true;
  if (opts.force === true) {
    r.err(
      `opensquid automation: ⚠ --force bypass for session id '${resolved.sid}' ` +
        `from .current-session pointer (no recent activity)\n`,
    );
    return true;
  }
  const probe = await r.isSessionPlausible(resolved.sid);
  if (probe.plausible) return true;

  const mtimeStr =
    probe.newestMtimeMs === null ? 'absent' : new Date(probe.newestMtimeMs).toISOString();
  r.err(
    `opensquid automation: refusing to act on implausible session id ` +
      `'${resolved.sid}' from .current-session pointer.\n` +
      `  no recent activity in ${probe.probedFiles.join(' or ')} ` +
      `(newest mtime: ${mtimeStr}).\n` +
      `  this usually means the pointer was overwritten by a leaky test ` +
      `or stale state.\n` +
      `  pass --force to bypass, or pass --session-id <real-id> explicitly.\n`,
  );
  process.exitCode = 2;
  return false;
}

async function actOn(r: Resolved, opts: VerbOpts): Promise<void> {
  const resolved = await resolveSessionId(opts, r);
  if (!(await gateOrFail(resolved, opts, r))) return;
  await setAutomationFlag(resolved.sid);
  r.out(`automation: on (${automationFlagPath(resolved.sid)})\n`);
}

async function actOff(r: Resolved, opts: VerbOpts): Promise<void> {
  const resolved = await resolveSessionId(opts, r);
  if (!(await gateOrFail(resolved, opts, r))) return;
  await clearAutomationFlag(resolved.sid);
  r.out(`automation: off (${automationFlagPath(resolved.sid)})\n`);
}

async function actStatus(r: Resolved, opts: VerbOpts): Promise<void> {
  const resolved = await resolveSessionId(opts, r);
  if (!(await gateOrFail(resolved, opts, r))) return;
  const sid = resolved.sid;
  if (process.env.OPENSQUID_AUTOMATION === '1') {
    r.out(`automation: on (source=env OPENSQUID_AUTOMATION=1)\n`);
    return;
  }
  if (await isAutomationFlagSet(sid)) {
    r.out(`automation: on (source=flag ${automationFlagPath(sid)})\n`);
    return;
  }
  r.out(`automation: off (no env var, no flag at ${automationFlagPath(sid)})\n`);
  process.exitCode = 1;
}

const SID_FLAG = '--session-id <id>';
const SID_DESC = 'session id (default: $OPENSQUID_SESSION_ID, else random uuid)';
const FORCE_FLAG = '--force';
const FORCE_DESC = 'bypass the .current-session plausibility check (writes anyway with a stderr ⚠)';

/** Register `opensquid automation` on the parent program. */
export function registerAutomation(parent: Command, deps: AutomationCliDeps = {}): Command {
  const r = buildDeps(deps);
  const c = parent
    .command('automation')
    .description('Toggle the session automation-mode flag (gates skills like d9-guard)');
  c.command('on')
    .description('Set the automation flag for this session')
    .option(SID_FLAG, SID_DESC)
    .option(FORCE_FLAG, FORCE_DESC, false)
    .action((opts: VerbOpts) => actOn(r, opts));
  c.command('off')
    .description('Clear the automation flag for this session')
    .option(SID_FLAG, SID_DESC)
    .option(FORCE_FLAG, FORCE_DESC, false)
    .action((opts: VerbOpts) => actOff(r, opts));
  c.command('status')
    .description('Report automation flag state (exit 0 = on, 1 = off, 2 = stale pointer)')
    .option(SID_FLAG, SID_DESC)
    .option(FORCE_FLAG, FORCE_DESC, false)
    .action((opts: VerbOpts) => actStatus(r, opts));
  return c;
}
