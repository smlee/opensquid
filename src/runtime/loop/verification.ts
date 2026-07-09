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
    const p = JSON.parse(
      await readFile(sessionStateFile(sid, verificationKey(taskId)), 'utf8'),
    ) as {
      passed?: unknown;
    };
    return typeof p.passed === 'boolean' ? p.passed : null;
  } catch {
    return null; // never-run / unreadable / malformed
  }
}

// scope-1 (T-deploy-commit-gate §2.1) — the DETERMINISTIC project-SUITE record, mirroring the verifyCommand
// record above. DEPLOY's mandatory floor is the whole pre-push suite (lint+typecheck+build+test+format:check);
// like verifyCommand it is EXPENSIVE, so the AGENT runs it in the deploy procedure and a PostToolUse reaction
// (v2_supply) records its REAL exit code HERE — `deployClean` READS this record and NEVER runs the suite in the
// hot `buildGuardCtx` path. The verifyCommand is now ADDITIVE on top of this floor (deploy_evidence).
const suiteKey = (taskId: string): string => `fullstack-flow-suite-${taskId}`;

/** Record the deterministic result of the agent's project-suite run (its real exit code) for the task. */
export async function recordSuite(sid: string, taskId: string, passed: boolean): Promise<void> {
  await atomicWriteFile(sessionStateFile(sid, suiteKey(taskId)), JSON.stringify({ passed }));
}

/** The recorded suite result, or `null` when none/unreadable (the caller decides skip-vs-fail-closed). */
export async function readSuite(sid: string, taskId: string): Promise<boolean | null> {
  try {
    const p = JSON.parse(await readFile(sessionStateFile(sid, suiteKey(taskId)), 'utf8')) as {
      passed?: unknown;
    };
    return typeof p.passed === 'boolean' ? p.passed : null;
  } catch {
    return null; // never-run / unreadable / malformed
  }
}

// AQG.4 (T-arch-quality-gate) — the DETERMINISTIC project ARCHITECTURE-DETECTOR record, a byte-for-byte sibling
// of recordSuite/readSuite. The detector command is EXPENSIVE (a lint over the tree), so the AGENT runs it in
// the CODE procedure and a PostToolUse reaction (v2_supply) records its REAL exit code HERE on a verbatim match;
// `archClean` READS this record. The state key is DISTINCT from `suiteKey` (a shared key would conflate the two
// facets). Fail policy is the caller's (code_evidence): declared+no-record → fail-closed, undeclared → fail-open.
const archKey = (taskId: string): string => `fullstack-flow-arch-${taskId}`;

/** Record the deterministic result of the agent's arch-detector run (its real exit code) for the task. */
export async function recordArch(sid: string, taskId: string, passed: boolean): Promise<void> {
  await atomicWriteFile(sessionStateFile(sid, archKey(taskId)), JSON.stringify({ passed }));
}

/** The recorded arch-detector result, or `null` when none/unreadable (the caller decides skip-vs-fail-closed). */
export async function readArch(sid: string, taskId: string): Promise<boolean | null> {
  try {
    const p = JSON.parse(await readFile(sessionStateFile(sid, archKey(taskId)), 'utf8')) as {
      passed?: unknown;
    };
    return typeof p.passed === 'boolean' ? p.passed : null;
  } catch {
    return null; // never-run / unreadable / malformed
  }
}

// DBL.2 — bound the bug-fix loop. The `verify` decision routes bugs→AUTHOR; an UNFIXABLE bug would cycle
// deploy→author→code→deploy forever. Count the rounds (durable, per-task) and escalate at the cap, so a stuck
// bug becomes a genuine human residual instead of an infinite grind (integrity over an endless loop).
const bugfixRoundsKey = (taskId: string): string => `fullstack-flow-bugfix-rounds-${taskId}`;

/** The recorded bug-fix round count for the task (0 when none/unreadable). */
export async function readBugfixRounds(sid: string, taskId: string): Promise<number> {
  try {
    const p = JSON.parse(
      await readFile(sessionStateFile(sid, bugfixRoundsKey(taskId)), 'utf8'),
    ) as {
      rounds?: unknown;
    };
    return typeof p.rounds === 'number' && Number.isFinite(p.rounds) ? p.rounds : 0;
  } catch {
    return 0;
  }
}

/** Increment the bug-fix round count (scope-2: bumped on each RED suite re-run — the uniform DEPLOY-local /
 *  redesign round driver); returns the new count. Bounds the fix loop → the cap flips deploy.bugfix_exhausted. */
export async function bumpBugfixRounds(sid: string, taskId: string): Promise<number> {
  const next = (await readBugfixRounds(sid, taskId)) + 1;
  await atomicWriteFile(
    sessionStateFile(sid, bugfixRoundsKey(taskId)),
    JSON.stringify({ rounds: next }),
  );
  return next;
}

/** Reset the bug-fix round count (on a clean verification or when the item leaves the flow). Best-effort. */
export async function resetBugfixRounds(sid: string, taskId: string): Promise<void> {
  try {
    await atomicWriteFile(
      sessionStateFile(sid, bugfixRoundsKey(taskId)),
      JSON.stringify({ rounds: 0 }),
    );
  } catch {
    /* best-effort: a stale count at worst escalates one round early — never a correctness hole */
  }
}

// scope-2 (T-deploy-commit-gate §5.1) — the DEPLOY-local fix loop's ESCAPE HATCH: the durable per-task
// "this red genuinely needs re-authoring" signal. The `verify` decision routes red → DEPLOY-LOCAL fix by
// DEFAULT (the common case: lint/format/type/test/build — fixed in place); it kicks back to AUTHOR ONLY when
// this flag is set, so a mechanical failure never routes through AUTHOR. It is AGENT-INTENT (set by the
// operator/lap via `opensquid redesign <taskId>` when the deploy procedure judges the fix needs design rework),
// NOT a reaction — mirroring `accept` (a durable human/agent signal), distinct from the deterministic
// suite/verify reaction records above. FAIL-CLOSED to false (unset/unreadable → not-redesign → DEPLOY-local),
// which IS the narrowing the design wants: default local, escalate only on an explicit signal. Reset on a clean
// verify (verify→accept) so a re-authored, now-green item does not re-escalate.
const needsRedesignKey = (taskId: string): string => `fullstack-flow-needs-redesign-${taskId}`;

/** The recorded "needs design rework" flag for the task (false when unset/unreadable → DEPLOY-local). */
export async function readNeedsRedesign(sid: string, taskId: string): Promise<boolean> {
  try {
    const p = JSON.parse(
      await readFile(sessionStateFile(sid, needsRedesignKey(taskId)), 'utf8'),
    ) as {
      needed?: unknown;
    };
    return p.needed === true;
  } catch {
    return false; // unset / unreadable → not redesign → DEPLOY-local (the safe narrowing)
  }
}

/** Set/clear the "needs design rework" flag for the task (the escape hatch to AUTHOR). Best-effort on clear. */
export async function recordNeedsRedesign(
  sid: string,
  taskId: string,
  needed: boolean,
): Promise<void> {
  await atomicWriteFile(
    sessionStateFile(sid, needsRedesignKey(taskId)),
    JSON.stringify({ needed }),
  );
}
