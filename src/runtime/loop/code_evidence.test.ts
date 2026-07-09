/**
 * SGG.2 — the CODE evidence's fourth facet `suiteGreen` (the recorded FULL declared verifySuite result).
 *
 * Behaviour is proven via an INJECTED `suite` reader — NO `.opensquid` filesystem I/O (the testing lens):
 *   green record → true; red record → false; NO record (`null`) → false (fail-closed); no active task → false.
 * The fail-closed `null → false` mirrors DEPLOY's `deploy.clean` suite read (deploy_evidence.ts).
 */
import { describe, expect, it } from 'vitest';

import { codeEvidenceForSession, type CodeEvidenceDeps } from './code_evidence.js';

/** Pure injected CODE deps — a fixed complete task + a caller-chosen recorded suite result (null = no record).
 *  AQG.4 defaults: NO arch-detector declared (`archDetectorDeclared:false`) ⇒ archClean fails OPEN to true, so
 *  the shipped SGG.2 assertions below are unaffected; the archClean matrix overrides these two fields. */
const deps = (
  suiteGreen: boolean | null,
  over: Partial<CodeEvidenceDeps> = {},
): CodeEvidenceDeps => ({
  activeTaskId: () => Promise.resolve('T'),
  phaseState: () =>
    Promise.resolve({
      task_id: 'T',
      phases: ['pre_research', 'learn', 'code', 'test', 'audit', 'post_research', 'fix'],
    }),
  readiness: () => Promise.resolve({ ran: true, deprecatedClean: true }),
  suite: () => Promise.resolve(suiteGreen),
  archDetectorDeclared: () => Promise.resolve(false),
  arch: () => Promise.resolve(null),
  ...over,
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

  it('the other facets are unaffected by the suite record (green suite → all true; arch fails open)', async () => {
    const ev = await codeEvidenceForSession('s', deps(true));
    expect(ev).toEqual({
      phasesComplete: true,
      readinessRan: true,
      deprecatedClean: true,
      suiteGreen: true,
      archClean: true,
    });
  });
});

describe('codeEvidenceForSession — AQG.4 archClean facet (injected deps, no FS I/O)', () => {
  it('UNDECLARED detector → archClean:true (fail-OPEN) regardless of any record', async () => {
    const undeclared = deps(true, {
      archDetectorDeclared: () => Promise.resolve(false),
      arch: () => Promise.resolve(false), // a stray record must NOT bite when nothing is declared
    });
    expect((await codeEvidenceForSession('s', undeclared)).archClean).toBe(true);
  });

  it('DECLARED + recorded GREEN → archClean:true', async () => {
    const green = deps(true, {
      archDetectorDeclared: () => Promise.resolve(true),
      arch: () => Promise.resolve(true),
    });
    expect((await codeEvidenceForSession('s', green)).archClean).toBe(true);
  });

  it('DECLARED + recorded RED → archClean:false (blocks code_ready)', async () => {
    const red = deps(true, {
      archDetectorDeclared: () => Promise.resolve(true),
      arch: () => Promise.resolve(false),
    });
    expect((await codeEvidenceForSession('s', red)).archClean).toBe(false);
  });

  it('DECLARED + NO record → archClean:false (fail-CLOSED once declared)', async () => {
    const unrun = deps(true, {
      archDetectorDeclared: () => Promise.resolve(true),
      arch: () => Promise.resolve(null),
    });
    expect((await codeEvidenceForSession('s', unrun)).archClean).toBe(false);
  });

  it('no active task → archClean:true (the fail-closed `closed` object keeps arch fail-OPEN)', async () => {
    const noTask = deps(true, {
      activeTaskId: () => Promise.resolve(null),
      archDetectorDeclared: () => Promise.resolve(true), // even a declared project is not bricked by no session
    });
    expect((await codeEvidenceForSession('s', noTask)).archClean).toBe(true);
  });

  it('a throwing archDetectorDeclared → archClean:true (fail-open via the `closed` object)', async () => {
    const boom = deps(true, {
      archDetectorDeclared: () => Promise.reject(new Error('unreadable')),
    });
    expect((await codeEvidenceForSession('s', boom)).archClean).toBe(true);
  });
});
