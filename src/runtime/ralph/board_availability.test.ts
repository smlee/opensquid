import { describe, expect, it } from 'vitest';

import type { Issue, WorkGraphFacade } from '../../workgraph/types.js';
import { inspectBoardAvailability, summarizeBoardWaiting } from './board_availability.js';

const at = '2026-01-01T00:00:00.000Z';
const issue = (id: string, over: Partial<Issue> = {}): Issue => ({
  id,
  title: id,
  body: '',
  status: 'open',
  createdAt: at,
  updatedAt: at,
  ...over,
});

const facade = (
  issues: Issue[],
  edges: {
    from: string;
    to: string;
    type: 'blocks' | 'parent-child' | 'discovered-from' | 'related';
  }[] = [],
): WorkGraphFacade =>
  ({
    listIssues: () => Promise.resolve(issues),
    listEdges: () => Promise.resolve(edges),
  }) as WorkGraphFacade;

describe('inspectBoardAvailability', () => {
  it('reserves empty for zero nonterminal issues', async () => {
    await expect(
      inspectBoardAvailability(
        facade([issue('closed', { status: 'closed' }), issue('archived', { status: 'archived' })]),
        new Set(),
      ),
    ).resolves.toEqual({ kind: 'empty', waiting: [] });
  });

  it('classifies every listReady exclusion from the WorkGraph source of truth', async () => {
    const result = await inspectBoardAvailability(
      facade(
        [
          issue('scope'),
          issue('wedge', { wedgeReason: 'UNRECOVERABLE_WEDGE' }),
          issue('claim', {
            claimToken: 'token',
            claimExpiresAt: '2026-01-01T01:00:00.000Z',
          }),
          issue('blocker'),
          issue('blocked'),
          issue('running', { status: 'in_progress' }),
          issue('unknown'),
        ],
        [{ from: 'blocker', to: 'blocked', type: 'blocks' }],
      ),
      new Set(['scope']),
      '2026-01-01T00:30:00.000Z',
    );

    expect(result).toEqual({
      kind: 'waiting',
      waiting: [
        { id: 'scope', reason: 'admission' },
        { id: 'wedge', reason: 'wedged', detail: 'UNRECOVERABLE_WEDGE' },
        { id: 'claim', reason: 'claimed', detail: '2026-01-01T01:00:00.000Z' },
        { id: 'blocker', reason: 'unavailable' },
        { id: 'blocked', reason: 'blocked', detail: 'blocker' },
        { id: 'running', reason: 'in_progress' },
        { id: 'unknown', reason: 'unavailable' },
      ],
    });
    if (result.kind === 'waiting') {
      expect(summarizeBoardWaiting(result.waiting)).toBe(
        'admission 1, blocked 1, claimed 1, in_progress 1, unavailable 2, wedged 1',
      );
    }
  });

  it('treats an expired claim as unavailable rather than live-claimed', async () => {
    await expect(
      inspectBoardAvailability(
        facade([
          issue('expired', {
            claimToken: 'token',
            claimExpiresAt: '2025-12-31T23:59:59.000Z',
          }),
        ]),
        new Set(),
        at,
      ),
    ).resolves.toEqual({
      kind: 'waiting',
      waiting: [{ id: 'expired', reason: 'unavailable' }],
    });
  });
});
