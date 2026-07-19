import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { configuredLocalBranch } from '../setup/cli/gate.js';

const readProjectFile = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');

const deploy = readProjectFile('packs/builtin/fullstack-flow/procedure/deploy.md');

describe('fullstack-flow DEPLOY Git-ref policy', () => {
  it('pushes the already-selected semantic branch without WorkGraph refs or incidental tags', () => {
    const commitCommands = /## 3\.[\s\S]*?```bash\n([\s\S]*?)```/.exec(deploy)?.[1];

    expect(commitCommands).toContain('branch="$(opensquid gate branch)" || exit 1');
    expect(commitCommands!.indexOf('branch="$(opensquid gate branch)"')).toBeLessThan(
      commitCommands!.indexOf('git commit'),
    );
    expect(commitCommands).toContain('git push --no-follow-tags origin "HEAD:refs/heads/$branch"');
    expect(commitCommands).not.toContain('git tag');
    expect(commitCommands).not.toMatch(/git push (?!.*--no-follow-tags)/);
    expect(deploy).toContain('reserves Git tags for meaningful version boundaries');
    expect(deploy).not.toContain('auto/wg-');
    expect(deploy).not.toContain('<wg-id>-');
  });

  it('executes configured/default branch resolution and fails closed on mismatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-branch-policy-'));
    const local = join(root, 'local');
    const git = (args: string[]): string =>
      execFileSync('git', args, { cwd: local, encoding: 'utf8' }).trim();

    try {
      mkdirSync(local);
      git(['init', '.']);
      git(['config', 'user.name', 'OpenSquid Test']);
      git(['config', 'user.email', 'opensquid@example.invalid']);
      git(['checkout', '-b', 'fix/semantic-deploy-policy']);
      git(['commit', '--allow-empty', '-m', 'test: establish branch']);
      mkdirSync(join(local, '.opensquid'));
      const active = join(local, '.opensquid', 'active.json');
      writeFileSync(
        active,
        JSON.stringify({
          packs: ['fullstack-flow'],
          'version-control': { environments: { production: 'main' } },
        }),
      );
      expect(await configuredLocalBranch(local)).toBe('fix/semantic-deploy-policy');

      writeFileSync(
        active,
        JSON.stringify({
          packs: ['fullstack-flow'],
          'version-control': {
            environments: { production: 'main', local: 'feat/different-work' },
          },
        }),
      );
      expect(await configuredLocalBranch(local)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('overrides push.followTags=true while pushing the explicit semantic branch', () => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-ref-policy-'));
    const local = join(root, 'local');
    const remote = join(root, 'remote.git');
    const git = (args: string[], cwd = local): string =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

    try {
      git(['init', '--bare', remote], root);
      git(['init', local], root);
      git(['config', 'user.name', 'OpenSquid Test']);
      git(['config', 'user.email', 'opensquid@example.invalid']);
      writeFileSync(join(local, 'work.txt'), 'verified\n');
      git(['add', 'work.txt']);
      git(['commit', '-m', 'test(deploy): verify explicit push policy']);
      git(['tag', '-a', 'unrelated-safety-tag', '-m', 'must stay local']);
      git(['config', 'push.followTags', 'true']);
      git(['remote', 'add', 'origin', remote]);

      git(['push', '--no-follow-tags', 'origin', 'HEAD:refs/heads/fix/semantic-deploy-policy']);

      expect(() =>
        git(['show-ref', '--verify', 'refs/heads/fix/semantic-deploy-policy'], remote),
      ).not.toThrow();
      expect(() =>
        git(['show-ref', '--verify', 'refs/tags/unrelated-safety-tag'], remote),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
