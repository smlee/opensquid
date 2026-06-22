/** ORCH.6 — groundingDirective: domain mention, local-not-web wording, purity. */
import { describe, expect, it } from 'vitest';

import { groundingDirective } from './ground.js';
import type { Facets } from '../classify.js';

const f = (over: Partial<Facets>): Facets => ({
  intent: 'inform',
  project: true,
  confidence: 'low',
  ...over,
});

describe('groundingDirective (ORCH.6)', () => {
  it('names the domain when present', () => {
    expect(groundingDirective(f({ domain: 'coding' }))).toContain('(coding)');
  });

  it('omits the domain parenthetical when absent', () => {
    expect(groundingDirective(f({}))).toContain('this project task'); // no "(domain)" inserted
  });

  it('directs local-not-web grounding (recall + read, no web search)', () => {
    const d = groundingDirective(f({ domain: 'data' }));
    expect(d).toMatch(/recall/i);
    expect(d).toMatch(/not .*web search|no web|not assumptions or web/i);
  });

  it('is pure — same facets, same output', () => {
    expect(groundingDirective(f({ domain: 'coding' }))).toBe(
      groundingDirective(f({ domain: 'coding' })),
    );
  });
});
