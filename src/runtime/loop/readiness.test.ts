/**
 * T2.7 — readiness surfacers + the CODE evidence bridge (deterministic, zero LLM).
 *
 * Uses the vitest globalSetup OPENSQUID_HOME temp dir (precedent: scope_evidence.test.ts) for session-state
 * writes; the target file goes to an OS temp dir. Unique sid per test.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import type { CodeIndex } from '../coverage/check.js';
import { appendPhase } from '../workflow_phases.js';
import { writeActiveTask } from '../session_state.js';

import { codeEvidenceForSession } from './code_evidence.js';
import { recordSuite } from './verification.js';
import {
  gatherReadiness,
  readinessResult,
  recordReadiness,
  runReadiness,
  type Readiness,
} from './readiness.js';

let n = 0;
const sid = (): string => `readiness-test-${String(n++)}`;

/** A pure CodeIndex with an injectable reachability oracle (reaches([file], symbol)). */
function fakeIndex(
  exports: { name: string; file: string }[],
  reaches: (from: string[], symbol: string) => boolean = () => false,
): CodeIndex {
  return { exports, modules: [], bindings: {}, tests: {}, importGraph: { reaches } };
}

async function writeTarget(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'readiness-'));
  const p = join(dir, 'target.ts');
  await writeFile(p, body, 'utf8');
  return p;
}

const REQUIRED = ['pre_research', 'learn', 'code', 'test', 'audit', 'post_research', 'fix'];

describe('runReadiness (T2.7 surfacers)', () => {
  it('affected = reverse-dep files that reach a SYMBOL the target exports', async () => {
    const target = await writeTarget('export const foo = 1;');
    // only consumer.ts reaches `foo`; other.ts reaches nothing.
    const index = fakeIndex(
      [
        { name: 'foo', file: target },
        { name: 'usesFoo', file: 'consumer.ts' },
        { name: 'unrelated', file: 'other.ts' },
      ],
      (from, symbol) => from[0] === 'consumer.ts' && symbol === 'foo',
    );
    const r = await runReadiness(target, index);
    expect(r.affected).toEqual(['consumer.ts']);
    expect(r.existingDefs).toEqual(['foo']); // the target's own exports
  });

  it('deprecated = the target text scanned for known-deprecated calls (empty when clean)', async () => {
    const clean = await writeTarget('export const f = (s: string) => s.slice(0, 3);');
    expect((await runReadiness(clean, fakeIndex([]))).deprecated).toEqual([]);

    const dirty = await writeTarget('const x = "abc".substr(0, 2); const b = new Buffer(10);');
    const hits = (await runReadiness(dirty, fakeIndex([]))).deprecated;
    expect(hits).toContain('\\bsubstr\\(');
    expect(hits).toContain('\\bnew Buffer\\(');
  });
});

describe('recordReadiness / readinessResult (T2.7 results-gating)', () => {
  it('clean readiness → ran:true ∧ deprecatedClean:true', async () => {
    const s = sid();
    const r: Readiness = { affected: ['x.ts'], existingDefs: ['foo'], deprecated: [] };
    await recordReadiness(s, 'T2.7', r);
    expect(await readinessResult(s, 'T2.7')).toEqual({ ran: true, deprecatedClean: true });
  });

  it('a deprecated hit → ran:true ∧ deprecatedClean:false (the BLOCKING result)', async () => {
    const s = sid();
    const r: Readiness = { affected: [], existingDefs: [], deprecated: ['\\bsubstr\\('] };
    await recordReadiness(s, 'T2.7', r);
    expect(await readinessResult(s, 'T2.7')).toEqual({ ran: true, deprecatedClean: false });
  });

  it('never-run readiness → {false,false} (fail-closed)', async () => {
    const s = sid();
    expect(await readinessResult(s, 'never')).toEqual({ ran: false, deprecatedClean: false });
  });
});

