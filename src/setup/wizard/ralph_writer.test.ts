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

  it('the schema enforces T > W (claimTtlSec*1000 > wallClockMs) — anti double-ship (S7)', () => {
    // T <= W → a long lap outruns its claim → double-ship; must be rejected fail-loud.
    expect(() =>
      RalphConfigFileSchema.parse({
        ...defaultRalphConfig(home),
        claimTtlSec: 60,
        wallClockMs: 120_000,
      }),
    ).toThrow(/T > W/);
    // the defaults satisfy T > W (1h claim TTL > 30m deadline)
    expect(() => RalphConfigFileSchema.parse(defaultRalphConfig(home))).not.toThrow();
  });
});

describe('harness.kind discriminator (MHL.1/MHL.2)', () => {
  it('an existing config with NO `kind` parses → kind defaults to claude (backward-compat)', () => {
    const parsed = RalphConfigFileSchema.parse({
      authMode: 'subscription',
      maxBudgetUsd: 10,
      claimTtlSec: 3600,
      wallClockMs: 1_800_000,
      maxRetries: 3,
      backoffBaseMs: 2000,
      harness: { cli: 'claude', ralphMdPath: '/x/RALPH.md' }, // no `kind` — the old on-disk shape
    });
    expect(parsed.harness.kind).toBe('claude');
  });

  it('a kind:codex config with sandbox + askForApproval round-trips through the schema', () => {
    const parsed = RalphConfigFileSchema.parse({
      ...defaultRalphConfig(home),
      harness: {
        cli: 'codex',
        ralphMdPath: '/x/RALPH.md',
        kind: 'codex',
        sandbox: 'workspace-write',
        askForApproval: 'never',
      },
    });
    expect(parsed.harness).toMatchObject({
      kind: 'codex',
      sandbox: 'workspace-write',
      askForApproval: 'never',
    });
  });

  it('fail-loud: an unimplemented harness.kind is REJECTED at load (no false capability)', () => {
    expect(() =>
      RalphConfigFileSchema.parse({
        ...defaultRalphConfig(home),
        harness: { cli: 'gemini', ralphMdPath: '/x/RALPH.md', kind: 'gemini' },
      }),
    ).toThrow();
  });

  it('the config carries NO raw args[] override field (adapter-owned invariant, §5 Q4)', () => {
    const parsed = RalphConfigFileSchema.parse(defaultRalphConfig(home));
    expect('args' in parsed.harness).toBe(false);
  });

  it('CFS.1: harness.model + harness.pricing round-trip through the schema', () => {
    const parsed = RalphConfigFileSchema.parse({
      ...defaultRalphConfig(home),
      harness: {
        cli: 'codex',
        ralphMdPath: '/x/RALPH.md',
        kind: 'codex',
        model: 'gpt-5-codex',
        pricing: {
          models: { 'gpt-5-codex': { inputPerMTok: 1.25, outputPerMTok: 10 } },
          default: 'gpt-5-codex',
        },
      },
    });
    expect(parsed.harness).toMatchObject({
      model: 'gpt-5-codex',
      pricing: {
        models: { 'gpt-5-codex': { inputPerMTok: 1.25, outputPerMTok: 10 } },
        default: 'gpt-5-codex',
      },
    });
  });

  it('CFS.1: a config OMITTING harness.model/pricing parses byte-unchanged (default-preservation)', () => {
    const parsed = RalphConfigFileSchema.parse(defaultRalphConfig(home));
    expect('model' in parsed.harness).toBe(false);
    expect('pricing' in parsed.harness).toBe(false);
  });

  it('CFS.1: the schema rejects a negative per-model rate (fail-loud on a bad rate)', () => {
    expect(() =>
      RalphConfigFileSchema.parse({
        ...defaultRalphConfig(home),
        harness: {
          cli: 'codex',
          ralphMdPath: '/x/RALPH.md',
          kind: 'codex',
          pricing: { models: { m: { inputPerMTok: -1, outputPerMTok: 1 } } },
        },
      }),
    ).toThrow();
  });
});
