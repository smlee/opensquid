/**
 * Frontend pre-delivery gate evidence (T-frontend-design-pack FD5/FD6).
 *
 * The CODE/DEPLOY gate fact for the OUTPUT enforcement: audit the STAGED frontend files (the code about to be
 * delivered) with the `frontend_audit` detectors and expose `clean` = no CRITICAL violation. The guard
 * `code_frontend_clean: 'frontend.clean'` blocks a commit that stages an accessibility-critical frontend defect
 * (e.g. an <img> with no alt, a keyboard-dead onClick) — the "lenses → proper output" enforcement.
 *
 * FAIL-OPEN by design (unlike the other v2 gates' fail-closed): a non-tool_call event, an absent cwd, a non-repo,
 * or a git error yields `clean: true`. Rationale — this gate must only block on a PROVEN critical frontend
 * violation in staged code; it must NEVER brick a backend/docs commit it cannot analyze. Precision over recall.
 *
 * Staged content is read with FIXED-argv git (`git show :<path>`) — no shell, no user tokens (same posture as
 * `staged_docs_only`). Deps are injectable so tests drive the auditor with literal staged files.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { auditFiles } from '../../functions/frontend_audit.js';
import type { Event } from '../types.js';

const execFileP = promisify(execFile);

export interface FrontendEvidence {
  clean: boolean;
  critical: number;
  high: number;
  filesScanned: number;
}

const CLEAN: FrontendEvidence = { clean: true, critical: 0, high: 0, filesScanned: 0 };

const FRONTEND_EXT = /\.(html?|jsx|tsx|vue|svelte|astro|css|scss)$/i;

export interface FrontendEvidenceDeps {
  /** Return the staged frontend files (path + staged content) for a repo cwd. */
  stagedFiles: (cwd: string) => Promise<{ path: string; content: string }[]>;
}

/** Default deps — read the staged blob of each staged frontend file via fixed-argv git (no shell). */
export const defaultFrontendEvidenceDeps: FrontendEvidenceDeps = {
  stagedFiles: async (cwd) => {
    const { stdout } = await execFileP('git', ['diff', '--cached', '--name-only'], { cwd });
    const paths = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((p) => p !== '' && FRONTEND_EXT.test(p));
    const out: { path: string; content: string }[] = [];
    for (const path of paths) {
      try {
        const { stdout: content } = await execFileP('git', ['show', `:${path}`], {
          cwd,
          maxBuffer: 8_000_000,
        });
        out.push({ path, content });
      } catch {
        // A deleted/renamed/binary staged path may have no readable blob — skip it (cannot audit → no finding).
      }
    }
    return out;
  },
};

/**
 * Build the frontend gate evidence for the pending event. FAIL-OPEN: any non-tool_call / no-cwd / git error →
 * `clean: true` (never block a commit we cannot analyze). Blocks ONLY on a proven CRITICAL staged frontend defect.
 */
export async function frontendEvidenceForEvent(
  event: Event,
  deps: FrontendEvidenceDeps = defaultFrontendEvidenceDeps,
): Promise<FrontendEvidence> {
  if (!('tool' in event)) return CLEAN;
  const cwd = 'cwd' in event ? (event as { cwd?: unknown }).cwd : undefined;
  if (typeof cwd !== 'string' || cwd === '') return CLEAN;
  try {
    const files = await deps.stagedFiles(cwd);
    if (files.length === 0) return CLEAN;
    const r = auditFiles(files);
    return { clean: r.clean, critical: r.critical, high: r.high, filesScanned: r.filesScanned };
  } catch {
    return CLEAN; // fail-open: cannot analyze → do not block
  }
}
