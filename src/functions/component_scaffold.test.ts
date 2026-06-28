/**
 * component_scaffold (FD5) — the output component generator. Proves each scaffold (a) carries its APG/WCAG
 * contract + a primary source, and (b) is CORRECT-BY-CONSTRUCTION: its code passes the frontend_audit gate
 * (zero CRITICAL findings) — the generator and the pre-delivery gate agree.
 */
import { describe, expect, it } from 'vitest';

import { auditContent } from './frontend_audit.js';
import { scaffoldFor } from './component_scaffold.js';
import type { EvalCtx } from './registry.js';

const CTX = {
  event: { kind: 'tool_call' },
  bindings: new Map<string, unknown>(),
  sessionId: 's',
  packId: 'p',
} as unknown as EvalCtx;

const KINDS = ['button', 'dialog', 'disclosure', 'textfield'] as const;

describe('component_scaffold', () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      it('carries a non-empty a11y contract + a w3.org APG source', () => {
        const s = scaffoldFor(kind);
        expect(s.contract.length).toBeGreaterThan(0);
        expect(s.source.url).toContain('w3.org');
        expect(s.code).toContain('export function');
      });

      it('is correct-by-construction: its code has ZERO critical frontend_audit findings', () => {
        const s = scaffoldFor(kind);
        const critical = auditContent(`${kind}.tsx`, s.code).filter(
          (f) => f.severity === 'critical',
        );
        expect(critical).toHaveLength(0);
      });
    });
  }

  it('the dialog scaffold implements the APG modal contract (aria-modal + Esc + focus restore)', () => {
    const code = scaffoldFor('dialog').code;
    expect(code).toContain('aria-modal');
    expect(code).toContain('aria-labelledby');
    expect(code).toMatch(/Escape/);
    expect(code).toMatch(/restore focus/i);
  });
});

describe('component_scaffold primitive (live registry)', () => {
  it('is registered + returns the requested scaffold', async () => {
    const { buildRegistry } = await import('../runtime/bootstrap.js');
    const r = await buildRegistry();
    const res = await r.call('component_scaffold', { kind: 'dialog' }, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.value as { kind: string }).kind).toBe('dialog');
  });

  it('rejects an unknown kind at the Zod boundary', async () => {
    const { buildRegistry } = await import('../runtime/bootstrap.js');
    const r = await buildRegistry();
    const res = await r.call('component_scaffold', { kind: 'carousel' }, CTX);
    expect(res.ok).toBe(false);
  });
});
