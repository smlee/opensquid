import { describe, expect, it } from 'vitest';

import { scopeAuditCacheKey } from './scope_audit_cache_key.js';

const BASE = 'pack-declared-audit-cache';

describe('scopeAuditCacheKey', () => {
  it('keeps the pack-declared base key for non-design artifacts', () => {
    expect(scopeAuditCacheKey('docs/research/example.md', BASE)).toBe(BASE);
    expect(scopeAuditCacheKey('/tmp/anything.txt', BASE)).toBe(BASE);
  });

  it('branches design documents per normalized path', () => {
    const relative = scopeAuditCacheKey('docs/design/example.md', BASE);
    const absolute = scopeAuditCacheKey('/repo/docs/design/example.md', BASE);
    expect(relative).toBe(absolute);
    expect(relative).toBe(`${BASE}-doc-docs_design_example_md`);
  });

  it('never leaks path separators into the state key', () => {
    const key = scopeAuditCacheKey('docs/design/nested/a b.md', BASE);
    expect(key).not.toMatch(/[\\/ ]/u);
    expect(key.startsWith(BASE)).toBe(true);
  });
});
