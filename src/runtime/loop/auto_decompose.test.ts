/** T2.5 — autoDecompose: populate issues (stamped) + blocks edges from a SCOPE artifact's elements. */
import { describe, expect, it } from 'vitest';

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { autoDecompose, type AutoDecomposeWg } from './auto_decompose.js';
import { buildCoveredBy, planAudit } from './plan_audit.js';
import { extractScope } from './scope_extract.js';

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
    await autoDecompose(p, wg);

    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.body)).toEqual([
      'sourceElementId:scope-1',
      'sourceElementId:scope-2',
    ]);
    // dep: scope-2 depends on scope-1 → from=issue(scope-1), to=issue(scope-2)
    expect(edges).toEqual([{ from: 'wg-1', to: 'wg-2', type: 'blocks' }]);
  });

  it('a missing artifact → no-op (nothing populated)', async () => {
    const { wg, issues, edges } = fakeWg();
    await autoDecompose('/no/such/artifact.md', wg);
    expect(issues).toEqual([]);
    expect(edges).toEqual([]);
  });

  it('populated graph then planAudit passes (acyclic + complete over the extractScope universe)', async () => {
    const p = await writeArtifact(
      ['1. First [ask: "a"]', '2. Second [needs: 1] [ask: "b"]'].join('\n'),
    );
    const { wg, issues, edges } = fakeWg();
    await autoDecompose(p, wg);

    const ext = await extractScope(p);
    const designElementIds = (ext?.authoredElements ?? []).map((e) => e.id);
    const coveredBy = buildCoveredBy(designElementIds, issues);
    const report = planAudit({
      issueIds: issues.map((i) => i.id),
      edges,
      designElementIds,
      coveredBy,
    });
    expect(report.acyclic).toBe(true);
    expect(report.complete).toBe(true);
  });
});
