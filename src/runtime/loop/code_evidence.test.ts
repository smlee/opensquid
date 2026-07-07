/**
 * SGG.2 — the CODE evidence's fourth facet `suiteGreen` (the recorded FULL declared verifySuite result).
 *
 * Behaviour is proven via an INJECTED `suite` reader — NO `.opensquid` filesystem I/O (the testing lens):
 *   green record → true; red record → false; NO record (`null`) → false (fail-closed); no active task → false.
 * The fail-closed `null → false` mirrors DEPLOY's `deploy.clean` suite read (deploy_evidence.ts).
 */
import { describe, expect, it } from 'vitest';

import { codeEvidenceForSession, type CodeEvidenceDeps } from './code_evidence.js';

/** Pure injected CODE deps — a fixed complete task + a caller-chosen recorded suite result (null = no record). */
const deps = (suiteGreen: boolean | null): CodeEvidenceDeps => ({
  activeTaskId: () => Promise.resolve('T'),
  phaseState: () =>
    Promise.resolve({
      task_id: 'T',
      phases: ['pre_research', 'learn', 'code', 'test', 'audit', 'post_research', 'fix'],
    }),
  readiness: () => Promise.resolve({ ran: true, deprecatedClean: true }),
  suite: () => Promise.resolve(suiteGreen),
});

describe('codeEvidenceForSession — SGG.2 suiteGreen facet (injected suite reader, no FS I/O)', () => {
  it('a recorded GREEN suite → suiteGreen:true', async () => {
    expect((await codeEvidenceForSession('s', deps(true))).suiteGreen).toBe(true);
  });

  it('a recorded RED suite → suiteGreen:false', async () => {
    expect((await codeEvidenceForSession('s', deps(false))).suiteGreen).toBe(false);
  });

  it('NO suite record (null) → suiteGreen:false (fail-closed — the false-green slice is killed)', async () => {
    expect((await codeEvidenceForSession('s', deps(null))).suiteGreen).toBe(false);
  });

  it('no active task → suiteGreen:false (the fail-closed `closed` object)', async () => {
    const noTask: CodeEvidenceDeps = { ...deps(true), activeTaskId: () => Promise.resolve(null) };
    expect((await codeEvidenceForSession('s', noTask)).suiteGreen).toBe(false);
  });

  it('a throwing suite reader → suiteGreen:false (fail-closed on any throw)', async () => {
    const boom: CodeEvidenceDeps = {
      ...deps(true),
      suite: () => Promise.reject(new Error('unreadable')),
    };
    expect((await codeEvidenceForSession('s', boom)).suiteGreen).toBe(false);
  });

  it('the other three facets are unaffected by the suite record (green suite → all four true)', async () => {
    const ev = await codeEvidenceForSession('s', deps(true));
    expect(ev).toEqual({
      phasesComplete: true,
      readinessRan: true,
      deprecatedClean: true,
      suiteGreen: true,
    });
  });
});
