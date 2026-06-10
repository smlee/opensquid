/**
 * GF.2 — install / check the opensquid-managed git `pre-commit` + `pre-push` hooks.
 *
 * PGB.1 (T-fix-pushgate-bypass): installation is a pure GATE-FIRST composition.
 * The previous installer APPENDED the gate call to a foreign hook — unsound for any
 * foreign hook that ends in `exec`/`exit` (the repo's own PP.1 quality hook does:
 * `exec pnpm prepush` made the appended gate block unreachable dead code, which is
 * how a code push bypassed the flow gate on 2026-06-10). `composeHook` now prepends
 * the managed block directly after the shebang, so the gate ALWAYS runs first and
 * the foreign body keeps its exact semantics afterward. It also REPAIRS any layout
 * where managed lines exist elsewhere (today's dead-block file), idempotently.
 *
 * The hooks carry the `@opensquid managed hook` MARKER so `opensquid doctor git-hooks`
 * can recognise them. `checkGitHooks` additionally detects `unreachable` — marker
 * present but a process-terminating line (`exec`/`exit`) precedes it. Installation is
 * OPT-IN (explicit `opensquid gate install`), never automatic; a foreign hook body is
 * preserved verbatim, never clobbered.
 *
 * Imported by: src/setup/cli/gate.ts (install), src/setup/cli/doctor.ts (check).
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const OPENSQUID_HOOK_MARKER = '@opensquid managed hook';

type HookBoundary = 'commit' | 'push' | 'attest';

const HOOKS: readonly { name: string; boundary: HookBoundary }[] = [
  { name: 'pre-commit', boundary: 'commit' },
  { name: 'pre-push', boundary: 'push' },
  // PGB.2 — post-commit records flow provenance (attestations.jsonl) so a later
  // session can push these commits without re-proving the flow. `gate attest`
  // always exits 0; the `|| exit $?` from gateLine is harmless here.
  { name: 'post-commit', boundary: 'attest' },
];

const gateLine = (boundary: HookBoundary): string => `opensquid gate ${boundary} || exit $?`;
const managedBlock = (boundary: HookBoundary): string =>
  `# ${OPENSQUID_HOOK_MARKER}\n${gateLine(boundary)}`;

export type GitHookState = 'installed' | 'missing' | 'foreign' | 'unreachable';
export interface GitHookStatus {
  name: string;
  state: GitHookState;
}

const hooksDir = (repoRoot: string): string => join(repoRoot, '.git', 'hooks');

/** A line after which nothing else in the script can run (process-replace or hard exit). */
const isTerminalLine = (l: string): boolean => /^\s*(exec\s|exit\b)/.test(l);

/**
 * Pure: compose an existing hook body (or null/empty) into the canonical gate-first
 * layout: shebang → managed block → foreign body verbatim. Strips ALL prior managed
 * lines wherever they sit, so it both installs and repairs (e.g. a gate block left
 * dead below a foreign `exec`). A foreign line that itself invokes `opensquid gate
 * <boundary>` is treated as managed and stripped — keeping it would double-run the
 * gate. Idempotent: composeHook(composeHook(x)) === composeHook(x).
 */
export function composeHook(existing: string | null, boundary: HookBoundary): string {
  if (existing === null || existing.trim() === '') {
    return `#!/bin/sh\n${managedBlock(boundary)}\n`;
  }
  const lines = existing
    .split('\n')
    .filter((l) => !l.includes(OPENSQUID_HOOK_MARKER) && !l.includes(`opensquid gate ${boundary}`));
  const shebang = lines[0]?.startsWith('#!') === true ? lines.shift()! : '#!/bin/sh';
  const body = lines.join('\n').replace(/^\n+/, '').replace(/\n*$/, '\n');
  if (body.trim() === '') {
    return `${shebang}\n${managedBlock(boundary)}\n`;
  }
  return `${shebang}\n${managedBlock(boundary)}\n${body}`;
}

/** Marker present but a terminal line precedes it → the managed gate can never run. */
export function isMarkerUnreachable(content: string): boolean {
  const lines = content.split('\n');
  const marker = lines.findIndex((l) => l.includes(OPENSQUID_HOOK_MARKER));
  if (marker === -1) return false;
  return lines.slice(0, marker).some(isTerminalLine);
}

/** Install (idempotent) both hooks into `<repoRoot>/.git/hooks` via gate-first
 *  composition. A foreign body is preserved verbatim BELOW the gate; a broken layout
 *  (dead managed block) is repaired. `installed` = the file is purely managed;
 *  `foreign` = a user body rides below the gate. */
export async function installGitHooks(repoRoot: string): Promise<GitHookStatus[]> {
  const dir = hooksDir(repoRoot);
  await mkdir(dir, { recursive: true });
  const out: GitHookStatus[] = [];
  for (const { name, boundary } of HOOKS) {
    const path = join(dir, name);
    const existing = await readFile(path, 'utf8').catch(() => null);
    const next = composeHook(existing, boundary);
    if (next !== existing) await writeFile(path, next, 'utf8');
    await chmod(path, 0o755);
    const pureManaged = next === composeHook(null, boundary);
    out.push({ name, state: pureManaged ? 'installed' : 'foreign' });
  }
  return out;
}

/** Report installation state without writing. `missing` = no hook; `foreign` = a hook
 *  exists but carries no opensquid marker; `unreachable` = the marker exists but a
 *  preceding `exec`/`exit` makes the gate dead code; `installed` = the gate runs. */
export async function checkGitHooks(repoRoot: string): Promise<GitHookStatus[]> {
  const dir = hooksDir(repoRoot);
  const out: GitHookStatus[] = [];
  for (const { name } of HOOKS) {
    const existing = await readFile(join(dir, name), 'utf8').catch(() => null);
    if (existing === null) out.push({ name, state: 'missing' });
    else if (!existing.includes(OPENSQUID_HOOK_MARKER)) out.push({ name, state: 'foreign' });
    else if (isMarkerUnreachable(existing)) out.push({ name, state: 'unreachable' });
    else out.push({ name, state: 'installed' });
  }
  return out;
}
