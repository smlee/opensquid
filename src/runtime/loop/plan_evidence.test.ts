/** T2.5 — planEvidence: work-graph facets (acyclic ∧ complete) over the INDEPENDENT extractScope universe. */
import { describe, expect, it } from 'vitest';

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planEvidence, type PlanWgReader } from './plan_evidence.js';

async function writeArtifact(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'planevidence-'));
  const sub = join(dir, 'docs', 'research');
  const p = join(sub, 'T-x-pre-research-2026.md');
  await mkdir(sub, { recursive: true });
  await writeFile(p, body, 'utf8');
  return p;
}

const reader = (
  issues: { id: string; body: string }[],
  edges: { from: string; to: string; type: string }[],
): PlanWgReader => ({
  listIssues: () => Promise.resolve(issues),
  listEdges: () => Promise.resolve(edges),
});

describe('planEvidence', () => {
  it('fail-CLOSED when the captured artifact is absent → {false,false}', async () => {
    const ev = await planEvidence('sess-x', '/no/such/artifact.md', reader([], []));
    expect(ev).toEqual({ acyclic: false, complete: false });
  });

  it('every element covered + acyclic edges → {true,true}', async () => {
    const p = await writeArtifact(
      ['1. First [ask: "a"]', '2. Second [needs: 1] [ask: "b"]'].join('\n'),
    );
    const issues = [
      { id: 'wg-1', body: 'sourceElementId:scope-1' },
      { id: 'wg-2', body: 'sourceElementId:scope-2' },
    ];
    const edges = [{ from: 'wg-1', to: 'wg-2', type: 'blocks' }];
    expect(await planEvidence('sess-x', p, reader(issues, edges))).toEqual({
      acyclic: true,
      complete: true,
    });
  });

  it('an UNCOVERED design element → complete:false (independent universe blocks)', async () => {
    const p = await writeArtifact(['1. First [ask: "a"]', '2. Second [ask: "b"]'].join('\n'));
    // only scope-1 has a covering issue; scope-2 (from extractScope) is uncovered
    const issues = [{ id: 'wg-1', body: 'sourceElementId:scope-1' }];
    const ev = await planEvidence('sess-x', p, reader(issues, []));
    expect(ev.complete).toBe(false);
    expect(ev.acyclic).toBe(true);
  });

  it('a blocks CYCLE → acyclic:false', async () => {
    const p = await writeArtifact('1. First [ask: "a"]');
    const issues = [
      { id: 'wg-1', body: 'sourceElementId:scope-1' },
      { id: 'wg-2', body: 'sourceElementId:scope-1' },
    ];
    const edges = [
      { from: 'wg-1', to: 'wg-2', type: 'blocks' },
      { from: 'wg-2', to: 'wg-1', type: 'blocks' },
    ];
    const ev = await planEvidence('sess-x', p, reader(issues, edges));
    expect(ev.acyclic).toBe(false);
    expect(ev.complete).toBe(true); // scope-1 is covered
  });
});
