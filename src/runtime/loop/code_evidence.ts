/**
 * T2.7 — the deterministic CODE evidence bridge (zero LLM).
 *
 * The runtime side of the CODE gate: it joins the SHIPPED 7-phase ledger (`isComplete`, workflow_phases.ts:109)
 * with the persisted readiness RESULT (`readinessResult`, readiness.ts) and returns the THREE CODE facets the
 * `code_ready` guard predicates on:
 *   phasesComplete  — every REQUIRED phase logged FOR THE ACTIVE TASK (`isComplete(readPhaseState(sid), taskId)`).
 *   readinessRan    — the three readiness surfacers were run + recorded for the task.
 *   deprecatedClean — the recorded readiness found NO known-deprecated call (the BLOCKING result, not "ran").
 *   suiteGreen      — SGG.2: the recorded FULL declared verifySuite came back green (the `test` phase ran the
 *                     project's whole pre-push bar, not a self-selected slice). FAIL-CLOSED: no record / red →
 *                     `false`. Reuses the SHIPPED `readSuite` reader (verification.ts) — the SAME suite record
 *                     DEPLOY's `deploy.clean` reads (`recordSuite`, v2_supply.ts, fires on ANY suite run,
 *                     including CODE's `test` phase), so no new recording path is added. Mirrors the fail-closed
 *                     `readSuite(...) ?? false` at deploy_evidence.ts (`suiteResult`). This is what kills the
 *                     false-green slice: a CODE lap that ran only a subset leaves no green suite record → blocks.
 *
 * Mirrors `plan_evidence.ts`/`author_evidence.ts`: a small deterministic producer that `buildGuardCtx` binds
 * dual-shape onto the guard ctx. INJECTABLE (like author_evidence's `inputs`): the `deps` provider supplies the
 * phase state, the active task id, the readiness result, and the recorded suite result, so a test never touches
 * `~/.opensquid` or the live ledger. FAIL-CLOSED: no active task / any throw → `{ phasesComplete:false,
 * readinessRan:false, deprecatedClean:false, suiteGreen:false }` (the gate blocks — an unprovable CODE is never
 * "ready").
 *
 * Spec: docs/tasks/T-v2-track2-discipline.md T2.7; SGG.2 (docs/tasks/T-code-suite-green-gate.md).
 */
import { isComplete, readPhaseState, type PhaseState } from '../workflow_phases.js';
import { readActiveTask, readSessionCwd } from '../session_state.js';
import { resolveProjectScopeRoot } from '../paths.js';
import { readActiveArchDetector } from '../../packs/discovery.js';

import { readinessResult } from './readiness.js';
import { readSuite, readArch } from './verification.js';

export interface CodeEvidence {
  phasesComplete: boolean;
  readinessRan: boolean;
  deprecatedClean: boolean;
  /** SGG.2 — the recorded FULL declared verifySuite result (fail-closed: no record / red → false). */
  suiteGreen: boolean;
  /**
   * AQG.4 (T-arch-quality-gate) — the project ARCHITECTURE-DETECTOR facet. DELIBERATELY asymmetric to
   * `suiteGreen`: fails OPEN to `true` when NO detector is declared (a legacy project ships as today), fails
   * CLOSED to `false` once a detector IS declared but is unrun / red. Keys on the DECLARATION, not on
   * record-presence alone (see `codeEvidenceForSession`).
   */
  archClean: boolean;
}

