/**
 * DBL.1b — the DETERMINISTIC deploy-verification record (mirrors readiness.ts's record/read).
 *
 * The deploy `verify` decision (DBL.1) routes clean→ACCEPT / bugs→AUTHOR over `deploy.clean`. `deployClean` must
 * be DETERMINISTIC (the configured `verifyCommand` actually passed), never an agent self-report ("it passed" is
 * the self-report hole). The verify command is EXPENSIVE (typecheck/test/build) — it cannot run inside
 * `buildGuardCtx` (evaluated on every event). So the AGENT runs it (the deploy procedure instructs the exact
 * command), and a PostToolUse reaction (v2_supply) records its REAL exit code HERE; the gate READS this record.
 *
 * FAIL-CLOSED: a never-run / unreadable / malformed record reads as `null` → the caller (deploy_evidence) treats
 * a CONFIGURED-but-unrecorded verification as NOT clean (the bug-fix loop / "run the verify first"), never as a
 * silent pass. (An UNCONFIGURED project — no verifyCommand — skips this entirely; see deploy_evidence.)
 *
 * Persistence reuses the runtime session-state primitives (`atomicWriteFile` + `sessionStateFile`), per-task —
 * the same substrate readiness.ts writes. Latest-verify-wins (a re-run after a fix overwrites). NOTE: a
 * diff-hash freshness anchor (so a since-changed diff invalidates a stale pass, mirroring the CODE staleness
 * anchor) is the DBL.1c hardening — deferred here because `deployClean` is read in the hot `buildGuardCtx` path
 * (a per-event `git diff` would be costly); at the DEPLOY stage the code only changes via the bug-fix loop, which
 * re-runs verify, so the stale-pass window is narrow.
 *
 * Imports from: node:fs/promises, ../paths.js, ../../storage/atomic_file.js.
 * Imported by: src/runtime/loop/deploy_evidence.ts (read), src/runtime/loop/v2_supply.ts (record).
 */
import { readFile } from 'node:fs/promises';

import { atomicWriteFile } from '../../storage/atomic_file.js';
import { sessionStateFile } from '../paths.js';

const verificationKey = (taskId: string): string => `fullstack-flow-verify-${taskId}`;

/** Record the deterministic result of the agent's `verifyCommand` run (its real exit code) for the task. */
export async function recordVerification(
  sid: string,
  taskId: string,
  passed: boolean,
): Promise<void> {
  await atomicWriteFile(sessionStateFile(sid, verificationKey(taskId)), JSON.stringify({ passed }));
}

/** The recorded verification result, or `null` when none/unreadable (the caller decides skip-vs-fail-closed). */
export async function readVerification(sid: string, taskId: string): Promise<boolean | null> {
  try {
    const p = JSON.parse(await readFile(sessionStateFile(sid, verificationKey(taskId)), 'utf8')) as {
      passed?: unknown;
    };
    return typeof p.passed === 'boolean' ? p.passed : null;
  } catch {
    return null; // never-run / unreadable / malformed
  }
}
