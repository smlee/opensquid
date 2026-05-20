/**
 * Tests for CLI.4 — `opensquid permissions list|audit|grant|revoke`.
 *
 * Strategy mirrors webhooks.test.ts: a fresh tmpdir per test for
 * `~/.opensquid/permission_overrides.yaml` + `permission_audit.jsonl` +
 * `packs/`; commander parsed with injected stdout/stderr/now. The
 * override file is the moat we exercise — `grant + verify allow → revoke
 * + verify deny` is the round-trip. Built-in denylist patterns must not
 * round-trip without the `OPENSQUID_TRUST_BUILTIN_DENY=0` escape hatch.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CapabilityGate,
  type CapabilityVerdict,
  type PackPermissions,
} from '../../runtime/capability_gate.js';

import {
  appendAuditEntry,
  readOverridesFile,
  toRuntimeOverrides,
  type AuditEntry,
} from './permissions_state.js';
import { registerPermissions } from './permissions.js';

let stateRoot: string;
let overridesPath: string;
let auditPath: string;
let packsDir: string;
let outChunks: string[];
let errChunks: string[];
let priorHome: string | undefined;
let priorTrust: string | undefined;

const out = (s: string): void => {
  outChunks.push(s);
};
const errSink = (s: string): void => {
  errChunks.push(s);
};
const outText = (): string => outChunks.join('');
const errText = (): string => errChunks.join('');

const fixedNow = (): Date => new Date('2026-05-20T12:00:00Z');

async function seedPack(
  id: string,
  body: string,
  options: { skillsEmpty?: boolean } = {},
): Promise<void> {
  const packDir = join(packsDir, id);
  await mkdir(packDir, { recursive: true });
  await writeFile(join(packDir, 'manifest.yaml'), body, 'utf8');
  if (options.skillsEmpty !== false) {
    await mkdir(join(packDir, 'skills'), { recursive: true });
  }
}

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  priorTrust = process.env.OPENSQUID_TRUST_BUILTIN_DENY;
  // Default: trust the built-in denylist (mirror production).
  delete process.env.OPENSQUID_TRUST_BUILTIN_DENY;
  stateRoot = await mkdtemp(join(tmpdir(), 'opensquid-permissions-state-'));
  process.env.OPENSQUID_HOME = stateRoot;
  overridesPath = join(stateRoot, 'permission_overrides.yaml');
  auditPath = join(stateRoot, 'permission_audit.jsonl');
  packsDir = join(stateRoot, 'packs');
  outChunks = [];
  errChunks = [];
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  if (priorTrust === undefined) delete process.env.OPENSQUID_TRUST_BUILTIN_DENY;
  else process.env.OPENSQUID_TRUST_BUILTIN_DENY = priorTrust;
});

function build(): Command {
  const program = new Command();
  registerPermissions(program, {
    overridesPath,
    auditPath,
    packsDir,
    stdout: out,
    stderr: errSink,
    now: fixedNow,
  });
  return program;
}

const argv = (...args: string[]): string[] => ['node', 'cli', 'permissions', ...args];

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('opensquid permissions list', () => {
  it('reports empty when no packs + no overrides', async () => {
    await build().parseAsync(argv('list'));
    expect(outText()).toContain('(no packs');
  });

  it('returns per-pack declared permissions for --pack <id>', async () => {
    await seedPack(
      'ci',
      [
        'name: ci',
        'version: 0.1.0',
        'scope: project',
        'goal: continuous integration drift checks',
        'permissions:',
        '  shell_exec:',
        '    commands:',
        '      - pnpm typecheck',
        '    deny: []',
        '',
      ].join('\n'),
    );
    await build().parseAsync(argv('list', '--pack', 'ci'));
    const parsed = JSON.parse(outText()) as {
      packs: { pack: string; declared: { shell_exec?: { commands?: string[] } } }[];
    };
    expect(parsed.packs).toHaveLength(1);
    expect(parsed.packs[0]?.pack).toBe('ci');
    expect(parsed.packs[0]?.declared.shell_exec?.commands).toEqual(['pnpm typecheck']);
  });

  it('surfaces user overrides alongside declared permissions', async () => {
    await seedPack(
      'ci',
      [
        'name: ci',
        'version: 0.1.0',
        'scope: project',
        'goal: ci goal',
        'permissions:',
        '  shell_exec:',
        '    commands: [pnpm typecheck]',
        '    deny: []',
      ].join('\n'),
    );
    // Grant an additional target via the CLI.
    await build().parseAsync(argv('grant', 'ci', 'shell_exec', '--target', 'pnpm test'));
    outChunks = [];
    await build().parseAsync(argv('list', '--pack', 'ci'));
    const parsed = JSON.parse(outText()) as {
      packs: {
        pack: string;
        overrides: { capability: string; target: string }[];
      }[];
    };
    expect(parsed.packs[0]?.overrides).toEqual([
      expect.objectContaining({ capability: 'shell_exec', target: 'pnpm test' }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

describe('opensquid permissions audit', () => {
  it('filters by --decision', async () => {
    const t0 = fixedNow().getTime();
    const entries: AuditEntry[] = [
      {
        occurred_at_ms: t0 - 60_000,
        category: 'capability_gate',
        decision: 'denied',
        pack: 'ci',
        capability: 'shell_exec',
        target: 'rm -rf /',
        source: 'denylist',
      },
      {
        occurred_at_ms: t0 - 30_000,
        category: 'capability_gate',
        decision: 'allowed',
        pack: 'ci',
        capability: 'shell_exec',
        target: 'pnpm typecheck',
        source: 'declared',
      },
    ];
    for (const e of entries) await appendAuditEntry(auditPath, e);
    await build().parseAsync(argv('audit', '--decision', 'denied'));
    const parsed = JSON.parse(outText()) as { entries: AuditEntry[] };
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.target).toBe('rm -rf /');
  });

  it('filters by --since (drops entries older than the window)', async () => {
    const t0 = fixedNow().getTime();
    await appendAuditEntry(auditPath, {
      occurred_at_ms: t0 - 25 * 60 * 60 * 1000, // 25h ago
      category: 'capability_gate',
      decision: 'allowed',
      pack: 'old',
      capability: 'shell_exec',
      target: 'old',
      source: 'declared',
    });
    await appendAuditEntry(auditPath, {
      occurred_at_ms: t0 - 60 * 60 * 1000, // 1h ago
      category: 'capability_gate',
      decision: 'allowed',
      pack: 'new',
      capability: 'shell_exec',
      target: 'new',
      source: 'declared',
    });
    await build().parseAsync(argv('audit', '--since', '24h'));
    const parsed = JSON.parse(outText()) as { entries: AuditEntry[] };
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.pack).toBe('new');
  });

  it('exits 1 on invalid --decision', async () => {
    const prev = process.exitCode;
    await build().parseAsync(argv('audit', '--decision', 'maybe'));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('must be one of allowed|denied|prompted');
    process.exitCode = prev;
  });

  it('exits 1 on malformed --since', async () => {
    const prev = process.exitCode;
    await build().parseAsync(argv('audit', '--since', 'soon'));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('--since "soon"');
    process.exitCode = prev;
  });
});

// ---------------------------------------------------------------------------
// grant — happy path + denylist guard + escape flag
// ---------------------------------------------------------------------------

describe('opensquid permissions grant', () => {
  it('appends an override (atomic write)', async () => {
    await build().parseAsync(argv('grant', 'ci', 'shell_exec', '--target', 'pnpm test'));
    const persisted = await readOverridesFile(overridesPath);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.pack).toBe('ci');
    expect(persisted[0]?.capability).toBe('shell_exec');
    expect(persisted[0]?.target).toBe('pnpm test');
    expect(persisted[0]?.granted_at).toBe('2026-05-20T12:00:00.000Z');
  });

  it('exits 1 on built-in denylist pattern (rm -rf /) without escape flag', async () => {
    const prev = process.exitCode;
    await build().parseAsync(argv('grant', 'ci', 'shell_exec', '--target', 'rm -rf /'));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('built-in shell denylist');
    expect(errText()).toContain('OPENSQUID_TRUST_BUILTIN_DENY=0');
    // Override file must NOT exist or be empty after a denied grant.
    expect(await readOverridesFile(overridesPath)).toHaveLength(0);
    process.exitCode = prev;
  });

  it('exits 1 on built-in path denylist (~/.ssh/**) without escape flag', async () => {
    const prev = process.exitCode;
    await build().parseAsync(argv('grant', 'ci', 'file_write', '--target', '~/.ssh/id_rsa'));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('built-in path denylist');
    expect(await readOverridesFile(overridesPath)).toHaveLength(0);
    process.exitCode = prev;
  });

  it('accepts a built-in denylist pattern when OPENSQUID_TRUST_BUILTIN_DENY=0', async () => {
    process.env.OPENSQUID_TRUST_BUILTIN_DENY = '0';
    await build().parseAsync(argv('grant', 'ci', 'shell_exec', '--target', 'rm -rf /'));
    const persisted = await readOverridesFile(overridesPath);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.target).toBe('rm -rf /');
  });

  it('rejects unknown capability', async () => {
    const prev = process.exitCode;
    await build().parseAsync(argv('grant', 'ci', 'nuke', '--target', 'x'));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('unknown capability');
    process.exitCode = prev;
  });

  it('rejects duplicate (pack, capability, target)', async () => {
    await build().parseAsync(argv('grant', 'ci', 'shell_exec', '--target', 'pnpm test'));
    outChunks = [];
    errChunks = [];
    const prev = process.exitCode;
    await build().parseAsync(argv('grant', 'ci', 'shell_exec', '--target', 'pnpm test'));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('already exists');
    expect(await readOverridesFile(overridesPath)).toHaveLength(1);
    process.exitCode = prev;
  });
});

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

describe('opensquid permissions revoke', () => {
  it('removes a specific (pack, capability, target)', async () => {
    await build().parseAsync(argv('grant', 'ci', 'shell_exec', '--target', 'pnpm test'));
    outChunks = [];
    errChunks = [];
    await build().parseAsync(argv('revoke', 'ci', 'shell_exec', '--target', 'pnpm test'));
    expect(await readOverridesFile(overridesPath)).toHaveLength(0);
  });

  it('removes all overrides for (pack, capability) when --target omitted', async () => {
    await build().parseAsync(argv('grant', 'ci', 'shell_exec', '--target', 'pnpm test'));
    await build().parseAsync(argv('grant', 'ci', 'shell_exec', '--target', 'pnpm build'));
    outChunks = [];
    errChunks = [];
    await build().parseAsync(argv('revoke', 'ci', 'shell_exec'));
    expect(await readOverridesFile(overridesPath)).toHaveLength(0);
  });

  it('exits 1 on no-match revoke', async () => {
    const prev = process.exitCode;
    await build().parseAsync(argv('revoke', 'nope', 'shell_exec'));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('no override matches');
    process.exitCode = prev;
  });
});

// ---------------------------------------------------------------------------
// Override round-trip — gate.check honors the persisted override file.
//
// This is the load-bearing integration test: after `grant`, the runtime
// gate constructed with `toRuntimeOverrides(records)` returns `allowed`
// with `source: 'user_override'`. After `revoke`, the same call returns
// `denied`.
// ---------------------------------------------------------------------------

describe('opensquid permissions — override round-trip with CapabilityGate', () => {
  it('grant + verify allow → revoke + verify deny', async () => {
    // No declared permissions for the pack (deny-all by default).
    const packs = new Map<string, PackPermissions>([['ci', { name: 'ci' }]]);

    // BEFORE grant: undeclared shell_exec → denied (non-interactive).
    {
      const overrides = toRuntimeOverrides(await readOverridesFile(overridesPath));
      const gate = new CapabilityGate({ packs, overrides, trustBuiltinDeny: true });
      const v: CapabilityVerdict = await gate.check({
        pack: 'ci',
        capability: 'shell_exec',
        target: 'pnpm test',
      });
      expect(v.allowed).toBe(false);
      expect(v.source).toBe('denied');
    }

    // GRANT via CLI.
    await build().parseAsync(argv('grant', 'ci', 'shell_exec', '--target', 'pnpm test'));

    // AFTER grant: gate sees the override → allowed, source=user_override.
    {
      const overrides = toRuntimeOverrides(await readOverridesFile(overridesPath));
      expect(overrides).toHaveLength(1);
      const gate = new CapabilityGate({ packs, overrides, trustBuiltinDeny: true });
      const v: CapabilityVerdict = await gate.check({
        pack: 'ci',
        capability: 'shell_exec',
        target: 'pnpm test',
      });
      expect(v.allowed).toBe(true);
      expect(v.source).toBe('user_override');
      expect(v.message).toContain('user override');
    }

    // REVOKE via CLI.
    outChunks = [];
    errChunks = [];
    await build().parseAsync(argv('revoke', 'ci', 'shell_exec', '--target', 'pnpm test'));

    // AFTER revoke: gate denies again.
    {
      const overrides = toRuntimeOverrides(await readOverridesFile(overridesPath));
      expect(overrides).toHaveLength(0);
      const gate = new CapabilityGate({ packs, overrides, trustBuiltinDeny: true });
      const v: CapabilityVerdict = await gate.check({
        pack: 'ci',
        capability: 'shell_exec',
        target: 'pnpm test',
      });
      expect(v.allowed).toBe(false);
      expect(v.source).toBe('denied');
    }
  });

  it('user override never escapes built-in denylist (gate-level defense in depth)', async () => {
    // Even if the override file somehow contains a denylist pattern (e.g.
    // via OPENSQUID_TRUST_BUILTIN_DENY=0 grant or a malicious direct edit),
    // the gate with trustBuiltinDeny=true MUST still deny at runtime.
    process.env.OPENSQUID_TRUST_BUILTIN_DENY = '0';
    await build().parseAsync(argv('grant', 'ci', 'shell_exec', '--target', 'rm -rf /'));
    delete process.env.OPENSQUID_TRUST_BUILTIN_DENY;

    const packs = new Map<string, PackPermissions>([['ci', { name: 'ci' }]]);
    const overrides = toRuntimeOverrides(await readOverridesFile(overridesPath));
    expect(overrides).toHaveLength(1);
    const gate = new CapabilityGate({ packs, overrides, trustBuiltinDeny: true });
    const v = await gate.check({ pack: 'ci', capability: 'shell_exec', target: 'rm -rf /' });
    expect(v.allowed).toBe(false);
    expect(v.source).toBe('denylist');
  });
});
