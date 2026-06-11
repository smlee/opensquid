/**
 * T-AUTO-HANDOFF — write.ts unit tests: the MEMORY.md marker contract (bytes
 * outside the managed region are NEVER touched) + path resolution pinning.
 */

import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HANDOFF_BEGIN,
  HANDOFF_END,
  encodeProjectPath,
  gatherSiblingFacts,
  inFlightSibling,
  memoryMdPathFor,
  spliceResumeBlock,
  type SiblingFact,
} from './write.js';

describe('spliceResumeBlock', () => {
  it('replaces an existing managed region; outside bytes byte-identical', () => {
    const before = `# Title\n\nuser content A\n\n${HANDOFF_BEGIN}\nOLD\n${HANDOFF_END}\n\nuser content B\n`;
    const after = spliceResumeBlock(before, 'NEW');
    expect(after).toContain(`${HANDOFF_BEGIN}\nNEW\n${HANDOFF_END}`);
    expect(after).not.toContain('OLD');
    expect(after.startsWith('# Title\n\nuser content A\n\n')).toBe(true);
    expect(after.endsWith('\n\nuser content B\n')).toBe(true);
  });

  it('inserts after the first H1 when no markers exist', () => {
    const before = `# My Memory\n\n- existing pointer\n`;
    const after = spliceResumeBlock(before, 'BLOCK');
    expect(after.indexOf('# My Memory')).toBe(0);
    expect(after.indexOf(HANDOFF_BEGIN)).toBeGreaterThan(after.indexOf('# My Memory'));
    expect(after.indexOf(HANDOFF_BEGIN)).toBeLessThan(after.indexOf('- existing pointer'));
    expect(after).toContain('- existing pointer');
  });

  it('prepends when there is no H1', () => {
    const before = 'plain text only\n';
    const after = spliceResumeBlock(before, 'BLOCK');
    expect(after.startsWith(HANDOFF_BEGIN)).toBe(true);
    expect(after).toContain('plain text only');
  });

  it('is idempotent: splicing the same block twice is byte-identical', () => {
    const before = `# T\n\nbody\n`;
    const once = spliceResumeBlock(before, 'B');
    expect(spliceResumeBlock(once, 'B')).toBe(once);
  });
});

describe('memoryMdPathFor (path resolution pinned — the encodeProjectPath convention)', () => {
  it('sanitizes / to - exactly like the auto-memory dir naming', () => {
    expect(encodeProjectPath('/x/y')).toBe('-x-y');
    expect(memoryMdPathFor('/x/y')).toContain('/projects/-x-y/memory/MEMORY.md');
  });
});

// ---------------------------------------------------------------------------
// HRA.1 (wg-c34349377f81) — the umbrella-scoped in-flight guard.
// ---------------------------------------------------------------------------

describe('inFlightSibling — truth table (pure core)', () => {
  const NOW = 1_000_000_000_000;
  const ROOT = '/Users/u/projects/loop';
  const mk = (sid: string, cwd: string | null, ageMs: number | null): SiblingFact => ({
    sid,
    cwd,
    ledgerMtimeMs: ageMs === null ? null : NOW - ageMs,
  });
  const run = (siblings: SiblingFact[]): string | null =>
    inFlightSibling({ siblings, umbrellaRoot: ROOT, dyingSid: 'dying', nowMs: NOW });

  it('same-umbrella fresh sibling → its sid', () => {
    expect(run([mk('other', `${ROOT}/opensquid`, 60_000)])).toBe('other');
  });

  it('same-umbrella STALE sibling (11min) → null', () => {
    expect(run([mk('other', ROOT, 11 * 60_000)])).toBeNull();
  });

  it('OTHER-umbrella fresh session → null (the cross-project pin)', () => {
    expect(run([mk('other', '/Users/u/projects/RaumPilates', 60_000)])).toBeNull();
  });

  it('unattributable facts → null (fail-open): cwd null / ledger null', () => {
    expect(run([mk('a', null, 60_000), mk('b', ROOT, null)])).toBeNull();
  });

  it('the dying sid itself is excluded even when fresh', () => {
    expect(run([mk('dying', ROOT, 0)])).toBeNull();
  });

  it('prefix safety: /u/loop2 does NOT match root /u/loop', () => {
    expect(run([mk('other', `${ROOT}2`, 60_000)])).toBeNull();
  });
});

describe('gatherSiblingFacts — impure shell (tmp OPENSQUID_HOME)', () => {
  let home: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    home = await mkdtemp(join(tmpdir(), 'opensquid-hra-'));
    process.env.OPENSQUID_HOME = home;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(home, { recursive: true, force: true });
  });

  async function seedSession(sid: string, cwd: string | null, ledger: boolean): Promise<void> {
    const stateDir = join(home, 'sessions', sid, 'state');
    await mkdir(stateDir, { recursive: true });
    if (cwd !== null) await writeFile(join(stateDir, 'cwd.json'), cwd, 'utf8');
    if (ledger) await writeFile(join(stateDir, 'tool-ledger.json'), '{}', 'utf8');
  }

  it('gathers cwd + ledger mtime; absent pieces are null', async () => {
    await seedSession('s1', '/real/project', true);
    await seedSession('s2', null, true);
    await seedSession('s3', '/x', false);
    const facts = await gatherSiblingFacts();
    const by = Object.fromEntries(facts.map((f) => [f.sid, f]));
    expect(by.s1?.cwd).toBe('/real/project'); // unresolvable realpath → identity
    expect(by.s1?.ledgerMtimeMs).not.toBeNull();
    expect(by.s2?.cwd).toBeNull();
    expect(by.s3?.ledgerMtimeMs).toBeNull();
  });

  it('SYMLINK PIN: an alias cwd of a real dir canonicalizes — a live sibling behind an alias still suppresses', async () => {
    const realRoot = await mkdtemp(join(tmpdir(), 'opensquid-hra-root-'));
    const alias = join(home, 'alias-to-root');
    await symlink(realRoot, alias);
    await seedSession('sib', alias, true);

    const facts = await gatherSiblingFacts();
    const sib = facts.find((f) => f.sid === 'sib');
    // The recorded ALIAS resolved to the real path...
    const { realpathSync } = await import('node:fs');
    expect(sib?.cwd).toBe(realpathSync(realRoot));
    // ...so the guard (root canonicalized the same way) suppresses.
    expect(
      inFlightSibling({
        siblings: facts,
        umbrellaRoot: realpathSync(realRoot),
        dyingSid: 'dying',
        nowMs: Date.now(),
      }),
    ).toBe('sib');
    await rm(realRoot, { recursive: true, force: true });
  });

  it('stale sibling via backdated ledger mtime → not in flight', async () => {
    await seedSession('old', '/p', true);
    const ledger = join(home, 'sessions', 'old', 'state', 'tool-ledger.json');
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(ledger, past, past);
    const facts = await gatherSiblingFacts();
    expect(
      inFlightSibling({
        siblings: facts,
        umbrellaRoot: '/p',
        dyingSid: 'dying',
        nowMs: Date.now(),
      }),
    ).toBeNull();
  });
});
