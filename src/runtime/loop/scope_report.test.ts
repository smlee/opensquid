/**
 * RD.3/RD.6 — the higher-scope before/after renderers produce the §4 spine (pure; iso injected).
 */
import { describe, expect, it } from 'vitest';

import { renderScopeBefore, renderScopeAfter } from './scope_report.js';

const ISO = '2026-07-09T13:45:07.000Z';

describe('renderScopeBefore', () => {
  it('renders "Before-<scope> · <subject> · <date>" + a Will: bullet list', () => {
    const { body } = renderScopeBefore('task', 'wg-x', ['ship the thing', 'green the gate'], ISO);
    expect(body).toBe(
      'Before-task · wg-x · 2026-07-09\n\nWill:\n  - ship the thing\n  - green the gate\n',
    );
  });
});

describe('renderScopeAfter', () => {
  it('renders each ✓/✗ item + optional Produced/Next', () => {
    const { body } = renderScopeAfter(
      'session',
      'BOARD_EMPTY',
      [
        { item: 'wg-a', done: true },
        { item: 'wg-b', done: false, note: 'UNRECOVERABLE_WEDGE' },
      ],
      'closed wg-a',
      'resume wg-b',
      ISO,
    );
    expect(body).toBe(
      'After-session · BOARD_EMPTY · 2026-07-09\n\n' +
        '  ✓ wg-a\n  ✗ wg-b — UNRECOVERABLE_WEDGE\n\n' +
        'Produced: closed wg-a\nNext: resume wg-b\n',
    );
  });

  it('omits Produced/Next when undefined', () => {
    const { body } = renderScopeAfter(
      'task',
      'wg-x',
      [{ item: 't', done: true }],
      undefined,
      undefined,
      ISO,
    );
    expect(body).toBe('After-task · wg-x · 2026-07-09\n\n  ✓ t\n');
  });
});
