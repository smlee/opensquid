import { z } from 'zod';

import { scopeAuditCacheKey } from '../runtime/scope_audit_cache_key.js';
import { ok } from '../runtime/result.js';

import type { FunctionDef } from './registry.js';

const Args = z
  .object({
    file_path: z.string().optional(),
    base_key: z.string().min(1),
  })
  .strict();

/** Skill-DSL adapter for per-document branching from a pack-declared audit cache key. */
export const ScopeAuditCacheKey: FunctionDef<z.input<typeof Args>, string> = {
  name: 'scope_audit_cache_key',
  argSchema: Args,
  durable: false,
  memoizable: false,
  costEstimateMs: 1,
  execute: (args) => Promise.resolve(ok(scopeAuditCacheKey(args.file_path ?? '', args.base_key))),
};