describe('codeEvidenceForSession (T2.7 bridge)', () => {
  async function seedComplete(s: string, taskId: string): Promise<void> {
    await writeActiveTask(s, {
      id: taskId,
      subject: 't',
      started_at: '2026-06-26T00:00:00Z',
      taskId,
    });
    for (const p of REQUIRED) await appendPhase(s, taskId, p);
  }

  it('complete ledger + clean readiness + green suite → all four facets true (PASS)', async () => {
    const s = sid();
    await seedComplete(s, 'T2.7');
    await recordReadiness(s, 'T2.7', { affected: [], existingDefs: [], deprecated: [] });
    await recordSuite(s, 'T2.7', true); // SGG.2 — the FULL verifySuite recorded green
    expect(await codeEvidenceForSession(s)).toEqual({
      phasesComplete: true,
      readinessRan: true,
      deprecatedClean: true,
      suiteGreen: true,
    });
  });

  it('SGG.2: complete + clean readiness but NO/red suite record → suiteGreen:false (the slice is caught)', async () => {
    const s = sid();
    await seedComplete(s, 'T2.7');
    await recordReadiness(s, 'T2.7', { affected: [], existingDefs: [], deprecated: [] });
    // no recordSuite → readSuite null → fail-closed false (a CODE lap that ran only a slice cannot advance)
    expect((await codeEvidenceForSession(s)).suiteGreen).toBe(false);
    await recordSuite(s, 'T2.7', false); // an explicitly-red full suite → still false
    expect((await codeEvidenceForSession(s)).suiteGreen).toBe(false);
  });

  it('a deprecated hit → deprecatedClean:false (BLOCK), proves results-gating not just "ran"', async () => {
    const s = sid();
    await seedComplete(s, 'T2.7');
    await recordReadiness(s, 'T2.7', {
      affected: [],
      existingDefs: [],
      deprecated: ['\\bsubstr\\('],
    });
    const ev = await codeEvidenceForSession(s);
    expect(ev.readinessRan).toBe(true);
    expect(ev.deprecatedClean).toBe(false);
  });

  it('incomplete phase ledger → phasesComplete:false (BLOCK)', async () => {
    const s = sid();
    await writeActiveTask(s, {
      id: 'T2.7',
      subject: 't',
      started_at: '2026-06-26T00:00:00Z',
      taskId: 'T2.7',
    });
    await appendPhase(s, 'T2.7', 'pre_research'); // only one phase
    await recordReadiness(s, 'T2.7', { affected: [], existingDefs: [], deprecated: [] });
    expect((await codeEvidenceForSession(s)).phasesComplete).toBe(false);
  });

  it('never-run readiness → readinessRan:false (BLOCK, fail-closed)', async () => {
    const s = sid();
    await seedComplete(s, 'T2.7'); // phases complete, but readiness never recorded
    const ev = await codeEvidenceForSession(s);
    expect(ev.phasesComplete).toBe(true);
    expect(ev.readinessRan).toBe(false);
    expect(ev.deprecatedClean).toBe(false);
  });

  it('no active task → all false (fail-closed)', async () => {
    const s = sid();
    expect(await codeEvidenceForSession(s)).toEqual({
      phasesComplete: false,
      readinessRan: false,
      deprecatedClean: false,
      suiteGreen: false,
    });
  });
});

describe('gatherReadiness — cheap staged-file deprecated scan (T2.7 live wiring)', () => {
  const execFileP = promisify(execFile);
  async function repoWith(file: string, content: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'osq-readiness-'));
    await execFileP('git', ['init', '-q'], { cwd: dir });
    await execFileP('git', ['config', 'user.email', 't@t'], { cwd: dir });
    await execFileP('git', ['config', 'user.name', 't'], { cwd: dir });
    await writeFile(join(dir, file), content, 'utf8');
    await execFileP('git', ['add', file], { cwd: dir });
    return dir;
  }

  it('flags a staged source file carrying a deprecated pattern (the BLOCKING facet)', async () => {
    const dir = await repoWith('a.ts', 'export const x = "abc".substr(1);');
    expect((await gatherReadiness(dir)).deprecated.length).toBeGreaterThan(0);
  });

  it('clean staged source → no deprecated hits', async () => {
    const dir = await repoWith('a.ts', 'export const x = "abc".slice(1);');
    expect((await gatherReadiness(dir)).deprecated).toEqual([]);
  });

  it('ignores non-source staged files (only scans code)', async () => {
    const dir = await repoWith('notes.md', 'x.substr(1) in prose, not code');
    expect((await gatherReadiness(dir)).deprecated).toEqual([]);
  });

  it('FAIL-OPEN: a non-repo cwd → empty (never a false block)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'osq-norepo-'));
    expect((await gatherReadiness(dir)).deprecated).toEqual([]);
  });
});
