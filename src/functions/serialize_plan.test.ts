/**
 * Tests for `serializePlan` (GFR.1b) — the PLAN audit artifact renderer. Pure over injected readers (no store,
 * no fs): asserts the stable render (sorted scope/issues/deps), the FAIL-LOUD null paths, and stability
 * (identical graph → identical text, so cached_audit's prompt-hash absorbs re-fires).
 */
import { describe, expect, it } from 'vitest';

import { serializePlan, type PlanSerializeDeps } from './serialize_plan.js';

const deps = (over: Partial<PlanSerializeDeps> = {}): PlanSerializeDeps => ({
  scopePath: () => Promise.resolve('scope.md'),
  extract: () =>
    Promise.resolve({
      authoredElements: [{ id: 'E2' }, { id: 'E1' }],
      scopeElements: [
        { designId: 'E1', askSpan: 'a', text: 'first element' },
        { designId: 'E2', askSpan: 'b', text: 'second element' },
      ],
      deps: [{ element: 'E2', dependsOn: 'E1', reason: 'E2 consumes the X that E1 produces' }],
    }),
  wg: () =>
    Promise.resolve({
      // I1/I2 are stamped IN-SCOPE (sourceElementId ∈ {E1,E2}); I9 is a foreign/backlog node (off-universe
      // stamp) that the PROPER issue-scoping must EXCLUDE — it must not leak into the rendered audit artifact.
      listIssues: () =>
        Promise.resolve([
          { id: 'I2', title: 'two', body: 'work. sourceElementId:E2' },
          { id: 'I1', title: 'one', body: 'work. sourceElementId:E1' },
          { id: 'I9', title: 'foreign backlog', body: 'sourceElementId:OTHER' },
        ]),
    }),
  ...over,
});

describe('serializePlan', () => {
  it('renders scope TEXT + the in-scope decomposition + reasoned deps, stably sorted', async () => {
    const text = await serializePlan('s', deps());
    expect(text).not.toBeNull();
    expect(text).toContain('SCOPE ELEMENTS');
    expect(text).toContain('- E1: first element'); // substance, not a bare id
    expect(text).toContain('- E2: second element');
    expect(text).toContain('- I1: one');
    expect(text).toContain('- I2: two');
    // the dependency carries its DERIVED reason (no-guess deps)
    expect(text).toContain('E2 depends on E1 — E2 consumes the X that E1 produces');
    // stable sort: E1 before E2, I1 before I2
    expect(text!.indexOf('- E1')).toBeLessThan(text!.indexOf('- E2'));
    expect(text!.indexOf('- I1: one')).toBeLessThan(text!.indexOf('- I2: two'));
  });

  it('flags a dependency with NO derived reason as an explicit guess (NEVER-GUESS)', async () => {
    const text = await serializePlan(
      's',
      deps({
        extract: () =>
          Promise.resolve({
            authoredElements: [{ id: 'E1' }, { id: 'E2' }],
            scopeElements: [
              { designId: 'E1', askSpan: 'a', text: 'first' },
              { designId: 'E2', askSpan: 'b', text: 'second' },
            ],
            deps: [{ element: 'E2', dependsOn: 'E1', reason: '' }], // un-derived
          }),
      }),
    );
    expect(text).toContain('NO REASON CITED');
  });

  it('flags a scope element with no ask-anchor as untraceable', async () => {
    const text = await serializePlan(
      's',
      deps({
        extract: () =>
          Promise.resolve({
            authoredElements: [{ id: 'E1' }],
            scopeElements: [{ designId: 'E1', askSpan: '', text: 'orphan element' }],
            deps: [],
          }),
      }),
    );
    expect(text).toContain('NO ask-anchor');
  });

  it('scopes the decomposition by issue stamp: in-scope issues render, an off-universe issue is EXCLUDED', async () => {
    const text = await serializePlan('s', deps());
    expect(text).not.toBeNull();
    expect(text).toContain('- I1: one'); // in-scope (sourceElementId:E1) renders
    expect(text).toContain('- I2: two'); // in-scope (sourceElementId:E2) renders
    expect(text).not.toContain('foreign backlog'); // I9 (sourceElementId:OTHER) is filtered out of the render
    expect(text).not.toContain('I9');
  });

  it('returns null (fail-loud → gate blocks) when no captured scope', async () => {
    await expect(
      serializePlan('s', deps({ scopePath: () => Promise.resolve(null) })),
    ).resolves.toBeNull();
    await expect(
      serializePlan('s', deps({ extract: () => Promise.resolve(null) })),
    ).resolves.toBeNull();
  });

  it('is stable: an identical graph renders identically (cache-hash safe)', async () => {
    expect(await serializePlan('s', deps())).toBe(await serializePlan('s', deps()));
  });
});
