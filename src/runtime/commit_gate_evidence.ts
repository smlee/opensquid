/**
 * `commit_gate_evidence` — the generic, pack-declared evidence the CORE commit-gate reads (T-deploy-commit-gate
 * scope-4, design §4a).
 *
 * GOVERNING RULE (design §4a): *nothing is coded into core except generic run-functions.* The commit gate
 * (`src/setup/cli/gate.ts`) previously hardcoded the `fullstack-flow-code-audit-cache` session-state KEY and the
 * 7-phase-ledger requirement — fullstack-flow POLICY living in CORE, a direct violation. This module moves the
 * POLICY to the PACK: a discipline pack declares a `commit_gate:` block in its `pack.yaml` naming WHICH evidence
 * authorizes a code commit; core reads whatever the active pack declares and carries NO `fullstack-flow-*` key.
 *
 * Resolution is MODULE-RELATIVE to the opensquid package (the exact precedent `read_rubric` sets: the pack's
 * canonical gate data ships inside the package at `packs/builtin/<pack>/`, NOT the consumer's cwd, so the
 * recurring sub-repo-vs-umbrella cwd split cannot misresolve it). Compiled to
 * `dist/runtime/commit_gate_evidence.js`, so `../..` is the package root.
 *
 * FAIL-SOFT read: a pack with no `commit_gate:` block, or an unreadable/malformed one, returns `null` — the
 * caller then falls back to its non-evidence path (v1 `coding-flow` uses the session-FSM check; it declares no
 * evidence, so it resolves to `null` here and keeps its existing behavior). The gate's own fail-CLOSED discipline
 * (a v2 pack whose FSM never reaches `phases_complete`) still holds when evidence is unexpectedly absent.
 *
 * Imported by: src/setup/cli/gate.ts (the commit-gate primitive); the `CommitGateBlock` schema is re-used by
 * src/packs/schemas/pack_v2.ts so the pack-load validation and this reader can never drift.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as yamlParse } from 'yaml';
import { z } from 'zod';

/**
 * The `commit_gate:` block a discipline pack declares in its `pack.yaml`. The SINGLE source for both the
 * pack-load validation (`PackV2`, via re-import) and this reader.
 *   - `audit_cache_key`     — the session-state key the CODE guess-free content-audit verdict is cached under
 *                             (the staleness-anchored `{verdict, subjectHash}` the gate checks). This is the KEY
 *                             that USED to be the `fullstack-flow-code-audit-cache` literal in core.
 *   - `require_phase_ledger`— the active task's 7-phase ledger must be complete before a code commit (default true).
 *   - `require_suite_green` — the DEPLOY verification-suite record must be green (scope-5 backstop; default false —
 *                             the gate does not consult it until scope-5 wires the read).
 */
export const CommitGateBlock = z
  .object({
    audit_cache_key: z.string().min(1),
    require_phase_ledger: z.boolean().default(true),
    require_suite_green: z.boolean().default(false),
  })
  .strict();
export type CommitGateBlock = z.infer<typeof CommitGateBlock>;

/** The evidence set in the shape core consumes (camelCase; the `pack.yaml` block is snake_case). */
export interface CommitGateEvidence {
  /** Session-state key of the CODE guess-free audit cache (`{verdict, subjectHash}`). */
  auditCacheKey: string;
  /** Require the active task's 7-phase ledger to be complete. */
  requirePhaseLedger: boolean;
  /** Require the DEPLOY suite record to be green (scope-5). */
  requireSuiteGreen: boolean;
}

// dist/runtime/commit_gate_evidence.js → ../.. = the package root; packs ship at `packs/builtin/<pack>/pack.yaml`.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Read the active discipline pack's declared commit-gate evidence, or `null` when the pack declares none
 * (v1 `coding-flow`) or its `pack.yaml` is absent/unreadable/malformed. Never throws.
 */
export async function readCommitGateEvidence(pack: string): Promise<CommitGateEvidence | null> {
  try {
    const raw = yamlParse(
      await readFile(join(PKG_ROOT, 'packs', 'builtin', pack, 'pack.yaml'), 'utf8'),
    ) as { commit_gate?: unknown };
    if (raw?.commit_gate === undefined) return null;
    const parsed = CommitGateBlock.safeParse(raw.commit_gate);
    if (!parsed.success) return null;
    return {
      auditCacheKey: parsed.data.audit_cache_key,
      requirePhaseLedger: parsed.data.require_phase_ledger,
      requireSuiteGreen: parsed.data.require_suite_green,
    };
  } catch {
    return null; // ENOENT (v1 pack, no pack.yaml) / parse fault → no evidence declared
  }
}
