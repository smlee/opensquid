/**
 * GF.2 — install / check the opensquid-managed git `pre-commit` + `pre-push` hooks.
 *
 * The hooks are tiny POSIX-sh shims that `exec opensquid gate <boundary>` (see
 * `src/setup/cli/gate.ts`). They carry the `@opensquid managed hook` MARKER so
 * `opensquid doctor git-hooks` can recognise them — the same marker idiom the Claude
 * Code settings-writer uses. Installation is OPT-IN (explicit `opensquid gate install`),
 * never automatic, so opensquid never silently rewrites a user's git hooks. A pre-existing
 * FOREIGN hook is CHAINED (the gate call is appended), not clobbered.
 *
 * Imported by: src/setup/cli/gate.ts (install), src/setup/cli/doctor.ts (check).
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const OPENSQUID_HOOK_MARKER = '@opensquid managed hook';

const HOOKS: readonly { name: string; boundary: 'commit' | 'push' }[] = [
  { name: 'pre-commit', boundary: 'commit' },
  { name: 'pre-push', boundary: 'push' },
];

const managedBody = (boundary: 'commit' | 'push'): string =>
  `#!/bin/sh\n# ${OPENSQUID_HOOK_MARKER}\nexec opensquid gate ${boundary}\n`;

export type GitHookState = 'installed' | 'missing' | 'foreign';
export interface GitHookStatus {
  name: string;
  state: GitHookState;
}

const hooksDir = (repoRoot: string): string => join(repoRoot, '.git', 'hooks');

/** Install (idempotent) both hooks into `<repoRoot>/.git/hooks`. A foreign existing hook
 *  is chained (the gate call appended) so a user's own hook keeps running. */
export async function installGitHooks(repoRoot: string): Promise<GitHookStatus[]> {
  const dir = hooksDir(repoRoot);
  await mkdir(dir, { recursive: true });
  const out: GitHookStatus[] = [];
  for (const { name, boundary } of HOOKS) {
    const path = join(dir, name);
    const existing = await readFile(path, 'utf8').catch(() => null);
    if (existing !== null && !existing.includes(OPENSQUID_HOOK_MARKER)) {
      // Foreign hook present — chain rather than clobber (idempotent on the gate line).
      if (!existing.includes(`opensquid gate ${boundary}`)) {
        const chained = `${existing.replace(/\n*$/, '\n')}\n# ${OPENSQUID_HOOK_MARKER}\nopensquid gate ${boundary} || exit $?\n`;
        await writeFile(path, chained, 'utf8');
      }
      out.push({ name, state: 'foreign' });
    } else {
      await writeFile(path, managedBody(boundary), 'utf8');
      out.push({ name, state: 'installed' });
    }
    await chmod(path, 0o755);
  }
  return out;
}

/** Report installation state without writing. `missing` = no hook; `foreign` = a hook
 *  exists but carries no opensquid marker; `installed` = opensquid-managed. */
export async function checkGitHooks(repoRoot: string): Promise<GitHookStatus[]> {
  const dir = hooksDir(repoRoot);
  const out: GitHookStatus[] = [];
  for (const { name } of HOOKS) {
    const existing = await readFile(join(dir, name), 'utf8').catch(() => null);
    if (existing === null) out.push({ name, state: 'missing' });
    else if (existing.includes(OPENSQUID_HOOK_MARKER)) out.push({ name, state: 'installed' });
    else out.push({ name, state: 'foreign' });
  }
  return out;
}
