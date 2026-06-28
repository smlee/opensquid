/**
 * frontend_audit (FD5) — the pre-delivery enforcement engine. The pure detectors flag CRITICAL/HIGH frontend
 * violations; the registered primitive dispatches through Zod and enriches citations. FD5 acceptance: a seeded
 * CRITICAL violation is reported (→ the gate blocks); clean code passes.
 */
import { describe, expect, it } from 'vitest';

import { auditContent, auditFiles } from './frontend_audit.js';
import type { EvalCtx } from './registry.js';

const CTX = {
  event: { kind: 'tool_call' },
  bindings: new Map<string, unknown>(),
  sessionId: 's',
  packId: 'p',
} as unknown as EvalCtx;

describe('auditContent — detectors', () => {
  it('flags an <img> with no alt as CRITICAL (wcag-1.1.1-alt-text)', () => {
    const f = auditContent('Card.tsx', '<img src="chart.png" />');
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe('critical');
    expect(f[0]?.ruleId).toBe('wcag-1.1.1-alt-text');
    expect(f[0]?.line).toBe(1);
  });

  it('does NOT flag an <img> that has alt (even alt="")', () => {
    expect(auditContent('a.tsx', '<img src="x" alt="" />')).toHaveLength(0);
    expect(auditContent('a.tsx', '<img src="x" alt="Revenue up 12%">')).toHaveLength(0);
  });

  it('flags onClick on a <div> with no role as CRITICAL (wcag-2.1.1-keyboard)', () => {
    const f = auditContent('Menu.tsx', '<div onClick={open}>Open</div>');
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe('critical');
    expect(f[0]?.ruleId).toBe('wcag-2.1.1-keyboard');
  });

  it('does NOT flag onClick on a <div> that carries a role', () => {
    expect(
      auditContent('a.tsx', '<div role="button" tabindex="0" onClick={x}>Go</div>'),
    ).toHaveLength(0);
  });

  it('does NOT flag onClick on a native <button>', () => {
    expect(auditContent('a.tsx', '<button onClick={x}>Save</button>')).toHaveLength(0);
  });

  it('flags outline:none with no :focus-visible as HIGH (wcag-2.4.7-focus-visible)', () => {
    const f = auditContent('app.css', '*:focus { outline: none; }');
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe('high');
    expect(f[0]?.ruleId).toBe('wcag-2.4.7-focus-visible');
  });

  it('does NOT flag outline:none when the file provides a :focus-visible replacement', () => {
    const css = 'button { outline: none; }\nbutton:focus-visible { outline: 2px solid blue; }';
    expect(auditContent('app.css', css)).toHaveLength(0);
  });

  it('skips non-frontend files entirely', () => {
    expect(auditContent('server.ts', '<img src="x">')).toHaveLength(0);
    expect(auditContent('README.md', '<div onClick={x}>')).toHaveLength(0);
  });

  it('reports the correct line number for a multi-line file', () => {
    const f = auditContent('a.tsx', 'const a = 1;\n\n<img src="x">');
    expect(f[0]?.line).toBe(3);
  });
});

describe('auditFiles — aggregate', () => {
  it('clean frontend code → clean:true, zero findings', () => {
    const r = auditFiles([
      { path: 'a.tsx', content: '<img src="x" alt="ok" />' },
      { path: 'b.tsx', content: '<button onClick={x}>Save</button>' },
    ]);
    expect(r.clean).toBe(true);
    expect(r.critical).toBe(0);
    expect(r.filesScanned).toBe(2);
  });

  it('a single seeded CRITICAL violation → clean:false (the gate blocks)', () => {
    const r = auditFiles([{ path: 'Card.tsx', content: '<img src="logo.png">' }]);
    expect(r.clean).toBe(false);
    expect(r.critical).toBe(1);
  });

  it('counts critical + high independently across files', () => {
    const r = auditFiles([
      { path: 'a.tsx', content: '<img src="x">' }, // critical
      { path: 'b.css', content: 'a:focus{outline:0}' }, // high
    ]);
    expect(r.critical).toBe(1);
    expect(r.high).toBe(1);
    expect(r.clean).toBe(false); // any critical
  });
});

describe('frontend_audit primitive (live registry)', () => {
  it('is registered, dispatches through Zod, and enriches a finding with its primary source url', async () => {
    const { buildRegistry } = await import('../runtime/bootstrap.js');
    const r = await buildRegistry();
    const res = await r.call(
      'frontend_audit',
      { files: [{ path: 'Card.tsx', content: '<img src="x">' }] },
      CTX,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const out = res.value as {
      critical: number;
      clean: boolean;
      findings: { sourceUrl?: string }[];
    };
    expect(out.critical).toBe(1);
    expect(out.clean).toBe(false);
    expect(out.findings[0]?.sourceUrl).toContain('w3.org'); // enriched from knowledge/accessibility.json
  });

  it('rejects a malformed args shape at the Zod boundary', async () => {
    const { buildRegistry } = await import('../runtime/bootstrap.js');
    const r = await buildRegistry();
    const res = await r.call('frontend_audit', { files: [{ path: 'a.tsx' }] }, CTX); // missing content
    expect(res.ok).toBe(false);
  });
});
