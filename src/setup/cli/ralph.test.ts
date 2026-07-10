import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { buildRalphConfig, makeSpawnLap } from './ralph.js';
import type { RalphConfigFile } from '../wizard/ralph_writer.js';
import type { Issue } from '../../workgraph/types.js';
import type { runOneShotCli } from '../../runtime/spawn_lifecycle.js';

const FILE: RalphConfigFile = {
  authMode: 'subscription',
  maxBudgetUsd: 10,
  claimTtlSec: 1800,
  wallClockMs: 60_000,
  maxRetries: 2,
  backoffBaseMs: 2000,
  harness: { cli: 'claude', ralphMdPath: '/home/.opensquid/RALPH.md', kind: 'claude' },
};
const ITEM: Issue = {
  id: 'a',
  title: 't',
  body: '',
  status: 'open',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('buildRalphConfig', () => {
  it('hydrates scalars + closures; --max-budget-usd override', () => {
    const cfg = buildRalphConfig(FILE, { maxBudgetUsd: 25 });
    expect(cfg.authMode).toBe('subscription');
    expect(cfg.maxBudgetUsd).toBe(25); // override wins
    expect(cfg.supervise.maxRetries).toBe(2);
    expect(cfg.supervise.backoffMs(0)).toBe(2000); // base * 2^0
    expect(cfg.supervise.backoffMs(3)).toBe(16000); // base * 2^3 — exponential
  });

  it('falls back to the config budget when no override', () => {
    expect(buildRalphConfig(FILE, {}).maxBudgetUsd).toBe(10);
  });
});

describe('makeSpawnLap', () => {
  let ralphDir: string;
  let localFile: RalphConfigFile;
  let cfg: ReturnType<typeof buildRalphConfig>;
  const RALPH_BODY = '# RALPH\nDo the one assigned item, then exit with a typed verdict.';

  beforeAll(async () => {
    ralphDir = await mkdtemp(join(tmpdir(), 'opensquid-ralph-'));
    const ralphPath = join(ralphDir, 'RALPH.md');
    await writeFile(ralphPath, RALPH_BODY);
    localFile = { ...FILE, harness: { ...FILE.harness, ralphMdPath: ralphPath } };
    cfg = buildRalphConfig(localFile, {});
  });
  afterAll(async () => {
    await rm(ralphDir, { recursive: true, force: true });
  });

  it('delivers RALPH.md content + item id via stdin prompt; NO --item / no -p<path> (wg-5729c7afafad)', async () => {
    let seen: { cli: string; args: string[]; prompt: string } | undefined;
    const runCli = vi.fn((o: { cli: string; args: string[]; prompt: string }) => {
      seen = o;
      return Promise.resolve('{"result":"done","is_error":false,"total_cost_usd":0.07}');
    }) as unknown as typeof runOneShotCli;
    const out = await makeSpawnLap(cfg, localFile, runCli)(ITEM);
    // LSF.5 — the lap result now also carries the folded token usage (0/0 when the envelope omits `usage`).
    expect(out).toEqual({ kind: 'SHIPPED', costUsd: 0.07, inputTokens: 0, outputTokens: 0 });
    expect(seen?.cli).toBe('claude');
    expect(seen?.args).toContain('-p');
    expect(seen?.args).toContain('--output-format');
    expect(seen?.args).toContain('--dangerously-skip-permissions');
    // the two bugs this fixes:
    expect(seen?.args).not.toContain('--item'); // not a claude flag → crash
    expect(seen?.args).not.toContain(localFile.harness.ralphMdPath); // -p<path> would be path-as-prompt
    // the directive + work item are actually delivered (via stdin):
    expect(seen?.prompt).toContain(RALPH_BODY);
    expect(seen?.prompt).toContain('a'); // the item id
  });

  it('a deadline overrun (__timeout) → typed TIMEOUT, not CRASH', async () => {
    const runCli = vi.fn(() =>
      Promise.reject(Object.assign(new Error('lap timeout'), { __timeout: true })),
    );
    expect(await makeSpawnLap(cfg, localFile, runCli)(ITEM)).toEqual({
      kind: 'TIMEOUT',
      costUsd: 0,
    });
  });

  it('a genuine spawn failure rethrows (→ superviseLap maps to CRASH)', async () => {
    const runCli = vi.fn(() => Promise.reject(new Error('ENOENT: claude not found')));
    await expect(makeSpawnLap(cfg, localFile, runCli)(ITEM)).rejects.toThrow(/ENOENT/);
  });

  it('a missing RALPH.md fails loud BEFORE spawn (wg-5729c7afafad)', async () => {
    const badFile = { ...FILE, harness: { ...FILE.harness, ralphMdPath: '/no/such/RALPH.md' } };
    const runCli = vi.fn(() => Promise.resolve('{}')) as unknown as typeof runOneShotCli;
    await expect(makeSpawnLap(cfg, badFile, runCli)(ITEM)).rejects.toThrow(/RALPH\.md not found/);
    expect(runCli).not.toHaveBeenCalled();
  });
});
