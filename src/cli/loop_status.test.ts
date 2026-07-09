/**
 * LSF.3 / LMP.5 — the `opensquid loop-status` renderer.
 *
 * Covers the PURE render helpers with an injected `now`: `formatRelativeAge` (just now / Nm ago / Nh ago, NaN
 * tolerant), `renderItem` (stage → phase (idx/total) + ⟳/✓ marker + ALWAYS an age token), and `renderStatusLine`
 * (one width-bounded line, `+N more` overflow, stable idle line). The db-backed modes are covered by
 * loop_state.test.ts / loop_events.test.ts; here we pin the string shapes the harness status line depends on.
 */
import { describe, expect, it } from 'vitest';

import {
  renderItem,
  renderStatusLine,
  renderStatuslineFragment,
  formatRelativeAge,
} from './loop_status.js';
import type { LoopState, LoopStateItem } from '../runtime/loop/loop_state.js';

describe('formatRelativeAge', () => {
  it('renders relative buckets and tolerates a NaN delta', () => {
    expect(formatRelativeAge(0)).toBe('just now');
    expect(formatRelativeAge(30_000)).toBe('just now');
    expect(formatRelativeAge(120_000)).toBe('2m ago');
    expect(formatRelativeAge(3_600_000)).toBe('1h ago');
    expect(formatRelativeAge(NaN)).toBe('just now'); // never throws on the status line
  });
});

describe('renderItem', () => {
  const NOW = 1_000_000;

  it('renders wgId · stage · <age> with no phase', () => {
    expect(
      renderItem(
        {
          wgId: 'wg-a',
          stage: 'scope_write',
          lastActivityMs: NOW - 120_000,
          updatedAt: 0,
          terminal: false,
        },
        NOW,
      ),
    ).toBe('wg-a · scope_write · 2m ago');
  });

  it('appends the phase + counter + ⟳ marker (running) and an age token', () => {
    expect(
      renderItem(
        {
          wgId: 'wg-a',
          stage: 'code',
          phase: 'test',
          phaseIndex: 4,
          phaseTotal: 7,
          lifecycle: 'running',
          lastActivityMs: NOW,
          updatedAt: 0,
          terminal: false,
        },
        NOW,
      ),
    ).toBe('wg-a · code · test (4/7) ⟳ · just now');
  });

  it('uses the ✓ marker for a done phase', () => {
    expect(
      renderItem(
        {
          wgId: 'wg-a',
          stage: 'code',
          phase: 'test',
          phaseIndex: 4,
          phaseTotal: 7,
          lifecycle: 'done',
          lastActivityMs: NOW,
          updatedAt: 0,
          terminal: false,
        },
        NOW,
      ),
    ).toBe('wg-a · code · test (4/7) ✓ · just now');
  });

  it('falls back to updatedAt when lastActivityMs is absent (never throws)', () => {
    expect(
      renderItem(
        { wgId: 'wg-a', stage: 'scope', updatedAt: NOW - 3_600_000, terminal: false },
        NOW,
      ),
    ).toBe('wg-a · scope · 1h ago');
  });
});

