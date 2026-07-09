import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkGitHooks,
  composeHook,
  installGitHooks,
  isMarkerUnreachable,
  OPENSQUID_HOOK_MARKER,
} from './git-hooks.js';

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'opensquid-githooks-'));
  await mkdir(join(repo, '.git', 'hooks'), { recursive: true });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/** PP.1's exact installed bytes (scripts/install-git-hooks.sh heredoc). */
const PP1_HOOK = `#!/bin/sh
# opensquid repo pre-push quality gate — installed by scripts/install-git-hooks.sh (PP.1).
exec pnpm prepush
`;

/** The REAL dead-block layout found live on 2026-06-10 (gate appended below PP.1's exec). */
const DEAD_BLOCK_HOOK = `#!/bin/sh
# opensquid repo pre-push quality gate — installed by scripts/install-git-hooks.sh (PP.1).
exec pnpm prepush

# ${OPENSQUID_HOOK_MARKER}
opensquid gate push || exit $?
`;

describe('PGB.1 — composeHook (pure, gate-first)', () => {
  const cases: { name: string; existing: string | null; boundary: 'commit' | 'push' }[] = [
    { name: 'null → canonical managed', existing: null, boundary: 'push' },
    { name: 'empty string → canonical managed', existing: '', boundary: 'commit' },
    { name: 'PP.1 exec hook', existing: PP1_HOOK, boundary: 'push' },
    { name: 'live dead-block hook', existing: DEAD_BLOCK_HOOK, boundary: 'push' },
    { name: 'foreign exit-0 hook', existing: '#!/bin/sh\necho mine\nexit 0\n', boundary: 'commit' },
    { name: 'shebang-less foreign hook', existing: 'echo naked\n', boundary: 'commit' },
  ];

  it.each(cases)(
    '$name: gate line precedes any foreign line; idempotent',
    ({ existing, boundary }) => {
      const once = composeHook(existing, boundary);
      // idempotence — repair of a repaired file is a no-op
      expect(composeHook(once, boundary)).toBe(once);
      const lines = once.split('\n');
      expect(lines[0]).toMatch(/^#!/);
      const gateIdx = lines.findIndex((l) => l.includes(`opensquid gate ${boundary}`));
      expect(gateIdx).toBeGreaterThan(0);
      // nothing terminal before the gate — the gate is always reachable
      expect(lines.slice(0, gateIdx).some((l) => /^\s*(exec\s|exit\b)/.test(l))).toBe(false);
      expect(isMarkerUnreachable(once)).toBe(false);
    },
  );

  it('PP.1 hook: foreign body preserved verbatim below the gate', () => {
    const composed = composeHook(PP1_HOOK, 'push');
    expect(composed).toContain('exec pnpm prepush');
    expect(composed).toContain('installed by scripts/install-git-hooks.sh (PP.1)');
    const lines = composed.split('\n');
    const gateIdx = lines.findIndex((l) => l.includes('opensquid gate push'));
    const execIdx = lines.findIndex((l) => l.includes('exec pnpm prepush'));
    expect(gateIdx).toBeLessThan(execIdx);
  });

  it('dead-block hook: repaired with NO duplicate gate or marker lines', () => {
    const composed = composeHook(DEAD_BLOCK_HOOK, 'push');
    expect(composed.split('\n').filter((l) => l.includes('opensquid gate push'))).toHaveLength(1);
    expect(composed.split('\n').filter((l) => l.includes(OPENSQUID_HOOK_MARKER))).toHaveLength(1);
    expect(composed).toContain('exec pnpm prepush'); // quality chain survives the repair
  });

  it('old pure-managed exec-form hook upgrades to the canonical non-exec form', () => {
    const old = `#!/bin/sh\n# ${OPENSQUID_HOOK_MARKER}\nexec opensquid gate commit\n`;
    expect(composeHook(old, 'commit')).toBe(composeHook(null, 'commit'));
  });
});

describe('PGB.1 — isMarkerUnreachable', () => {
  it('true for the live dead-block layout', () => {
    expect(isMarkerUnreachable(DEAD_BLOCK_HOOK)).toBe(true);
  });
  it('false for a canonical managed hook', () => {
    expect(isMarkerUnreachable(composeHook(null, 'push'))).toBe(false);
  });
  it('false when there is no marker at all', () => {
    expect(isMarkerUnreachable(PP1_HOOK)).toBe(false);
  });
  it('true when an exit precedes the marker', () => {
    expect(isMarkerUnreachable(`#!/bin/sh\nexit 0\n# ${OPENSQUID_HOOK_MARKER}\n`)).toBe(true);
  });
});

describe('GF.2 — git-hooks installer', () => {
  it('installs both managed hooks (marker + gate call); check reports installed', async () => {
    const res = await installGitHooks(repo);
    expect(res).toEqual([
      { name: 'pre-commit', state: 'installed' },
      { name: 'commit-msg', state: 'installed' },
      { name: 'pre-push', state: 'installed' },
      { name: 'post-commit', state: 'installed' },
    ]);
    const body = await readFile(join(repo, '.git', 'hooks', 'pre-commit'), 'utf8');
    expect(body).toContain(OPENSQUID_HOOK_MARKER);
    expect(body).toContain('opensquid gate commit');
    const attest = await readFile(join(repo, '.git', 'hooks', 'post-commit'), 'utf8');
    expect(attest).toContain('opensquid gate attest');
    // REL.3 — the commit-msg hook forwards the message-file path as a quoted $1.
    const commitMsg = await readFile(join(repo, '.git', 'hooks', 'commit-msg'), 'utf8');
    expect(commitMsg).toContain('opensquid gate commit-msg "$1"');
    expect(await checkGitHooks(repo)).toEqual([
      { name: 'pre-commit', state: 'installed' },
      { name: 'commit-msg', state: 'installed' },
      { name: 'pre-push', state: 'installed' },
      { name: 'post-commit', state: 'installed' },
    ]);
  });

  it('is idempotent on re-install', async () => {
    await installGitHooks(repo);
    const first = await readFile(join(repo, '.git', 'hooks', 'pre-push'), 'utf8');
    const res = await installGitHooks(repo);
    expect(res.every((h) => h.state === 'installed')).toBe(true);
    expect(await readFile(join(repo, '.git', 'hooks', 'pre-push'), 'utf8')).toBe(first);
  });

  it('CHAINS a foreign hook gate-FIRST instead of clobbering it', async () => {
    const path = join(repo, '.git', 'hooks', 'pre-commit');
    await writeFile(path, '#!/bin/sh\necho mine\n', 'utf8');
    const res = await installGitHooks(repo);
    expect(res.find((h) => h.name === 'pre-commit')?.state).toBe('foreign');
    const body = await readFile(path, 'utf8');
    expect(body).toContain('echo mine'); // user's hook preserved
    expect(body).toContain('opensquid gate commit'); // gate call present
    const lines = body.split('\n');
    expect(lines.findIndex((l) => l.includes('opensquid gate commit'))).toBeLessThan(
      lines.findIndex((l) => l.includes('echo mine')),
    ); // ...and it runs FIRST
  });

  it('REPAIRS the live dead-block layout (gate below a foreign exec)', async () => {
    const path = join(repo, '.git', 'hooks', 'pre-push');
    await writeFile(path, DEAD_BLOCK_HOOK, 'utf8');
    expect(await checkGitHooks(repo)).toContainEqual({ name: 'pre-push', state: 'unreachable' });
    const res = await installGitHooks(repo);
    expect(res.find((h) => h.name === 'pre-push')?.state).toBe('foreign'); // chained, body retained
    const status = await checkGitHooks(repo);
    expect(status.find((h) => h.name === 'pre-push')?.state).toBe('installed'); // gate reachable
    const body = await readFile(path, 'utf8');
    expect(isMarkerUnreachable(body)).toBe(false);
    expect(body).toContain('exec pnpm prepush');
  });

  it('check reports missing when no hooks present', async () => {
    expect(await checkGitHooks(repo)).toEqual([
      { name: 'pre-commit', state: 'missing' },
      { name: 'commit-msg', state: 'missing' },
      { name: 'pre-push', state: 'missing' },
      { name: 'post-commit', state: 'missing' },
    ]);
  });

  it('REL.3 — composeHook(commit-msg) forwards the message file as a quoted $1', () => {
    const composed = composeHook(null, 'commit-msg');
    expect(composed).toContain('opensquid gate commit-msg "$1" || exit $?');
    expect(composed).toContain(OPENSQUID_HOOK_MARKER);
    // idempotent + gate-first
    expect(composeHook(composed, 'commit-msg')).toBe(composed);
  });
});
