/**
 * T2.8 — the deterministic DEPLOY evidence bridge (zero LLM).
 *
 * The runtime side of the DEPLOY gate. It returns the TWO facets the DEPLOY stage predicates on:
 *   capabilityOk — the shipped `CapabilityGate` (capability_gate.ts:132) ALLOWS the deploy capability. When there
 *                  is NO deploy env (no deploy request configured for this session), the check is SKIPPED → true:
 *                  a flow with nothing to deploy is not blocked by the capability gate (the human-accept decision
 *                  is the real ship guard, T2.8). When a deploy request IS configured, the gate's verdict decides.
 *   accepted     — the ACTIVE task's durable acceptance item (acceptance.ts) is `accepted`. The waiting/absent
 *                  item is the default → the `accept` decision loops back to PLAN (NEVER auto-ship, design §6.2).
 *
 * Mirrors `code_evidence.ts`/`plan_evidence.ts`: a small deterministic producer that `buildGuardCtx` binds
 * dual-shape onto the guard ctx. INJECTABLE (`deps`): tests pass a pure capability checker + acceptance reader +
 * active-task id, so a test never touches `~/.opensquid` or a live gate. FAIL-CLOSED on `accepted` (no active
 * task / any throw → `accepted:false`, the gate loops); the capability check FAILS CLOSED on a throw too
 * (`capabilityOk:false`). The "no deploy env" SKIP is an explicit, deliberate true (not a swallowed error).
 *
 * Spec: docs/tasks/T-v2-track2-discipline.md T2.8.
 */
import { readActiveVerifyCommand } from '../../packs/discovery.js';
import { resolveProjectScopeRoot } from '../paths.js';
import { readActiveTask, readSessionCwd } from '../session_state.js';

import { readAcceptance } from './acceptance.js';
import { readVerification } from './verification.js';

export interface DeployEvidence {
  capabilityOk: boolean;
  accepted: boolean;
  /**
   * DBL.1 — the VERIFY decision's facet: the configured verification (verifyCommand) passed. The `verify`
   * decision routes clean→ACCEPT / bugs→AUTHOR. SKIP semantics (mirroring `capabilityOk`): when NO verification
   * is configured the result reader returns `null` → `deployClean:true` (an unconfigured project ships as today).
   * FAIL-CLOSED once configured (no record / throw → false → the bug-fix loop; never ship an unverified build).
   */
  deployClean: boolean;
}

/** The injectable I/O the DEPLOY evidence reads — the default binds the shipped runtime readers. */
export interface DeployEvidenceDeps {
  /** The active task id (acceptance is per-task); `null` ⇒ no active task. */
  activeTaskId(sessionId: string): Promise<string | null>;
  /**
   * Run the deploy capability check for the session. `null` ⇒ NO deploy env (no deploy request configured) →
   * the check is SKIPPED (capabilityOk:true). A boolean ⇒ the `CapabilityGate` verdict (`allowed`).
   */
  capabilityCheck(sessionId: string): Promise<boolean | null>;
  /** The durable acceptance set for the session (acceptance.ts last-writer-wins read). */
  acceptance(sessionId: string): Promise<{ taskId: string; status: string }[]>;
  /**
   * DBL.1 — the recorded verification result for the session. `null` ⇒ NO verification configured (no
   * verifyCommand) → SKIPPED (deployClean:true). A boolean ⇒ the recorded pass/fail of the configured
   * verifyCommand. DBL.1b binds the deterministic record (the agent's verify-run exit code); today: `null`.
   */
  verificationResult(sessionId: string): Promise<boolean | null>;
}

/**
 * Default deps: the shipped runtime readers. There is NO deploy env wired into the runtime today (no `pack.yaml`
 * declares a deploy capability request for the live observed path), so `capabilityCheck` returns `null` → the
 * capability gate is SKIPPED (capabilityOk:true). When a deploy request lands, this is the seam to bind a real
 * `CapabilityGate.check` whose `verdict.allowed` decides. `accepted` reads the durable acceptance jsonl.
 */
export const defaultDeployEvidenceDeps: DeployEvidenceDeps = {
  async activeTaskId(sessionId) {
    const t = await readActiveTask(sessionId);
    // prefer the harness track id (`metadata.taskId`); fall back to the numeric id (per-task keying is T2.2).
    return t === null ? null : (t.taskId ?? t.id);
  },
  capabilityCheck: () => Promise.resolve(null), // no deploy env wired → skip → capabilityOk:true
  acceptance: readAcceptance,
  // DBL.1b — resolve the project's verifyCommand; UNCONFIGURED → null (SKIP → deployClean:true, ships as today).
  // CONFIGURED → the recorded result (the agent's verifyCommand exit code, verification.ts); no record yet →
  // false (FAIL-CLOSED: run the verify before shipping). Cheap (file reads only — never runs the command here).
  async verificationResult(sessionId) {
    const cwd = await readSessionCwd(sessionId);
    if (cwd === null) return null;
    const cmd = await readActiveVerifyCommand(await resolveProjectScopeRoot(cwd));
    if (cmd === null) return null; // no verification configured → skip → clean
    const t = await readActiveTask(sessionId);
    const taskId = t === null ? null : (t.taskId ?? t.id);
    if (taskId === null) return false; // configured but no active task → fail-closed
    return (await readVerification(sessionId, taskId)) ?? false; // recorded pass/fail; no record → fail-closed
  },
};

/**
 * Compute the DEPLOY evidence. `deps` is injectable (tests pass pure readers); the default binds the shipped
 * runtime readers. FAIL-CLOSED on `accepted` (no active task / any throw); capability skip → true.
 */
export async function deployEvidenceForSession(
  sessionId: string,
  deps: DeployEvidenceDeps | undefined = defaultDeployEvidenceDeps,
): Promise<DeployEvidence> {
  deps = deps ?? defaultDeployEvidenceDeps;
  let capabilityOk = false;
  try {
    const c = await deps.capabilityCheck(sessionId);
    capabilityOk = c ?? true; // null = no deploy env → SKIP → true
  } catch {
    capabilityOk = false; // fail-closed: a throwing capability check blocks
  }
  let accepted = false;
  try {
    const taskId = await deps.activeTaskId(sessionId);
    if (taskId !== null) {
      const items = await deps.acceptance(sessionId);
      accepted = items.some((i) => i.taskId === taskId && i.status === 'accepted');
    }
  } catch {
    accepted = false; // fail-closed: an unprovable acceptance loops back to PLAN (never auto-ship)
  }
  let deployClean = true;
  try {
    const v = await deps.verificationResult(sessionId);
    deployClean = v ?? true; // null = no verification configured → SKIP → clean (ships as today)
  } catch {
    deployClean = false; // fail-closed: a throwing verification reader routes to the bug-fix loop
  }
  return { capabilityOk, accepted, deployClean };
}
