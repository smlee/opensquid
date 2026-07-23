/**
 * `staged_diff` (GFR.1c) — render the CODE artifact for the guess-free CODE producer.
 *
 * CODE has no doc-write artifact; its artifact is the DIFF (the actual changes). This reads the uncommitted
 * diff (tracked + staged `git diff HEAD`, plus deterministic patches for untracked files) so the content-audit can judge the qualitative code-rubric
 * criteria (alignment, doc-use, existing-solution, full-fix/no-MVP, re-audit-author) the deterministic
 * `code_ready` facets (phases/readiness/deprecated) cannot.
 *
 * Reuses the proven FIXED-ARGV git read (`execFile('git', ['diff', …], {cwd})` — no shell; precedent
 * readiness.ts:91, gate.ts:90, staged_docs_only.ts:48). FAIL-LOUD: no cwd / git error / empty diff / over-cap
 * ⇒ `null` (the producer runs no audit ⇒ the cache stays absent ⇒ the CODE gate fails closed). Never a
 * partial/truncated diff (a partial-diff verdict would be worse than none).
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

import { MAX_AUDIT_TEXT_BYTES } from '../runtime/audit_schema.js';
import { ok } from '../runtime/result.js';
import { readSessionCwd } from '../runtime/session_state.js';

import type { FunctionRegistry } from './registry.js';

const execFileP = promisify(execFile);

/** Injectable readers (tests pass pure stubs); defaults read every uncommitted tracked/staged/untracked file. */
export interface DiffDeps {
  cwd: (sessionId: string) => Promise<string | null>;
  run: (cwd: string) => Promise<string>;
}

function untrackedPatch(path: string, content: string): string {
  const label = /[\s"\\]/u.test(path) ? JSON.stringify(path) : path;
  const trailingNewline = content.endsWith('\n');
  const lines = content === '' ? [] : content.split('\n');
  if (trailingNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join('\n');
  return [
    `diff --git a/${label} b/${label}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${label}`,
    `@@ -0,0 +1,${String(lines.length)} @@`,
    body,
    ...(trailingNewline || content === '' ? [] : ['\\ No newline at end of file']),
    '',
  ].join('\n');
}

/** Read tracked, staged, and untracked files as one deterministic audit artifact without mutating the index. */
export async function readGitWorkingTreeDiff(cwd: string): Promise<string> {
  const [{ stdout: tracked }, { stdout: untrackedRaw }] = await Promise.all([
    execFileP('git', ['diff', '--binary', 'HEAD'], { cwd, maxBuffer: 20_000_000 }),
    execFileP('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd,
      maxBuffer: 20_000_000,
    }),
  ]);
  const paths = untrackedRaw
    .split('\0')
    .filter((path) => path !== '')
    .sort();
  const patches: string[] = [tracked];
  for (const path of paths) {
    const bytes = await readFile(join(cwd, path));
    if (bytes.includes(0)) {
      patches.push(`diff --git a/${path} b/${path}\nnew binary file b/${path}\n`);
    } else {
      patches.push(untrackedPatch(path, bytes.toString('utf8')));
    }
  }
  return patches.filter((patch) => patch !== '').join('\n');
}

const defaultDeps: DiffDeps = {
  cwd: readSessionCwd,
  run: readGitWorkingTreeDiff,
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
    return Buffer.byteLength(diff, 'utf8') > MAX_AUDIT_TEXT_BYTES ? null : diff; // shared audit byte cap
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
