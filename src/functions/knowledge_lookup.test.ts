/**
 * FD1 — knowledge_lookup: the design-knowledge retrieval engine. Reader validates + fails loud→null; the
 * query filter is pure; the registered primitive returns matching rules (or null on a missing dataset).
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readKnowledgeDataset, filterRules } from './knowledge_lookup.js';
import type { EvalCtx } from './registry.js';
import type { KnowledgeRule } from '../packs/schemas/knowledge.js';

// Minimal ctx — knowledge_lookup's execute ignores it (reads args only); the registry signature requires one.
const CTX = {
  event: { kind: 'tool_call' },
  bindings: new Map<string, unknown>(),
  sessionId: 's',
  packId: 'p',
} as unknown as EvalCtx;

const RULE = (over: Partial<KnowledgeRule> = {}): KnowledgeRule => ({
  id: 'r1',
  title: 'Contrast',
  category: 'contrast',
  severity: 'critical',
  rule: 'text contrast >= 4.5:1',
  source: { name: 'WCAG 2.2', url: 'https://www.w3.org/TR/WCAG22/', ref: 'SC 1.4.3' },
  ...over,
});

const DATASET = {
  schema_version: 1,
  lens: 'accessibility',
  rules: [
    RULE(),
    RULE({
      id: 'r2',
      title: 'Target size',
      category: 'target',
      severity: 'high',
      tags: ['mobile'],
    }),
    RULE({ id: 'r3', title: 'Label', category: 'forms', severity: 'medium' }),
  ],
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'osq-kb-'));
  await mkdir(join(root, 'packs', 'builtin', 'demo', 'knowledge'), { recursive: true });
  await writeFile(
    join(root, 'packs', 'builtin', 'demo', 'knowledge', 'accessibility.json'),
    JSON.stringify(DATASET),
    'utf8',
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('readKnowledgeDataset', () => {
  it('reads + validates a well-formed dataset', async () => {
    const ds = await readKnowledgeDataset('demo', 'accessibility', root);
    expect(ds?.lens).toBe('accessibility');
    expect(ds?.rules).toHaveLength(3);
  });

  it('missing dataset → null (fail-loud, no throw)', async () => {
    expect(await readKnowledgeDataset('demo', 'nope', root)).toBeNull();
  });

  it('malformed JSON → null', async () => {
    await writeFile(
      join(root, 'packs', 'builtin', 'demo', 'knowledge', 'bad.json'),
      '{ not json',
      'utf8',
    );
    expect(await readKnowledgeDataset('demo', 'bad', root)).toBeNull();
  });

  it('schema-invalid (missing source) → null (the no-schema fix)', async () => {
    await writeFile(
      join(root, 'packs', 'builtin', 'demo', 'knowledge', 'inv.json'),
      JSON.stringify({
        schema_version: 1,
        lens: 'x',
        rules: [{ id: 'a', title: 't', severity: 'low', rule: 'r' }],
      }),
      'utf8',
    );
    expect(await readKnowledgeDataset('demo', 'inv', root)).toBeNull();
  });

  it('path-traversal in pack/dataset → null (never escapes knowledge dir)', async () => {
    expect(await readKnowledgeDataset('../etc', 'accessibility', root)).toBeNull();
    expect(await readKnowledgeDataset('demo', '../../secret', root)).toBeNull();
  });
});

describe('filterRules (pure)', () => {
  const rules = DATASET.rules;
  it('no query → all rules', () => expect(filterRules(rules)).toHaveLength(3));
  it('scalar field equality (severity)', () =>
    expect(filterRules(rules, { severity: 'critical' }).map((r) => r.id)).toEqual(['r1']));
  it('array query = membership (severity in [critical,high])', () =>
    expect(filterRules(rules, { severity: ['critical', 'high'] }).map((r) => r.id)).toEqual([
      'r1',
      'r2',
    ]));
  it('array field (tags) membership', () =>
    expect(filterRules(rules, { tags: 'mobile' }).map((r) => r.id)).toEqual(['r2']));
  it('AND across fields', () =>
    expect(filterRules(rules, { category: 'forms', severity: 'medium' }).map((r) => r.id)).toEqual([
      'r3',
    ]));
});

/** Live registry without wedge/RAG I/O — avoids shared wg_lessons.db SQLITE_BUSY under parallel vitest. */
async function liveRegistry() {
  const { buildRegistry } = await import('../runtime/bootstrap.js');
  return buildRegistry({
    lessonStore: null,
    backend: {
      init: () => Promise.resolve(),
      embed: () => Promise.resolve(null),
      recall: () => Promise.resolve([]),
      storeLesson: () => Promise.resolve(),
      deleteLesson: () => Promise.resolve({ deleted: false, forced: false }),
    },
  });
}

describe('knowledge_lookup primitive (live registry)', () => {
  it('is registered + dispatches through Zod validation (returns ok)', async () => {
    const r = await liveRegistry();
    // A missing dataset is fail-loud→null (ok(null)); FD2 adds the real dataset + asserts its shape.
    const res = await r.call(
      'knowledge_lookup',
      { pack: 'fullstack-flow', dataset: 'accessibility', query: { severity: 'critical' } },
      CTX,
    );
    expect(res.ok).toBe(true);
  });

  it('rejects a path-unsafe dataset name at the Zod boundary', async () => {
    const r = await liveRegistry();
    const res = await r.call('knowledge_lookup', { pack: 'x', dataset: '../escape' }, CTX);
    expect(res.ok).toBe(false); // regex-constrained arg → validation error
  });
});
