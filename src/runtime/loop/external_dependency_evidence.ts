/**
 * GFR.4 / E2 — the runtime I/O side of the external-dependency conditionality: read the uncommitted diff and
 * decide whether the change touches an external fact (`touchesExternalDependency`). The pure predicate lives in
 * `external_dependency.ts`; this is the injectable git read (mirrors `staged_diff.ts` / `readiness.gatherReadiness`).
 *
 * FAIL-OPEN toward NOT-NEEDED on any infra error (no cwd / git error / empty diff): the external rung is a
 * SUPPLEMENT to the fail-closed coverage/phase/deprecated/guess-free facets — a git hiccup must never brick the
 * flow by demanding a consultation that can't be justified from a diff we couldn't read (same "never a false
 * block" contract as `gatherReadiness`). The un-analyzable case is exempt, not required. NOT capped like
 * `staged_diff` (that cap bounds an LLM prompt; here we only scan for import lines), so a large refactor is
 * still analyzed rather than silently exempted.
 *
 * Spec: docs/tasks/T-v2-guess-free.md GFR.4.
 */
import { readGitWorkingTreeDiff } from '../../functions/staged_diff.js';
import { readSessionCwd } from '../session_state.js';

import { touchesExternalDependency } from './external_dependency.js';

/** Injectable readers (tests pass pure stubs); defaults read the complete uncommitted working tree. */
export interface ExternalNeededDeps {
  cwd: (sessionId: string) => Promise<string | null>;
  diff: (cwd: string) => Promise<string>;
}

const defaultDeps: ExternalNeededDeps = {
  cwd: readSessionCwd,
  diff: readGitWorkingTreeDiff,
};

/**
 * True iff the session's uncommitted diff touches an external fact (a new third-party import or a dependency
 * manifest change) — the CONDITIONALITY the external-consultation facets gate their requirement on. FAIL-OPEN
 * to `false` (exempt) on any error / no cwd / empty diff.
 */
export async function externalNeededForSession(
  sessionId: string,
  deps: ExternalNeededDeps = defaultDeps,
): Promise<boolean> {
  try {
    const cwd = await deps.cwd(sessionId);
    if (cwd === null) return false; // no repo ⇒ cannot prove external ⇒ exempt (never a false block)
    return touchesExternalDependency(await deps.diff(cwd));
  } catch {
    return false; // git error ⇒ exempt (the SUPPLEMENT never bricks the flow on infra)
  }
}
