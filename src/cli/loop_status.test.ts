/**
 * LSF.3 (subprocess-harness-push.md §2.3) — the `opensquid loop-status` renderer.
 *
 * Covers the two PURE render helpers: `renderItem` (stage → phase-within-stage) and `renderStatusLine` (one
 * width-bounded line, `+N more` overflow, a stable non-empty idle line). The db-backed modes are covered by
 * loop_state.test.ts / loop_metrics.test.ts; here we pin the string shapes the harness status line depends on.
 */
import { describe, expect, it } from 'vitest';

import { renderItem, renderStatusLine } from './loop_status.js';
import type { LoopState } from '../runtime/loop/loop_state.js';

describe('renderItem', () => {
  it('renders wgId · stage with no phase', () => {
    expect(renderItem({ wgId: 'wg-a', stage: 'scope_write', updatedAt: 0, terminal: false })).toBe(
      'wg-a · scope_write',
    );
  });

  it('appends the phase + (idx/total) counter when present', () => {
    expect(
      renderItem({
        wgId: 'wg-a',
        stage: 'code',
        phase: 'test',
        phaseIndex: 4,
        phaseTotal: 7,
        updatedAt: 0,
        terminal: false,
      }),
    ).toBe('wg-a · code · test (4/7)');
  });

  it('renders a bare phase label when the counters are absent', () => {
    expect(
      renderItem({ wgId: 'wg-a', stage: 'scope', phase: 'confirm', updatedAt: 0, terminal: false }),
    ).toBe('wg-a · scope · confirm');
  });
});

describe('renderStatusLine', () => {
  const items: LoopState = [
    {
      wgId: 'wg-a',
      stage: 'code',
      phase: 'test',
      phaseIndex: 4,
      phaseTotal: 7,
      updatedAt: 0,
      terminal: false,
    },
    { wgId: 'wg-b', stage: 'scope_write', updatedAt: 0, terminal: false },
  ];

  it('returns the stable non-empty idle line for an empty board', () => {
    expect(renderStatusLine([])).toBe('🦑 loop idle — no items in flight');
  });

  it('renders every item within a generous width, squid-prefixed', () => {
    const line = renderStatusLine(items, 200);
    expect(line.startsWith('🦑 ')).toBe(true);
    expect(line).toContain('wg-a · code · test (4/7)');
    expect(line).toContain('wg-b · scope_write');
  });

  it('overflows to `+N more` when the width cannot fit every item', () => {
    const line = renderStatusLine(items, 30);
    expect(line).toContain('wg-a · code · test (4/7)');
    expect(line).toMatch(/\+\d+ more$/);
    expect(line.length).toBeLessThanOrEqual(30 + '🦑 '.length + 4); // bounded (emoji width slack)
  });
});
