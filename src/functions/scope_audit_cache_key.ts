/**
 * scope_audit_cache_key (F5, post-ship logic fixes §3.7 element 5) — the skill-DSL accessor for the BRANCHED
 * scope-audit-cache key. The content-audit SCOPE rule binds this from the pending write's `file_path` and passes
 * it as `cached_audit`'s `cache_key`, so a `docs/design/*.md` verdict is keyed PER-DOC while the pre-research
 * artifact keeps the session-wide key. Reuses the SAME {@link scopeAuditCacheKey} the design-doc REWRITE reader
 * uses, so writer and reader keys always agree.
 *
 * Fail-soft: a missing/non-string `file_path` → the session-wide key (the pre-research default) — never throws.
 *
 * Imports from: zod, ../runtime/scope_audit_cache_key.js, ../runtime/result.js.
 * Imported by: src/runtime/bootstrap.ts (registry wiring).
 */
import { z } from 'zod';

import { scopeAuditCacheKey, SCOPE_AUDIT_SESSION_KEY } from '../runtime/scope_audit_cache_key.js';
import { ok } from '../runtime/result.js';

import type { FunctionDef } from './registry.js';

const Args = z.object({ file_path: z.string().optional() }).strict();

export const ScopeAuditCacheKey: FunctionDef<z.input<typeof Args>, string> = {
  name: 'scope_audit_cache_key',
  argSchema: Args,
  durable: false,
  memoizable: false,
  costEstimateMs: 1,
  execute: (args) =>
    Promise.resolve(
      ok(
        typeof args.file_path === 'string'
          ? scopeAuditCacheKey(args.file_path)
          : SCOPE_AUDIT_SESSION_KEY,
      ),
    ),
};
