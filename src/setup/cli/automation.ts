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
 *   1. `--session-id <id>` flag (explicit override)
 *   2. `OPENSQUID_SESSION_ID` env var
 *   3. fresh `randomUUID()` for ad-hoc terminal testing — printed to stderr
 *      so the user can paste it into a follow-up `status` / `off` call.
 *
 * Exit codes:
 *   - `on`     — 0 (idempotent set)
 *   - `off`    — 0 (idempotent clear)
 *   - `status` — 0 if any signal is on, 1 if completely off, so wrappers can
 *                `if opensquid automation status >/dev/null; then ...`.
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

import type { Command } from 'commander';

export interface AutomationCliDeps {
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  randomSessionId?: () => string;
  /** Reads the live-session pointer written by the UserPromptSubmit hook. */
  readCurrentSession?: () => Promise<string | null>;
}

interface Resolved {
  out: (s: string) => void;
  err: (s: string) => void;
  randomSessionId: () => string;
  readCurrentSession: () => Promise<string | null>;
}

interface VerbOpts {
  sessionId?: string;
}

function buildDeps(d: AutomationCliDeps): Resolved {
  return {
    out: d.stdout ?? ((s: string): void => void process.stdout.write(s)),
    err: d.stderr ?? ((s: string): void => void process.stderr.write(s)),
    randomSessionId: d.randomSessionId ?? ((): string => randomUUID()),
    readCurrentSession: d.readCurrentSession ?? readCurrentSession,
  };
}

/**
 * Resolution precedence: `--session-id` → `OPENSQUID_SESSION_ID` →
 * `.current-session` (recorded each turn by the UserPromptSubmit hook, so the
 * CLI targets the session the hooks actually key on) → a fresh random id.
 */
async function resolveSessionId(opts: VerbOpts, r: Resolved): Promise<string> {
  if (opts.sessionId !== undefined && opts.sessionId !== '') return opts.sessionId;
  const envId = process.env.OPENSQUID_SESSION_ID;
  if (envId !== undefined && envId !== '') return envId;
  const current = await r.readCurrentSession();
  if (current !== null && current !== '') return current;
  const fresh = r.randomSessionId();
  r.err(
    `opensquid automation: no --session-id, OPENSQUID_SESSION_ID, or live session pointer; using ${fresh}\n`,
  );
  return fresh;
}

async function actOn(r: Resolved, opts: VerbOpts): Promise<void> {
  const sid = await resolveSessionId(opts, r);
  await setAutomationFlag(sid);
  r.out(`automation: on (${automationFlagPath(sid)})\n`);
}

async function actOff(r: Resolved, opts: VerbOpts): Promise<void> {
  const sid = await resolveSessionId(opts, r);
  await clearAutomationFlag(sid);
  r.out(`automation: off (${automationFlagPath(sid)})\n`);
}

async function actStatus(r: Resolved, opts: VerbOpts): Promise<void> {
  const sid = await resolveSessionId(opts, r);
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

/** Register `opensquid automation` on the parent program. */
export function registerAutomation(parent: Command, deps: AutomationCliDeps = {}): Command {
  const r = buildDeps(deps);
  const c = parent
    .command('automation')
    .description('Toggle the session automation-mode flag (gates skills like d9-guard)');
  c.command('on')
    .description('Set the automation flag for this session')
    .option(SID_FLAG, SID_DESC)
    .action((opts: VerbOpts) => actOn(r, opts));
  c.command('off')
    .description('Clear the automation flag for this session')
    .option(SID_FLAG, SID_DESC)
    .action((opts: VerbOpts) => actOff(r, opts));
  c.command('status')
    .description('Report automation flag state (exit 0 = on, 1 = off)')
    .option(SID_FLAG, SID_DESC)
    .action((opts: VerbOpts) => actStatus(r, opts));
  return c;
}
