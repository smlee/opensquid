/** runRelease — ensure-PR only (no stage batching); injected seams. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRelease, type ReleaseDeps } from './release.js';
import type { IntegrationPlan } from '../../runtime/release/version_control.js';

const plan: IntegrationPlan = {
  target: 'stage',
  prHead: 'stage',
  prBase: 'main',
  hasStaging: true,
  production: 'main',
  local: 'local',
  staging: 'stage',
};

function deps(over: Partial<ReleaseDeps> = {}): ReleaseDeps & {
  calls: { ensure: unknown[][] };
} {
  const calls = { ensure: [] as unknown[][] };
  const base: ReleaseDeps = {
    versionControl: () => Promise.resolve({ plan }),
    ensurePr: (a, cwd) => {
      calls.ensure.push([a, cwd]);
      return Promise.resolve({ url: 'https://example/pr/1', created: true });
    },
    ...over,
  };
  return Object.assign(base, { calls });
}

describe('runRelease — ensure PR only', () => {
  it('opens/ensures PR from plan; exit 0', async () => {
    const d = deps();
    expect(await runRelease('/repo', d)).toBe(0);
    expect(d.calls.ensure).toHaveLength(1);
    expect(d.calls.ensure[0]?.[0]).toMatchObject({ base: 'main', head: 'stage' });
  });

  it('missing version-control → refuse', async () => {
    const d = deps({ versionControl: () => Promise.resolve(null) });
    expect(await runRelease('/repo', d)).not.toBe(0);
    expect(d.calls.ensure).toHaveLength(0);
  });

  it('ensure failure → refuse (fail-visible)', async () => {
    const d = deps({
      ensurePr: () => Promise.reject(new Error('gh down')),
    });
    expect(await runRelease('/repo', d)).not.toBe(0);
  });

  it('never merges to production / never npm-publishes', () => {
    const src = readFileSync(join(__dirname, 'release.ts'), 'utf8');
    expect(src).not.toMatch(/mergeToMain|pr merge|npm['"\s]*publish/);
  });
});
