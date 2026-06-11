/**
 * PGB.2 (T-fix-pushgate-bypass) — per-commit flow attestations.
 *
 * Provenance rides the COMMIT, not the ambient session: when a gated commit passes
 * the commit-boundary conditions (docs-only, or a completed SCOPE→AUTHOR→7-phase
 * flow in the live session), the post-commit hook records one append-only JSON line
 * in `<scopeRoot>/attestations.jsonl` (beside `active.json` — machine-local, survives
 * session end, never cleaned by SessionEnd). The push gate then accepts a push whose
 * outgoing commits are all attested, even when the authoring session is long gone —
 * closing the false-block on handover pushes WITHOUT weakening fail-closed (an
 * unattested code commit still needs a live completed flow, or is blocked).
 *
 * Trust model: plain local files, same trust level as `--no-verify` (the single
 * closed escape hatch) — forgery hardening is explicitly out of scope.
 *
 * Imported by: src/setup/cli/gate.ts (append on attest, read on push).
 */

import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Attestation {
  sha: string;
  allowed: boolean;
  reason: 'docs_only' | 'flow_complete' | 'human';
  session: string;
  at: string;
}

const attestationsPath = (scopeRoot: string): string => join(scopeRoot, 'attestations.jsonl');

/** Append one attestation row. A single short line « PIPE_BUF — concurrent sessions
 *  cannot interleave mid-line on a local fs; a torn line is skipped by the reader. */
export async function appendAttestation(scopeRoot: string, a: Attestation): Promise<void> {
  await appendFile(attestationsPath(scopeRoot), `${JSON.stringify(a)}\n`, 'utf8');
}

/** The set of shas with an `allowed` attestation. Tolerant reader: a torn/foreign
 *  line is skipped (that sha simply stays unattested → fail-closed downstream).
 *  No file → empty set (behavior identical to pre-attestation clones). */
export async function readAttestedShas(scopeRoot: string): Promise<Set<string>> {
  const out = new Set<string>();
  let raw: string;
  try {
    raw = await readFile(attestationsPath(scopeRoot), 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const a = JSON.parse(line) as Partial<Attestation>;
      if (a.allowed === true && typeof a.sha === 'string' && a.sha !== '') out.add(a.sha);
    } catch {
      // torn/foreign line → skip
    }
  }
  return out;
}