describe('renderStatusLine', () => {
  const NOW = 1_000_000;
  const items: LoopState = [
    {
      wgId: 'wg-a',
      stage: 'code',
      phase: 'test',
      phaseIndex: 4,
      phaseTotal: 7,
      lifecycle: 'running',
      lastActivityMs: NOW,
      updatedAt: 0,
      terminal: false,
    },
    { wgId: 'wg-b', stage: 'scope_write', lastActivityMs: NOW, updatedAt: 0, terminal: false },
  ];

  it('returns the stable non-empty idle line for an empty board', () => {
    expect(renderStatusLine([])).toBe('🦑 loop idle — no items in flight');
  });

  it('renders every item within a generous width, squid-prefixed', () => {
    const line = renderStatusLine(items, 200, NOW);
    expect(line.startsWith('🦑 ')).toBe(true);
    expect(line).toContain('wg-a · code · test (4/7) ⟳ · just now');
    expect(line).toContain('wg-b · scope_write · just now');
  });

  it('overflows to `+N more` when the width cannot fit every item', () => {
    const line = renderStatusLine(items, 30, NOW);
    expect(line).toContain('wg-a · code · test (4/7) ⟳');
    expect(line).toMatch(/\+\d+ more$/);
  });

  it('F2 — sorts freshest-first before truncation: the ACTIVELY-moving item survives, a frozen one drops', () => {
    // stale item inserted FIRST (Map insertion order would fold it first); fresh item second. A narrow width fits
    // only one — the freshest (highest lastActivityMs) must be the survivor, not the stale one.
    const board: LoopState = [
      {
        wgId: 'wg-stale',
        stage: 'code',
        lastActivityMs: NOW - 3_600_000,
        updatedAt: 0,
        terminal: false,
      },
      { wgId: 'wg-fresh', stage: 'code', lastActivityMs: NOW, updatedAt: 0, terminal: false },
    ];
    const line = renderStatusLine(board, 30, NOW);
    expect(line).toContain('wg-fresh');
    expect(line).not.toContain('wg-stale');
    expect(line).toMatch(/\+\d+ more$/);
  });

  it('F2 — the sort is PURE: the caller-supplied array is never mutated', () => {
    const board: LoopState = [
      {
        wgId: 'wg-stale',
        stage: 'code',
        lastActivityMs: NOW - 3_600_000,
        updatedAt: 0,
        terminal: false,
      },
      { wgId: 'wg-fresh', stage: 'code', lastActivityMs: NOW, updatedAt: 0, terminal: false },
    ];
    renderStatusLine(board, 200, NOW);
    expect(board.map((i) => i.wgId)).toEqual(['wg-stale', 'wg-fresh']); // original order intact
  });
});

describe('renderStatuslineFragment (SLC.1 — the additive pill)', () => {
  const NOW = 1_000_000;
  const fresh = (over: Partial<LoopStateItem> & { wgId: string }): LoopStateItem => ({
    stage: 'code',
    updatedAt: NOW,
    lastActivityMs: NOW,
    terminal: false,
    ...over,
  });

  it('returns "" on an empty board (additive: no loop → no pill, NOT the idle line)', () => {
    const out = renderStatuslineFragment([], 40, NOW);
    expect(out).toBe('');
    expect(out).not.toContain('idle'); // never leak IDLE_LINE into the user's own line
  });

  it('renders one item 🦑-prefixed within the width cap', () => {
    const out = renderStatuslineFragment([fresh({ wgId: 'wg-x', stage: 'code' })], 40, NOW);
    expect(out.startsWith('🦑 ')).toBe(true);
    expect(out).toContain('wg-x · code');
    expect(out.length).toBeLessThanOrEqual(40);
  });

  it('overflows to a `+N more` suffix when items exceed the width', () => {
    const items: LoopState = [
      fresh({ wgId: 'wg-aaaa', stage: 'code' }),
      fresh({ wgId: 'wg-bbbb', stage: 'plan' }),
      fresh({ wgId: 'wg-cccc', stage: 'test' }),
    ];
    const out = renderStatuslineFragment(items, 40, NOW);
    expect(out.startsWith('🦑 ')).toBe(true);
    expect(out).toMatch(/\+\d+ more/); // reuses the renderStatusLine overflow shape
  });

  it('never throws on a malformed item (undefined lastActivityMs, NaN age)', () => {
    const bad = {
      wgId: 'wg-z',
      stage: 'x',
      updatedAt: Number.NaN,
      terminal: false,
    } as LoopStateItem;
    expect(() => renderStatuslineFragment([bad], 40, NOW)).not.toThrow();
    expect(renderStatuslineFragment([bad], 40, NOW)).toContain('wg-z');
  });
});
