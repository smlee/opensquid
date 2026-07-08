/**
 * Role: idempotently ensure ONE PR from head → base is open.
 * Context: GhIo (+ optional prView); head/base from IntegrationPlan.
 * Constraints: fail-visible on gh errors; never auto-merge; view-or-create.
 * Output: { url, created }.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { GhAuthError, type GhIo } from './stage_pr.js';

const execFileP = promisify(execFile);

/** Extended gh seam for ensure-PR (view || create). */
export interface EnsurePrIo extends GhIo {
  /** Return existing open PR url for head→base, or null if none. */
  prView: (a: { base: string; head: string }, cwd: string) => Promise<string | null>;
}

export const realEnsurePrIo: EnsurePrIo = {
  ghAuthOk: async (cwd) =>
    execFileP('gh', ['auth', 'status'], { cwd })
      .then(() => true)
      .catch(() => false),
  prCreate: async (a, cwd) => {
    const { stdout } = await execFileP(
      'gh',
      ['pr', 'create', '--base', a.base, '--head', a.head, '--title', a.title, '--body', a.body],
      { cwd },
    );
    return stdout.trim();
  },
  latestPrefixTag: async (prefix, cwd) => {
    const { latestPrefixTag } = await import('./release_core.js');
    return latestPrefixTag(prefix, cwd);
  },
  tagPush: async (tag, cwd) => {
    await execFileP('git', ['tag', tag], { cwd });
    await execFileP('git', ['push', 'origin', tag], { cwd });
  },
  prView: async (a, cwd) => {
    try {
      const { stdout } = await execFileP(
        'gh',
        [
          'pr',
          'view',
          a.head,
          '--base',
          a.base,
          '--json',
          'url,state',
          '--jq',
          'select(.state=="OPEN") | .url',
        ],
        { cwd },
      );
      const url = stdout.trim();
      return url.length > 0 ? url : null;
    } catch {
      return null;
    }
  },
};

/**
 * Role: ensure exactly one open PR head→base (idempotent).
 * Context: pr args + cwd + EnsurePrIo (or GhIo — prView optional via realEnsurePrIo).
 * Constraints: no gh auth → GhAuthError; never merges.
 * Output: { url, created }.
 */
export async function ensurePr(
  a: { base: string; head: string; title: string; body: string },
  cwd: string,
  io: GhIo | EnsurePrIo,
): Promise<{ url: string; created: boolean }> {
  if (!(await io.ghAuthOk(cwd))) {
    throw new GhAuthError(`gh is not authenticated — cannot ensure PR ${a.head} → ${a.base}`);
  }
  const view = 'prView' in io && typeof io.prView === 'function' ? io.prView : null;
  if (view !== null) {
    const existing = await view({ base: a.base, head: a.head }, cwd);
    if (existing !== null) return { url: existing, created: false };
  }
  const url = await io.prCreate(a, cwd);
  return { url, created: true };
}
