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
import type { LapHarnessCfg } from '../../runtime/ralph/lap_harness.js';
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
} from '../../runtime/ralph/harnesses/codex_lap_harness.js';

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
    // cli+kind overridden as a CONSISTENT pair (the CH.1 cross-field gate rejects {kind:claude,cli:codex});
    // the point is that ralphMdPath (the un-overridden sibling) survives the partial-harness merge.
    const r = await installRalph({
      home,
      overrides: { harness: { cli: 'codex', kind: 'codex' } as never },
    });
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

describe('CH.1 — cross-field kind/cli reject + askForApproval enum + SSOT types', () => {
  // A well-formed base with T > W satisfied; `withHarness` overrides only the harness fields under test so a
  // rejection pins the RIGHT field (not the T>W refine or a budget). ralphMdPath is required (min(1)).
  const base = {
    authMode: 'subscription',
    maxBudgetUsd: 1,
    claimTtlSec: 3600,
    wallClockMs: 600_000,
    maxRetries: 3,
    backoffBaseMs: 1000,
  } as const;
  const withHarness = (h: Record<string, unknown>) => ({
    ...base,
    harness: { cli: 'codex', ralphMdPath: '/x/RALPH.md', kind: 'codex', ...h },
  });

  // (a) CROSS-FIELD REJECT
  it('rejects a kind/cli mismatch (the other kind’s binary) with an issue at harness.cli', () => {
    const r = RalphConfigFileSchema.safeParse(withHarness({ kind: 'codex', cli: 'claude' }));
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.some((i) => i.path.join('.') === 'harness.cli')).toBe(true);
  });
  it('tolerates a wrapper-path cli whose basename is not a registered kind', () => {
    expect(
      RalphConfigFileSchema.safeParse(withHarness({ kind: 'codex', cli: '/opt/wrap/codex-runner' }))
        .success,
    ).toBe(true);
  });
  it('accepts matching kind/cli (both directions)', () => {
    expect(
      RalphConfigFileSchema.safeParse(withHarness({ kind: 'codex', cli: 'codex' })).success,
    ).toBe(true);
    expect(
      RalphConfigFileSchema.safeParse(withHarness({ kind: 'claude', cli: 'claude' })).success,
    ).toBe(true);
  });

  // (b) APPROVAL ENUM
  it('rejects an unsupported askForApproval (on-failure removed in 0.144.0) at harness.askForApproval', () => {
    const r = RalphConfigFileSchema.safeParse(
      withHarness({ cli: 'codex', askForApproval: 'on-failure' }),
    );
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.some((i) => i.path.join('.') === 'harness.askForApproval')).toBe(true);
  });
  it('rejects an arbitrary askForApproval string', () => {
    expect(
      RalphConfigFileSchema.safeParse(withHarness({ cli: 'codex', askForApproval: 'whatever' }))
        .success,
    ).toBe(false);
  });
  it('accepts the supported approval values; absent parses (optional preserved)', () => {
    for (const v of ['untrusted', 'on-request', 'never'])
      expect(
        RalphConfigFileSchema.safeParse(withHarness({ cli: 'codex', askForApproval: v })).success,
      ).toBe(true);
    expect(RalphConfigFileSchema.safeParse(withHarness({ cli: 'codex' })).success).toBe(true);
  });

  // (c) SANDBOX value-set intact + SSOT type-level assertion
  it('sandbox still validates the same three values (via CODEX_SANDBOX_MODES), rejecting an unknown mode', () => {
    for (const v of ['read-only', 'workspace-write', 'danger-full-access'])
      expect(
        RalphConfigFileSchema.safeParse(withHarness({ cli: 'codex', sandbox: v })).success,
      ).toBe(true);
    expect(
      RalphConfigFileSchema.safeParse(withHarness({ cli: 'codex', sandbox: 'yolo' })).success,
    ).toBe(false);
  });
  it('SSOT: the schema approval/sandbox output assigns into LapHarnessCfg with no cast (schema/cfg cannot drift)', () => {
    const parsed = RalphConfigFileSchema.parse(
      withHarness({ cli: 'codex', askForApproval: 'never', sandbox: 'read-only' }),
    );
    // Type-level proof: the schema's harness.askForApproval / .sandbox ARE the shared SSOT types (not `string`).
    // A drift back to `string` on the schema side would fail these assignments at compile time; the wire
    // (ralph.ts:150-153) spreads them conditionally into LapHarnessCfg (whose fields read the SAME types).
    const approval: CodexApprovalPolicy | undefined = parsed.harness.askForApproval;
    const sandbox: CodexSandboxMode | undefined = parsed.harness.sandbox;
    // …and each assigns into a LapHarnessCfg the way the wire does (only when defined — exactOptionalPropertyTypes).
    const cfg: LapHarnessCfg = {
      maxBudgetUsd: 1,
      ...(approval === undefined ? {} : { askForApproval: approval }),
      ...(sandbox === undefined ? {} : { sandbox }),
    };
    expect(cfg.askForApproval).toBe('never');
    expect(cfg.sandbox).toBe('read-only');
  });
});