/** The injectable I/O the CODE evidence reads — the default binds the shipped runtime readers. */
export interface CodeEvidenceDeps {
  /** The active task id (`isComplete` + `readinessResult` are both per-task); `null` ⇒ no active task. */
  activeTaskId(sessionId: string): Promise<string | null>;
  /** The 7-phase ledger for the session. */
  phaseState(sessionId: string): Promise<PhaseState | null>;
  /** The persisted readiness RESULT for the task. */
  readiness(sessionId: string, taskId: string): Promise<{ ran: boolean; deprecatedClean: boolean }>;
  /** SGG.2 — the recorded suite pass/fail for the task; `null` ⇒ no record ⇒ fail-closed. Mirrors deploy_evidence. */
  suite(sessionId: string, taskId: string): Promise<boolean | null>;
  /** AQG.4 — is an arch-detector DECLARED for the session's project? (no command ⇒ false ⇒ facet fails OPEN). */
  archDetectorDeclared(sessionId: string): Promise<boolean>;
  /** AQG.4 — the recorded arch-detector pass/fail for the task; `null` ⇒ no record. */
  arch(sessionId: string, taskId: string): Promise<boolean | null>;
}

/** Default deps: the shipped runtime readers (the only I/O). */
export const defaultCodeEvidenceDeps: CodeEvidenceDeps = {
  async activeTaskId(sessionId) {
    const t = await readActiveTask(sessionId);
    // prefer the harness track id (`metadata.taskId`); fall back to the numeric id. (Per-task keying is T2.2.)
    return t === null ? null : (t.taskId ?? t.id);
  },
  phaseState: readPhaseState,
  readiness: readinessResult,
  suite: readSuite, // SGG.2 — the SHIPPED suite reader (verification.ts); no new recording path
  // AQG.4 — resolve the project scope root the SAME way v2_supply does (readSessionCwd → resolveProjectScopeRoot),
  // then a declared detector ⇒ true. No command declared ⇒ false ⇒ the facet fails OPEN (legacy projects unbricked).
  async archDetectorDeclared(sessionId) {
    const cwd = await readSessionCwd(sessionId);
    const scopeRoot = cwd === null ? null : await resolveProjectScopeRoot(cwd);
    return (await readActiveArchDetector(scopeRoot)) !== null;
  },
  arch: readArch, // AQG.4 — the SHIPPED arch reader (verification.ts); the verbatim-match record path is v2_supply
};

/**
 * Compute the CODE evidence. `deps` is injectable (tests pass pure readers); the default binds the shipped
 * runtime readers. FAIL-CLOSED on no active task / any throw.
 */
export async function codeEvidenceForSession(
  sessionId: string,
  deps: CodeEvidenceDeps | undefined = defaultCodeEvidenceDeps,
): Promise<CodeEvidence> {
  deps = deps ?? defaultCodeEvidenceDeps;
  // The fail-closed default sets `archClean: true` (fail-OPEN, the DELIBERATE asymmetry with the other three
  // facets): an unresolvable session must NOT brick a project that declares no arch-detector. A DECLARED
  // project's block still comes from `suiteGreen` fail-closed — the arch facet only bites once declared+red.
  const closed: CodeEvidence = {
    phasesComplete: false,
    readinessRan: false,
    deprecatedClean: false,
    suiteGreen: false,
    archClean: true,
  };
  try {
    const taskId = await deps.activeTaskId(sessionId);
    if (taskId === null) return closed; // fail-closed: no active task ⇒ nothing provably complete
    const phasesComplete = isComplete(await deps.phaseState(sessionId), taskId);
    const r = await deps.readiness(sessionId, taskId);
    // SGG.2 — fail-closed: no suite record / red → false (mirrors deploy_evidence's `?? false`).
    const suiteGreen = (await deps.suite(sessionId, taskId)) ?? false;
    // AQG.4 — the DELIBERATE asymmetry: undeclared → fail-OPEN (true); declared → fail-CLOSED (no record / red →
    // false). Key on `archDetectorDeclared`, not on record-presence, so a declared-but-unrun detector blocks.
    const archDeclared = await deps.archDetectorDeclared(sessionId);
    const archClean = archDeclared ? ((await deps.arch(sessionId, taskId)) ?? false) : true;
    return {
      phasesComplete,
      readinessRan: r.ran,
      deprecatedClean: r.deprecatedClean,
      suiteGreen,
      archClean,
    };
  } catch {
    return closed; // fail-closed: an unprovable CODE blocks (but archClean stays fail-OPEN — see `closed`)
  }
}
