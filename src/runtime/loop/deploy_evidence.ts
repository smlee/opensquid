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
import {
  readActiveDeployReversible,
  readActiveVerifyCommand,
  readActiveVerifySuite,
} from '../../packs/discovery.js';
import { resolveProjectScopeRoot } from '../paths.js';
import { readActiveTask, readSessionCwd } from '../session_state.js';

import { readAcceptance } from './acceptance.js';
import { readSuite, readVerification } from './verification.js';

export interface DeployEvidence {
  capabilityOk: boolean;
  accepted: boolean;
  /**
   * scope-1 (T-deploy-commit-gate §2.1) — the VERIFY facet, now `suiteGreen && (verifyCommand green OR
   * unconfigured)`. The full project SUITE (lint+typecheck+build+test+format:check) is DEPLOY's MANDATORY FLOOR;
   * `verifyCommand` (e2e/smoke) is ADDITIVE on top. The SKIP hole is CLOSED: an unconfigured `verifyCommand` no
   * longer yields `deployClean:true` on a red suite — once a project DECLARES a verification suite the floor
   * FAILS CLOSED (no suite record / a red suite → not clean → the DEPLOY-local fix-loop). A LEGACY project that
   * declares NEITHER a suite NOR a verifyCommand still ships as today (both readers null → clean). The `verify`
   * decision routes clean→ACCEPT / red→DEPLOY-local fix (scope-2).
   */
  deployClean: boolean;
  /**
   * REVERSIBLE-DEPLOY — `true` iff the project's `.opensquid/active.json` declares `reversible: true`. When
   * true, the `accept` decision auto-advances to `accepted` without a human `opensquid accept <taskId>`. The
   * acceptance audit item is still created (the trail is preserved). FAIL-CLOSED: absent/false/unreadable ⇒
   * `false` ⇒ irreversible ⇒ the human gate holds.
   */
  reversible: boolean;
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
  /**
   * scope-1 (T-deploy-commit-gate §2.1) — the recorded project-SUITE result for the session. `null` ⇒ NO
   * verification suite DECLARED for the project (`verifySuite` absent) → the floor is SKIPPED (legacy project).
   * A boolean ⇒ the recorded pass/fail of the declared suite's real exit code. FAIL-CLOSED once declared: a
   * configured-but-unrecorded suite ⇒ `false` (run the suite first), never a silent pass. Cheap (file reads
   * only — the AGENT runs the suite in the deploy procedure; this NEVER runs it in the hot ctx path).
   */
  suiteResult(sessionId: string): Promise<boolean | null>;
  /**
   * REVERSIBLE-DEPLOY — whether this project's deploy is declared reversible in `.opensquid/active.json`.
   * FAIL-CLOSED default: absent / unreadable / false ⇒ `false` ⇒ human gate holds.
   */
  reversible(sessionId: string): Promise<boolean>;
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
  // scope-1 — resolve the project's DECLARED verification SUITE (verifySuite); UNDECLARED → null (SKIP → the
  // floor is off, a legacy project ships as today). DECLARED → the recorded suite result (the agent's suite
  // exit code, verification.ts); no active task or no record yet → false (FAIL-CLOSED: run the suite first, the
  // SKIP hole is closed). Cheap (file reads only — never runs the suite here; the deploy procedure does).
  async suiteResult(sessionId) {
    const cwd = await readSessionCwd(sessionId);
    if (cwd === null) return null;
    const suite = await readActiveVerifySuite(await resolveProjectScopeRoot(cwd));
    if (suite === null) return null; // no suite declared → skip → floor off (legacy project)
    const t = await readActiveTask(sessionId);
    const taskId = t === null ? null : (t.taskId ?? t.id);
    if (taskId === null) return false; // declared but no active task → fail-closed
    return (await readSuite(sessionId, taskId)) ?? false; // recorded pass/fail; no record → fail-closed
  },
  // REVERSIBLE-DEPLOY — read `reversible` from the project's active.json. FAIL-CLOSED: absent/false/unreadable
  // → false → irreversible → human gate holds.
  async reversible(sessionId) {
    const cwd = await readSessionCwd(sessionId);
    if (cwd === null) return false;
    return readActiveDeployReversible(await resolveProjectScopeRoot(cwd));
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
    // scope-1 — the SUITE is the mandatory floor; `verifyCommand` is ADDITIVE on top:
    //   deployClean = (suite ?? true) && (verify ?? true)
    // A null suite = no suite DECLARED → skipped (legacy project); a null verify = no verifyCommand → additive
    // absent → treated true. The SKIP hole is closed: once a suite is declared, a red/unrecorded suite → false.
    const suite = await deps.suiteResult(sessionId);
    const verify = await deps.verificationResult(sessionId);
    deployClean = (suite ?? true) && (verify ?? true);
  } catch {
    deployClean = false; // fail-closed: a throwing suite/verification reader routes to the bug-fix loop
  }
  let reversible = false;
  try {
    reversible = await deps.reversible(sessionId);
  } catch {
    reversible = false; // fail-closed: a throwing reader treats the deploy as irreversible → human gate
  }
  return { capabilityOk, accepted, deployClean, reversible };
}
