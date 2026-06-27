/**
 * T-multi-harness-enforce — the enforcement-hook writer (opensquid deny hook → each harness config).
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installEnforcementHooks } from './enforcement_hooks.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'osq-enforce-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const mk = (dir: string) => mkdir(join(root, dir), { recursive: true });
const readJson = async (p: string) =>
  JSON.parse(await readFile(join(root, p), 'utf8')) as Record<string, unknown>;

describe('installEnforcementHooks', () => {
  it('only writes for DETECTED harnesses (dir present)', async () => {
    const rep = await installEnforcementHooks(root); // no harness dirs
    expect(rep.written).toEqual([]);
    expect(rep.manual).toEqual([]);
  });

  it('Qwen: writes hooks.PreToolUse pointing at opensquid-hook-pretooluse', async () => {
    await mk('.qwen');
    const rep = await installEnforcementHooks(root);
    expect(rep.written.find((w) => w.harness === 'qwen')?.result).toBe('created');
    const cfg = (await readJson('.qwen/settings.json')).hooks as Record<string, unknown>;
    expect(JSON.stringify(cfg.PreToolUse)).toContain('opensquid-hook-pretooluse');
  });

  it('Cursor: sets failClosed:true (else fails OPEN)', async () => {
    await mk('.cursor');
    await installEnforcementHooks(root);
    const cfg = await readJson('.cursor/hooks.json');
    expect(JSON.stringify(cfg)).toContain('"failClosed":true');
    expect(JSON.stringify(cfg)).toContain('beforeShellExecution');
  });

  it('Windsurf: exit-2-only bare {command} on pre_run_command', async () => {
    await mk('.windsurf');
    await installEnforcementHooks(root);
    const cfg = (await readJson('.windsurf/hooks.json')).hooks as Record<string, unknown>;
    expect(JSON.stringify(cfg.pre_run_command)).toContain('opensquid-hook-pretooluse');
  });

  it('idempotent — re-run does not duplicate + reports unchanged', async () => {
    await mk('.qwen');
    await installEnforcementHooks(root);
    const rep2 = await installEnforcementHooks(root);
    expect(rep2.written.find((w) => w.harness === 'qwen')?.result).toBe('unchanged');
    const cfg = (await readJson('.qwen/settings.json')).hooks as { PreToolUse: unknown[] };
    expect(cfg.PreToolUse).toHaveLength(1); // not duplicated
  });

  it('preserves the user’s own hooks (foreign-safe)', async () => {
    await mk('.qwen');
    await writeFile(
      join(root, '.qwen', 'settings.json'),
      JSON.stringify({
        theme: 'dark',
        hooks: { PreToolUse: [{ matcher: 'X', hooks: [{ type: 'command', command: 'mine' }] }] },
      }),
      'utf8',
    );
    await installEnforcementHooks(root);
    const cfg = await readJson('.qwen/settings.json');
    expect(cfg.theme).toBe('dark'); // foreign top-level key preserved
    const arr = (cfg.hooks as { PreToolUse: unknown[] }).PreToolUse;
    expect(JSON.stringify(arr)).toContain('mine'); // user's hook preserved
    expect(JSON.stringify(arr)).toContain('opensquid-hook-pretooluse'); // + opensquid added
  });

  it('plugin/script harnesses (amp/opencode/cline) surface as manual when present', async () => {
    await mk('.clinerules');
    const rep = await installEnforcementHooks(root);
    expect(rep.manual.find((m) => m.harness === 'cline')).toBeDefined();
    expect(rep.written.find((w) => w.harness === 'cline')).toBeUndefined();
  });
});
