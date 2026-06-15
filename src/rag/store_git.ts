/**
 * Git-versioned memory store (GVM.1, wg-7f4df49787cb).
 *
 * `~/.opensquid/store/` holds the per-file TRUTH — `lessons/` (one `mem-*.md` per memory) and
 * `issues/` (one `op-*.json` per work-graph op). The libSQL DB (`rag.sqlite`, a SIBLING of `store/`,
 * not inside it) is the derived, rebuildable index. This module puts `store/` under git so its commit
 * history IS the forensic archive + the rollback floor behind retention's hard-delete sweep
 * (wg-9e4f4eb2a40f slice-3): a memory demoted (`retired_at`) this session is committed at session
 * boundary BEFORE any future-session sweep can delete it, so its content is always recoverable.
 *
 * The store is git-versioned in place (mutable `mem-*.md`); git's commit history is the event log —
 * memory is NOT re-architected to an append-only op-log. The repo is machine-local: no remote, never
 * pushed, isolated from any project repo (`git -C <store>`), and a fixed opensquid identity so it
 * works with no global git config and never touches the user's identity.
 *
 * Imports from: node:child_process, node:fs/promises, node:path, node:util, ../runtime/paths.js.
 * Imported by: src/runtime/hooks/session-end.ts (the session-boundary snapshot).
 */

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { OPENSQUID_HOME } from '../runtime/paths.js';

const execFileP = promisify(execFile);
const IDENT = ['-c', 'user.name=opensquid', '-c', 'user.email=memory@opensquid.local'];

/** Commit the per-file memory+op store as a session-boundary snapshot. Inits the repo once; skips an
 *  empty commit. Fail-SOFT: never throws — a snapshot failure must never block session-end. Returns
 *  the short sha, or null (no store / no change / git failure). */
export async function commitMemoryStore(label: string): Promise<string | null> {
  const dir = join(OPENSQUID_HOME(), 'store');
  try {
    await stat(dir);
  } catch {
    return null; // no store yet → nothing to version
  }
  try {
    try {
      await execFileP('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree']);
    } catch {
      await execFileP('git', ['-C', dir, 'init', '-q']);
    }
    await execFileP('git', ['-C', dir, 'add', '-A']);
    const { stdout } = await execFileP('git', ['-C', dir, 'status', '--porcelain']);
    if (stdout.trim() === '') return null; // nothing changed → no empty commit
    await execFileP('git', ['-C', dir, ...IDENT, 'commit', '-q', '--no-verify', '-m', label]);
    const { stdout: sha } = await execFileP('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']);
    return sha.trim();
  } catch (e) {
    process.stderr.write(`opensquid: memory-store snapshot skipped — ${String(e)}\n`);
    return null;
  }
}
