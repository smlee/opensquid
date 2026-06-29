/**
 * `staged_diff` (GFR.1c) — render the CODE artifact for the guess-free CODE producer.
 *
 * CODE has no doc-write artifact; its artifact is the DIFF (the actual changes). This reads the uncommitted
 * diff (`git diff HEAD` = working + staged vs HEAD) so the content-audit can judge the qualitative code-rubric
 * criteria (alignment, doc-use, existing-solution, full-fix/no-MVP, re-audit-author) the deterministic
 * `code_ready` facets (phases/readiness/deprecated) cannot.
 *
 * Reuses the proven FIXED-ARGV git read (`execFile('git', ['diff', …], {cwd})` — no shell; precedent
 * readiness.ts:91, gate.ts:90, staged_docs_only.ts:48). FAIL-LOUD: no cwd / git error / empty diff / over-cap
 * ⇒ `null` (the producer runs no audit ⇒ the cache stays absent ⇒ the CODE gate fails closed). Never a
 * partial/truncated diff (a partial-diff verdict would be worse than none).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { z } from 'zod';

import { ok } from '../runtime/result.js';
import { readSessionCwd } from '../runtime/session_state.js';

import type { FunctionRegistry } from './registry.js';

const execFileP = promisify(execFile);
// Diffs can be large; cap so the audit prompt stays bounded. Over-cap → null (never a partial-diff verdict).
const MAX_DIFF = 200_000;

/** Injectable readers (tests pass pure stubs); defaults read the session cwd + run `git diff HEAD`. */
export interface DiffDeps {
  cwd: (sessionId: string) => Promise<string | null>;
  run: (cwd: string) => Promise<string>;
}

const defaultDeps: DiffDeps = {
  cwd: readSessionCwd,
  run: async (cwd) => {
    const { stdout } = await execFileP('git', ['diff', 'HEAD'], { cwd, maxBuffer: 10_000_000 });
    return stdout;
  },
};

/** The uncommitted diff the CODE audit reviews, or null (no cwd / git error / empty / over-cap → fail-loud). */
export async function stagedDiff(
  sessionId: string,
  deps: DiffDeps = defaultDeps,
): Promise<string | null> {
  try {
    const cwd = await deps.cwd(sessionId);
    if (cwd === null) return null;
    const diff = await deps.run(cwd);
    if (diff.trim().length === 0) return null; // nothing to audit
    return diff.length > MAX_DIFF ? null : diff; // over-cap → null (never a partial diff)
  } catch {
    return null;
  }
}

export function registerStagedDiff(registry: FunctionRegistry): void {
  registry.register({
    name: 'staged_diff',
    argSchema: z.object({}).strict(),
    durable: false,
    memoizable: false, // re-read each call so the current diff is reflected
    costEstimateMs: 20,
    execute: async (_args, ctx) => ok(await stagedDiff(ctx.sessionId)),
  });
}
