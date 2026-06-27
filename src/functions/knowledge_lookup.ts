/**
 * `knowledge_lookup` primitive + the bare `readKnowledgeDataset` reader (T-frontend-design-pack FD1).
 *
 * The runtime retrieval layer for the bundled design-knowledge datasets. A skill (input lens or output gate)
 * calls `knowledge_lookup` with `{pack, dataset, query?}`; the primitive reads
 * `packs/builtin/<pack>/knowledge/<dataset>.json`, `.strict()`-validates it (KnowledgeDataset), filters by the
 * optional query, and returns the matching rules. Replaces the reference skill's Python BM25 engine with a
 * typed, deterministic, testable lookup — no Python at runtime (S3 §9 Option A; mirrors `read_rubric`).
 *
 * Resolution is MODULE-RELATIVE to the opensquid package (like `read_rubric` / `paths.ts`), NOT cwd — so the
 * sub-repo-vs-umbrella cwd split cannot misresolve it. `pack`/`dataset` are restricted to `[a-z0-9-]+` so a
 * dataset name can never traverse out of the knowledge dir.
 *
 * FAIL-LOUD→null: a missing / malformed / schema-invalid / over-cap dataset yields `null` (never a throw,
 * never a partial). The primitive returns `ok(null)` so a caller fails loud (a lens injects nothing; a gate
 * with a `dataset == null` precondition refuses to run rule-less) rather than enforcing on bad data.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { KnowledgeDataset, type KnowledgeRule } from '../packs/schemas/knowledge.js';
import { ok } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

/** Sanity ceiling (datasets are tens-of-KB typed JSON); over-cap → null (never a partial read). */
const MAX_DATASET = 1_024_000;

/** Path-safety: a pack/dataset id is lowercase-kebab only — cannot contain `/`, `.` or `..`. */
const SAFE_ID = /^[a-z0-9-]+$/;

// dist/functions/knowledge_lookup.js → ../.. = the package root, where the shipped `packs/builtin/` lives.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const KnowledgeLookupArgs = z
  .object({
    pack: z.string().regex(SAFE_ID),
    dataset: z.string().regex(SAFE_ID),
    /** Field→value(s) filter over rules; value may be a scalar or an array (membership). */
    query: z.record(z.unknown()).optional(),
  })
  .strict();

/**
 * Bare reader — validated, fail-loud→null. `root` defaults to the package root; tests override it.
 */
export async function readKnowledgeDataset(
  pack: string,
  dataset: string,
  root: string = PKG_ROOT,
): Promise<KnowledgeDataset | null> {
  if (!SAFE_ID.test(pack) || !SAFE_ID.test(dataset)) return null;
  try {
    const raw = await readFile(
      join(root, 'packs', 'builtin', pack, 'knowledge', `${dataset}.json`),
      'utf8',
    );
    if (raw.length > MAX_DATASET) return null;
    const parsed = KnowledgeDataset.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Does a rule's field value match a query value? Scalar equality (case-insensitive) or array membership. */
function matchField(fieldVal: unknown, queryVal: unknown): boolean {
  const eq = (a: unknown, b: unknown): boolean =>
    typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const fieldArr = Array.isArray(fieldVal);
  const queryArr = Array.isArray(queryVal);
  if (fieldArr && queryArr)
    return (fieldVal as unknown[]).some((f) => (queryVal as unknown[]).some((q) => eq(f, q)));
  if (fieldArr) return (fieldVal as unknown[]).some((f) => eq(f, queryVal));
  if (queryArr) return (queryVal as unknown[]).some((q) => eq(fieldVal, q));
  return eq(fieldVal, queryVal);
}

/** PURE — keep rules where EVERY query field matches (AND across fields). No query → all rules. */
export function filterRules(
  rules: readonly KnowledgeRule[],
  query?: Record<string, unknown>,
): KnowledgeRule[] {
  if (query === undefined || Object.keys(query).length === 0) return [...rules];
  return rules.filter((r) =>
    Object.entries(query).every(([k, v]) => matchField((r as Record<string, unknown>)[k], v)),
  );
}

export interface KnowledgeLookupResult {
  lens: string;
  count: number;
  rules: KnowledgeRule[];
}

export function registerKnowledgeLookup(registry: FunctionRegistry): void {
  registry.register({
    name: 'knowledge_lookup',
    argSchema: KnowledgeLookupArgs,
    durable: false,
    memoizable: false, // re-read each call so a dataset edit is reflected (matches read_rubric); cost is one small JSON parse
    costEstimateMs: 2,
    execute: async ({ pack, dataset, query }) => {
      const ds = await readKnowledgeDataset(pack, dataset);
      if (ds === null) return ok(null); // fail-loud→null: caller refuses to run rule-less
      const rules = filterRules(ds.rules, query);
      return ok({ lens: ds.lens, count: rules.length, rules } satisfies KnowledgeLookupResult);
    },
  });
}
