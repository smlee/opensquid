/**
 * LP.4 — unit tests for `opensquid pack` CLI subcommands.
 *
 * Strategy: drive each subcommand via its action() callback through a
 * test-injection seam (deps.out + deps.forceYes). tmpdir OPENSQUID_HOME
 * isolates per-test state.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildExportCommand,
  buildInstallCommand,
  buildListCommand,
  buildRemoveCommand,
} from './pack.js';

let tempHome: string;
let priorHome: string | undefined;

async function writePack(packDir: string, name: string, version: string): Promise<void> {
  await mkdir(packDir, { recursive: true });
  await writeFile(
    join(packDir, 'manifest.yaml'),
    [`name: ${name}`, `version: ${version}`, 'scope: workflow', `goal: fixture ${name}`].join(
      '\n',
    ) + '\n',
    'utf8',
  );
}

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-lp4-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

function captureOut(): {
  out: (line: string) => void;
  lines: string[];
} {
  const lines: string[] = [];
  return { out: (line) => lines.push(line), lines };
}

async function run(cmd: Command, args: string[]): Promise<void> {
  await cmd.parseAsync(['node', cmd.name(), ...args]);
}

describe('pack install', () => {
  it('fresh install writes base/ + version.json with manifest version', async () => {
    const source = join(tempHome, 'source-pack');
    await writePack(source, 'my-pack', '1.0.0');
    const cap = captureOut();
    const cmd = buildInstallCommand(cap);
    await run(cmd, [source]);
    const version = JSON.parse(
      await readFile(
        join(tempHome, 'packs', 'my-pack', 'personal_revision', 'version.json'),
        'utf8',
      ),
    ) as { base_version: string };
    expect(version.base_version).toBe('1.0.0');
    expect(cap.lines.some((l) => l.includes('Installed my-pack@1.0.0'))).toBe(true);
  });

  it('upgrade triggers 3-way merge + logs disposition counts', async () => {
    const source = join(tempHome, 'source-pack');
    await writePack(source, 'my-pack', '1.0.0');
    const installCmd = buildInstallCommand(captureOut());
    await run(installCmd, [source]);
    // Upgrade to v1.1.0
    await writeFile(
      join(source, 'manifest.yaml'),
      'name: my-pack\nversion: 1.1.0\nscope: workflow\ngoal: upgraded\n',
      'utf8',
    );
    const cap = captureOut();
    const upgradeCmd = buildInstallCommand(cap);
    await run(upgradeCmd, [source]);
    expect(cap.lines.some((l) => l.includes('Upgraded my-pack from 1.0.0 → 1.1.0'))).toBe(true);
    expect(cap.lines.some((l) => l.includes('dispositions:'))).toBe(true);
  });

  it('rejects downgrade (existing > new)', async () => {
    const source = join(tempHome, 'source-pack');
    await writePack(source, 'my-pack', '2.0.0');
    await run(buildInstallCommand(captureOut()), [source]);
    await writeFile(
      join(source, 'manifest.yaml'),
      'name: my-pack\nversion: 1.0.0\nscope: workflow\ngoal: downgrade\n',
      'utf8',
    );
    await expect(run(buildInstallCommand(captureOut()), [source])).rejects.toThrow(
      /Downgrade rejected/,
    );
  });

  it('rejects path-traversal pack names via validatePackId', async () => {
    const source = join(tempHome, 'source-pack');
    await mkdir(source, { recursive: true });
    // Use a manifest name that should pass schema regex but trip validatePackId
    // Since the schema regex /^[a-z0-9][a-z0-9-]*$/ already blocks ../ and /,
    // this case is actually defended at the schema layer — install never sees it.
    // Verify: schema rejection happens before validatePackId.
    await writeFile(
      join(source, 'manifest.yaml'),
      'name: ../escape\nversion: 1.0.0\nscope: workflow\ngoal: malicious\n',
      'utf8',
    );
    await expect(run(buildInstallCommand(captureOut()), [source])).rejects.toThrow();
  });
});

describe('pack list', () => {
  it('empty state → "No packs installed" message', async () => {
    const cap = captureOut();
    await run(buildListCommand(cap), []);
    expect(cap.lines.some((l) => l.includes('No packs installed'))).toBe(true);
  });

  it('lists 2 installed packs with base_version + revision_id', async () => {
    const s1 = join(tempHome, 'src1');
    const s2 = join(tempHome, 'src2');
    await writePack(s1, 'pack-a', '1.0.0');
    await writePack(s2, 'pack-b', '2.5.0');
    await run(buildInstallCommand(captureOut()), [s1]);
    await run(buildInstallCommand(captureOut()), [s2]);
    const cap = captureOut();
    await run(buildListCommand(cap), []);
    const joined = cap.lines.join('\n');
    expect(joined).toContain('pack-a');
    expect(joined).toContain('base=1.0.0');
    expect(joined).toContain('pack-b');
    expect(joined).toContain('base=2.5.0');
  });
});

describe('pack export', () => {
  it('default mode is lessons-only', async () => {
    const source = join(tempHome, 'src');
    await writePack(source, 'my-pack', '1.0.0');
    await run(buildInstallCommand(captureOut()), [source]);
    const outDir = join(tempHome, 'export-out');
    const cap = captureOut();
    await run(buildExportCommand(cap), ['my-pack', '--out', outDir]);
    expect(cap.lines.some((l) => l.includes('mode: lessons-only'))).toBe(true);
  });

  it('rejects invalid mode with allowed-values listed', async () => {
    const source = join(tempHome, 'src');
    await writePack(source, 'my-pack', '1.0.0');
    await run(buildInstallCommand(captureOut()), [source]);
    await expect(
      run(buildExportCommand(captureOut()), ['my-pack', '--mode', 'bogus']),
    ).rejects.toThrow(/lessons-only \| raw/);
  });

  it('rejects export of uninstalled pack', async () => {
    await expect(run(buildExportCommand(captureOut()), ['nonexistent'])).rejects.toThrow(
      /is not installed/,
    );
  });

  it('raw mode includes version.json in the output dir', async () => {
    const source = join(tempHome, 'src');
    await writePack(source, 'my-pack', '1.0.0');
    await run(buildInstallCommand(captureOut()), [source]);
    const outDir = join(tempHome, 'export-raw');
    await run(buildExportCommand(captureOut()), ['my-pack', '--mode', 'raw', '--out', outDir]);
    const versionRaw = await readFile(join(outDir, 'personal_revision', 'version.json'), 'utf8');
    expect(JSON.parse(versionRaw)).toMatchObject({ base_version: '1.0.0' });
  });
});

describe('pack remove', () => {
  it('removes base/ on --yes; preserves personal_revision/', async () => {
    const source = join(tempHome, 'src');
    await writePack(source, 'my-pack', '1.0.0');
    await run(buildInstallCommand(captureOut()), [source]);
    const cap = captureOut();
    await run(buildRemoveCommand(cap), ['my-pack', '--yes']);
    expect(cap.lines.some((l) => l.includes('Removed my-pack'))).toBe(true);
    expect(cap.lines.some((l) => l.includes('preserved personal_revision'))).toBe(true);
    // version.json still present
    const v = await readFile(
      join(tempHome, 'packs', 'my-pack', 'personal_revision', 'version.json'),
      'utf8',
    );
    expect(JSON.parse(v)).toMatchObject({ base_version: '1.0.0' });
  });

  it('--also-personal-revision deletes both', async () => {
    const source = join(tempHome, 'src');
    await writePack(source, 'my-pack', '1.0.0');
    await run(buildInstallCommand(captureOut()), [source]);
    const cap = captureOut();
    await run(buildRemoveCommand(cap), ['my-pack', '--yes', '--also-personal-revision']);
    expect(cap.lines.some((l) => l.includes('including personal_revision'))).toBe(true);
    await expect(
      readFile(join(tempHome, 'packs', 'my-pack', 'personal_revision', 'version.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('uninstalled pack → "not installed" message; no error', async () => {
    const cap = captureOut();
    await run(buildRemoveCommand(cap), ['ghost', '--yes']);
    expect(cap.lines.some((l) => l.includes('not installed'))).toBe(true);
  });
});
