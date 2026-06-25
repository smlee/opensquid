/** CFD.1 — Requirement schema + extractor (both encodings; fail-loud doc-rubric). */
import { describe, expect, it } from 'vitest';

import { Requirement, extractRequirements } from './schema.js';

describe('Requirement schema (CFD.1)', () => {
  it('parses each assert kind', () => {
    expect(() =>
      Requirement.parse({
        id: 'R-A',
        intent: 'x',
        assert: { kind: 'absent', symbol: 'skill_router' },
      }),
    ).not.toThrow();
    expect(() =>
      Requirement.parse({
        id: 'R-B',
        intent: 'x',
        assert: { kind: 'binding', ctx_key: 'verdict.guess', in: 'buildGuardCtx' },
        proof: 't.test.ts',
      }),
    ).not.toThrow();
  });

  it('non-absent without a proof fails-loud (doc-rubric superRefine)', () => {
    expect(() =>
      Requirement.parse({
        id: 'R-R',
        intent: 'x',
        assert: { kind: 'reachable', symbol: 's', from: ['pre-tool-use'] },
      }),
    ).toThrow();
  });

  it('bad id and extra keys fail-loud (.strict)', () => {
    expect(() =>
      Requirement.parse({ id: 'bad', intent: 'x', assert: { kind: 'absent', symbol: 's' } }),
    ).toThrow();
    expect(() =>
      Requirement.parse({
        id: 'R-X',
        intent: 'x',
        assert: { kind: 'absent', symbol: 's' },
        bogus: 1,
      }),
    ).toThrow();
  });

  it('extracts a fenced ```yaml requirements block from a .md', () => {
    const md = [
      'pre',
      '```yaml requirements',
      'requirements:',
      '  - id: R-A',
      '    intent: x',
      '    assert: { kind: absent, symbol: skill_router }',
      '```',
      'post',
    ].join('\n');
    expect(extractRequirements('docs/ARCHITECTURE.md', md).map((r) => r.id)).toEqual(['R-A']);
  });

  it('extracts foundation.requirements from a pack.yaml', () => {
    const y = [
      'name: p',
      'foundation:',
      '  requirements:',
      '    - id: R-A',
      '      intent: x',
      '      assert: { kind: absent, symbol: skill_router }',
    ].join('\n');
    expect(extractRequirements('packs/builtin/p/pack.yaml', y).map((r) => r.id)).toEqual(['R-A']);
  });
});
