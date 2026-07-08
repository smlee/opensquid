/** T2.5 — autoDecompose: populate issues (stamped) + blocks edges from a SCOPE artifact's elements. */
import { describe, expect, it } from 'vitest';

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  autoDecompose,
  deriveGenerationId,
  type AutoDecomposeWg,
  type DecomposeOwner,
} from './auto_decompose.js';
import { buildCoveredBy, planAudit } from './plan_audit.js';
import { extractScope } from './scope_extract.js';

const OWNER: DecomposeOwner = { parentId: 'wg-parent', generationId: 'gen-test' };

/** An in-memory work-graph capturing created issues + added edges. Stable ids (`wg-<n>`). */
function fakeWg() {
  const issues: { id: string; title: string; body: string }[] = [];
  const edges: { from: string; to: string; type: string }[] = [];
  let n = 0;
  const wg: AutoDecomposeWg = {
    createIssue: ({ title, body }) => {
      const id = `wg-${++n}`;
      issues.push({ id, title, body });
      return Promise.resolve({ id });
    },
    addEdge: (from, to, type) => {
      edges.push({ from, to, type });
      return Promise.resolve();
    },
  };
  return { wg, issues, edges };
}

async function writeArtifact(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'autodecompose-'));
  const sub = join(dir, 'docs', 'research');
  const p = join(sub, 'T-x-pre-research-2026.md');
  await mkdir(sub, { recursive: true });
  await writeFile(p, body, 'utf8');
  return p;
}

describe('autoDecompose', () => {
  it('creates one stamped issue per authored element + a blocks edge per declared dependency', async () => {
    // element 2 depends on element 1 → a `blocks` edge 1→2.
    const p = await writeArtifact(
      ['1. First [ask: "a"]', '2. Second [needs: 1] [ask: "b"]'].join('\n'),
    );
    const { wg, issues, edges } = fakeWg();
    await autoDecompose(p, wg, OWNER);

    expect(issues).toHaveLength(2);
    // WGL.2 — each body stamps sourceElementId: AND generationId: (newline-separated).
    expect(issues.map((i) => i.body)).toEqual([
      'sourceElementId:scope-1\ngenerationId:gen-test',
      'sourceElementId:scope-2\ngenerationId:gen-test',
    ]);
    // WGL.2 — a parent-child ownership edge from OWNER.parentId to EACH child, PLUS the blocks edge (regression).
    expect(edges).toEqual([
      { from: 'wg-parent', to: 'wg-1', type: 'parent-child' },
      { from: 'wg-parent', to: 'wg-2', type: 'parent-child' },
      // dep: scope-2 depends on scope-1 → from=issue(scope-1), to=issue(scope-2)
      { from: 'wg-1', to: 'wg-2', type: 'blocks' },
    ]);
  });

  it('a missing artifact → no-op (nothing populated)', async () => {
    const { wg, issues, edges } = fakeWg();
    await autoDecompose('/no/such/artifact.md', wg, OWNER);
    expect(issues).toEqual([]);
    expect(edges).toEqual([]);
  });

  it('WGL.2 deriveGenerationId is a PURE content hash — stable, change-sensitive, order-independent', async () => {
    const p1 = await writeArtifact(
      ['1. First [ask: "a"]', '2. Second [needs: 1] [ask: "b"]'].join('\n'),
    );
    // same content re-ordered (element list order is sorted inside deriveGenerationId) → SAME id.
    const p1b = await writeArtifact(
      ['2. Second [needs: 1] [ask: "b"]', '1. First [ask: "a"]'].join('\n'),
    );
    const p2 = await writeArtifact(
      ['1. First [ask: "a"]', '2. Second [needs: 1] [ask: "b"]', '3. Third [ask: "c"]'].join('\n'),
    );
    const e1 = await extractScope(p1);
    const e1b = await extractScope(p1b);
    const e2 = await extractScope(p2);
    if (e1 === null || e1b === null || e2 === null) throw new Error('extract failed');
    expect(deriveGenerationId(e1)).toBe(deriveGenerationId(e1)); // stable
    expect(deriveGenerationId(e1b)).toBe(deriveGenerationId(e1)); // order-independent
    expect(deriveGenerationId(e2)).not.toBe(deriveGenerationId(e1)); // an added element → a DIFFERENT id
    expect(deriveGenerationId(e1)).toMatch(/^gen-[0-9a-f]{12}$/);
  });

  it('populated graph then planAudit passes (acyclic + complete over the extractScope universe)', async () => {
    const p = await writeArtifact(
      ['1. First [ask: "a"]', '2. Second [needs: 1] [ask: "b"]'].join('\n'),
    );
    const { wg, issues, edges } = fakeWg();
    await autoDecompose(p, wg, OWNER);

    const ext = await extractScope(p);
    const designElementIds = (ext?.authoredElements ?? []).map((e) => e.id);
    const coveredBy = buildCoveredBy(designElementIds, issues);
    const report = planAudit({
      issueIds: issues.map((i) => i.id),
      edges: edges.filter((e) => e.type === 'blocks'), // the plan DAG audit is over blocks (parent-child = ownership)
      designElementIds,
      coveredBy,
    });
    expect(report.acyclic).toBe(true);
    expect(report.complete).toBe(true);
  });
});
