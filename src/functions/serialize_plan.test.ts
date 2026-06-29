/**
 * Tests for `serializePlan` (GFR.1b) — the PLAN audit artifact renderer. Pure over injected readers (no store,
 * no fs): asserts the stable render (sorted scope/issues/edges), the FAIL-LOUD null paths, and stability
 * (identical graph → identical text, so cached_audit's prompt-hash absorbs re-fires).
 */
import { describe, expect, it } from 'vitest';

import { serializePlan, type PlanSerializeDeps } from './serialize_plan.js';

const deps = (over: Partial<PlanSerializeDeps> = {}): PlanSerializeDeps => ({
  scopePath: async () => 'scope.md',
  extract: async () => ({ authoredElements: [{ id: 'E2' }, { id: 'E1' }] }),
  wg: async () => ({
    listIssues: async () => [
      { id: 'I2', title: 'two' },
      { id: 'I1', title: 'one' },
    ],
    listEdges: async () => [{ from: 'I2', to: 'I1', type: 'blocks' }],
  }),
  ...over,
});

describe('serializePlan', () => {
  it('renders scope + issues + edges, stably sorted', async () => {
    const text = await serializePlan('s', deps());
    expect(text).not.toBeNull();
    expect(text).toContain('SCOPE ELEMENTS');
    expect(text).toContain('- I1: one');
    expect(text).toContain('- I2: two');
    expect(text).toContain('I2 --blocks--> I1');
    // stable sort: E1 before E2, I1 before I2
    expect(text!.indexOf('- E1')).toBeLessThan(text!.indexOf('- E2'));
    expect(text!.indexOf('- I1: one')).toBeLessThan(text!.indexOf('- I2: two'));
  });

  it('returns null (fail-loud → gate blocks) when no captured scope', async () => {
    await expect(serializePlan('s', deps({ scopePath: async () => null }))).resolves.toBeNull();
    await expect(serializePlan('s', deps({ extract: async () => null }))).resolves.toBeNull();
  });

  it('is stable: an identical graph renders identically (cache-hash safe)', async () => {
    expect(await serializePlan('s', deps())).toBe(await serializePlan('s', deps()));
  });
});
