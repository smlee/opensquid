import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installRalph,
  readRalphConfig,
  defaultRalphConfig,
  ralphMdPath,
  ralphConfigPath,
  RalphConfigFileSchema,
} from './ralph_writer.js';
import { RALPH_MD } from '../../runtime/ralph/ralph_template.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ralph-writer-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('installRalph', () => {
  it('first run creates RALPH.md + ralph.config.json', async () => {
    const r = await installRalph({ home });
    expect(r.ralphMd.outcome).toBe('created');
    expect(r.config.outcome).toBe('created');
    expect(await readFile(ralphMdPath(home), 'utf8')).toBe(RALPH_MD);
    const cfg = await readRalphConfig(home);
    expect(cfg).toEqual(defaultRalphConfig(home));
  });

  it('second run with same inputs is a no-op diff (idempotent)', async () => {
    await installRalph({ home });
    const r2 = await installRalph({ home });
    expect(r2.ralphMd.outcome).toBe('unchanged');
    expect(r2.config.outcome).toBe('unchanged');
    expect(existsSync(`${ralphConfigPath(home)}.bak`)).toBe(false); // no backup for a no-op
  });

  it('divergent config → snapshots .bak then replaces', async () => {
    await installRalph({ home });
    const r2 = await installRalph({ home, overrides: { authMode: 'api', maxBudgetUsd: 25 } });
    expect(r2.config.outcome).toBe('replaced');
    expect(existsSync(`${ralphConfigPath(home)}.bak`)).toBe(true);
    const cfg = await readRalphConfig(home);
    expect(cfg?.authMode).toBe('api');
    expect(cfg?.maxBudgetUsd).toBe(25);
  });

  it('a partial harness override does not drop the sibling field', async () => {
    const r = await installRalph({ home, overrides: { harness: { cli: 'codex' } as never } });
    expect(r.config.outcome).toBe('created');
    const cfg = await readRalphConfig(home);
    expect(cfg?.harness.cli).toBe('codex');
    expect(cfg?.harness.ralphMdPath).toBe(ralphMdPath(home)); // sibling preserved from defaults
  });
});

describe('readRalphConfig', () => {
  it('returns null when not configured (loop OFF)', async () => {
    expect(await readRalphConfig(home)).toBeNull();
  });

  it('fail-loud: an invalid persisted config throws (Zod)', async () => {
    await writeFile(ralphConfigPath(home), JSON.stringify({ authMode: 'nope' }));
    await expect(readRalphConfig(home)).rejects.toThrow();
  });

  it('the schema rejects a non-positive budget', () => {
    expect(() =>
      RalphConfigFileSchema.parse({ ...defaultRalphConfig(home), maxBudgetUsd: 0 }),
    ).toThrow();
  });
});
