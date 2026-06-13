import { describe, it, expect, vi } from 'vitest';
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
  harness: { cli: 'claude', ralphMdPath: '/home/.opensquid/RALPH.md' },
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
  it('hydrates scalars + closures; --once and --max-budget-usd override', () => {
    const cfg = buildRalphConfig(FILE, { once: true, maxBudgetUsd: 25 });
    expect(cfg.authMode).toBe('subscription');
    expect(cfg.maxBudgetUsd).toBe(25); // override wins
    expect(cfg.once).toBe(true);
    expect(cfg.supervise.maxRetries).toBe(2);
    expect(cfg.supervise.backoffMs(0)).toBe(2000); // base * 2^0
    expect(cfg.supervise.backoffMs(3)).toBe(16000); // base * 2^3 — exponential
  });

  it('falls back to the config budget when no override', () => {
    expect(buildRalphConfig(FILE, { once: false }).maxBudgetUsd).toBe(10);
  });
});

describe('makeSpawnLap', () => {
  const cfg = buildRalphConfig(FILE, { once: true });

  it('parses a clean JSON envelope into the typed LapOutcome + cost', async () => {
    let seen: { cli: string; args: string[] } | undefined;
    const runCli = vi.fn((o: { cli: string; args: string[] }) => {
      seen = o;
      return Promise.resolve('{"result":"done","is_error":false,"total_cost_usd":0.07}');
    }) as unknown as typeof runOneShotCli;
    const out = await makeSpawnLap(cfg, FILE, runCli)(ITEM);
    expect(out).toEqual({ kind: 'SHIPPED', costUsd: 0.07 });
    // spawns the configured harness with --item + skip-permissions
    expect(seen?.cli).toBe('claude');
    expect(seen?.args).toContain('--dangerously-skip-permissions');
    expect(seen?.args).toContain('a');
  });

  it('a deadline overrun (__timeout) → typed TIMEOUT, not CRASH', async () => {
    const runCli = vi.fn(() =>
      Promise.reject(Object.assign(new Error('lap timeout'), { __timeout: true })),
    );
    expect(await makeSpawnLap(cfg, FILE, runCli)(ITEM)).toEqual({ kind: 'TIMEOUT', costUsd: 0 });
  });

  it('a genuine spawn failure rethrows (→ superviseLap maps to CRASH)', async () => {
    const runCli = vi.fn(() => Promise.reject(new Error('ENOENT: claude not found')));
    await expect(makeSpawnLap(cfg, FILE, runCli)(ITEM)).rejects.toThrow(/ENOENT/);
  });
});
