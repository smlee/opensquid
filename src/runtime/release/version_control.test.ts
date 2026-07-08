/** version-control.environments resolve + read/write — pure + temp active.json (no git). */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveEnvironments,
  integrationPlan,
  readVersionControl,
  writeVersionControl,
} from './version_control.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function scope(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'vc-'));
  dirs.push(d);
  return d;
}

describe('resolveEnvironments — presence is the stage toggle', () => {
  it('requires production', () => {
    expect(resolveEnvironments({})).toEqual({
      ok: false,
      reason: 'version-control.environments.production is required',
    });
    expect(resolveEnvironments(undefined)).toMatchObject({ ok: false });
  });

  it('has-stage when staging is set; local defaults to production when unset', () => {
    const r = resolveEnvironments({ production: 'main', staging: 'stage' });
    expect(r).toEqual({
      ok: true,
      environments: { production: 'main', staging: 'stage', local: 'main' },
    });
    if (!r.ok) return;
    const plan = integrationPlan(r.environments);
    expect(plan.hasStaging).toBe(true);
    expect(plan.target).toBe('stage');
    expect(plan.prHead).toBe('stage');
    expect(plan.prBase).toBe('main');
  });

  it('no-stage when staging absent → direct PR local→production', () => {
    const r = resolveEnvironments({ production: 'main', local: 'local' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const plan = integrationPlan(r.environments);
    expect(plan.hasStaging).toBe(false);
    expect(plan.target).toBe('local');
    expect(plan.prHead).toBe('local');
    expect(plan.prBase).toBe('main');
  });
});

describe('readVersionControl / writeVersionControl', () => {
  it('round-trips environments + folded versioning', async () => {
    const d = await scope();
    await writeVersionControl(d, {
      environments: { production: 'main', staging: 'stage', local: 'dev' },
      versioning: { strategy: 'locked-prefix', prefix: '0.5', bump: 'patch-per-release' },
    });
    const vc = await readVersionControl(d);
    expect(vc?.environments).toEqual({ production: 'main', staging: 'stage', local: 'dev' });
    expect(vc?.plan.hasStaging).toBe(true);
    expect(vc?.versioning?.prefix).toBe('0.5');
    // legacy top-level versioning kept in sync
    const disk = JSON.parse(await readFile(join(d, 'active.json'), 'utf8')) as {
      versioning: { prefix: string };
    };
    expect(disk.versioning.prefix).toBe('0.5');
  });

  it('null when environments absent / malformed', async () => {
    expect(await readVersionControl(null)).toBeNull();
    const d = await scope();
    await writeFile(join(d, 'active.json'), JSON.stringify({ packs: [] }));
    expect(await readVersionControl(d)).toBeNull();
  });
});
