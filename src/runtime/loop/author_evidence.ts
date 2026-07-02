/**
 * T2.6 — the deterministic AUTHOR evidence bridge (zero LLM).
 *
 * The runtime side of the pure `authorEvidence` wrapper: it computes the requirements + `CheckOpts`
 * (manifest + CodeIndex) the coverage CI uses, runs the pure checker, and returns the two AUTHOR facets
 * (`manifestComplete`, `realCode`). Mirrors `scope_evidence.ts`/`plan_evidence.ts`: a small, deterministic
 * producer `buildGuardCtx` binds dual-shape onto the guard ctx.
 *
 * Reuses the SHIPPED coverage substrate exactly as `coverage/run.ts` does (the report-only CI runner):
 *   - `extractRequirements(MANIFEST_FILE, …)` over `docs/ARCHITECTURE.md` — the in-repo requirement manifest.
 *   - `buildCodeIndex(repoRoot, GATED_PREFIXES)` — the ONE I/O step (read the gated `src/`/`packs/` tree).
 *   - `checkCoverage(reqs, { gatedPrefixes, index })` (via `authorEvidence`).
 *
 * INJECTABLE (like plan_evidence's `wg` reader): the `inputs` provider is the only I/O. The default resolves
 * the repo root from the session cwd and builds the full index; tests inject a pure `{ reqs, opts }` so they
 * never touch `~/.opensquid` or build the live index. FAIL-CLOSED: an unresolvable/throwing provider →
 * `{ manifestComplete:false, realCode:false }` (the gate blocks — an unprovable AUTHOR is not "real code").
 *
 * Spec: docs/tasks/T-v2-track2-discipline.md T2.6.
 */
import type { checkCoverage } from '../coverage/check.js';
import { GATED_PREFIXES, MANIFEST_FILE, readAllowlist } from '../coverage/run.js';
import { extractRequirements } from '../coverage/schema.js';
import { buildCodeIndex } from '../coverage/index_build.js';
import { readSessionCwd } from '../session_state.js';

import { authorEvidence, type AuthorEvidence } from './author_coverage.js';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The pure inputs the coverage checker needs — what the injectable provider yields. */
export interface AuthorInputs {
  reqs: Parameters<typeof checkCoverage>[0];
  opts: Parameters<typeof checkCoverage>[1];
}

/** Resolve the requirements + CheckOpts from a repo root the SAME way `coverage/run.ts` does (the CI runner). */
export function authorInputsForRepo(repoRoot: string): AuthorInputs {
  const reqs = extractRequirements(
    MANIFEST_FILE,
    readFileSync(join(repoRoot, MANIFEST_FILE), 'utf8'),
  );
  const index = buildCodeIndex(repoRoot, GATED_PREFIXES);
  return { reqs, opts: { gatedPrefixes: GATED_PREFIXES, index, allowlist: readAllowlist(repoRoot) } };
}

/**
 * Compute the AUTHOR evidence. `inputs` is injectable (tests pass pure `{reqs, opts}`); the default builds the
 * full index from the session's repo root (the only I/O). FAIL-CLOSED on any resolution/build error.
 */
export async function authorEvidenceForSession(
  sessionId: string,
  inputs?: AuthorInputs,
): Promise<AuthorEvidence> {
  try {
    let resolved = inputs;
    if (resolved === undefined) {
      const cwd = await readSessionCwd(sessionId);
      if (cwd === null) return { manifestComplete: false, realCode: false }; // fail-closed: no repo
      resolved = authorInputsForRepo(cwd);
    }
    return authorEvidence(resolved.reqs, resolved.opts);
  } catch {
    return { manifestComplete: false, realCode: false }; // fail-closed: an unprovable AUTHOR blocks
  }
}
