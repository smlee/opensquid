/** AGF.2 (wg-f2f8e8609ee6) — branchNameFor (SSOT name) + autoPullMain (FF-only pull) over a throwaway two-clone
 *  git fixture (local, disposable — NO live repo, NO remote). Asserts: local main FFs to origin; a DIVERGED local
 *  main makes --ff-only reject (surfaced, never a silent merge commit). */
import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { branchNameFor, autoPullMain } from './auto_pull.js';

const x = promisify(execFile);
const git = (cwd: string, ...args: string[]): Promise<unknown> =>
  x('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
  });

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'agf2-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function commit(cwd: string, file: string, msg: string): Promise<void> {
  await writeFile(join(cwd, file), msg);
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-m', msg);
}

describe('AGF.2 branchNameFor — the auto/wg-<id> SSOT (never double-prefixed)', () => {
  it('is auto/<id>, and the wg- prefix is not doubled', () => {
    expect(branchNameFor('wg-abc123')).toBe('auto/wg-abc123');
  });
});

describe('AGF.2 autoPullMain — FF-only over a two-clone fixture', () => {
  it('fast-forwards local main to origin; the working tree ends on main', async () => {
    const origin = await tmp();
    await git(origin, 'init', '-b', 'main');
    await commit(origin, 'f', 'one');
    const local = await tmp();
    await x('git', ['clone', origin, local]);
    await commit(origin, 'f', 'two'); // origin advances

    await autoPullMain(local, 'origin');

    const { stdout: localHead } = (await git(local, 'rev-parse', 'HEAD')) as { stdout: string };
    const { stdout: originHead } = (await git(origin, 'rev-parse', 'HEAD')) as { stdout: string };
    expect(localHead.trim()).toBe(originHead.trim()); // real fast-forward
    const { stdout: branch } = (await git(local, 'rev-parse', '--abbrev-ref', 'HEAD')) as {
      stdout: string;
    };
    expect(branch.trim()).toBe('main');
  });

  it('a DIVERGED local main → --ff-only REJECTS (surfaced, never a silent merge commit)', async () => {
    const origin = await tmp();
    await git(origin, 'init', '-b', 'main');
    await commit(origin, 'f', 'one');
    const local = await tmp();
    await x('git', ['clone', origin, local]);
    await commit(origin, 'f', 'origin-two'); // origin advances
    await commit(local, 'g', 'local-two'); // local diverges

    await expect(autoPullMain(local, 'origin')).rejects.toBeTruthy();
  });
});
