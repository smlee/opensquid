/**
 * CFD.2 / AD.3 — anchor checker tests. PURE (no I/O) — the determinism + the regex-incident drift case are
 * the load-bearing assertions (the latter proves an evidence-backed-but-unasked element is caught).
 */
import { describe, expect, it } from 'vitest';

import { type AnchorUniverse, type AuthoredElement, checkAnchors } from './anchors.js';

const universe = (over: Partial<AnchorUniverse> = {}): AnchorUniverse => ({
  askText: 'I need you to properly spec a feature that will prevent drift specs slipping in.',
  fileLines: new Set(['src/runtime/coverage/check.ts:105']),
  wgIds: new Set(['wg-78616437da18']),
  designIds: new Set(['CFD.2-§4.3']),
  ...over,
});

describe('checkAnchors (AD.3)', () => {
  it('an element quoting a verbatim span of the ask is on-topic (substring containment)', () => {
    const els: AuthoredElement[] = [
      { id: 'AD.1', anchor: { kind: 'ask_span', ref: 'prevent drift specs slipping in' } },
    ];
    expect(checkAnchors(els, universe()).drift).toEqual([]);
  });

  it('an ask_span match is whitespace-normalized (matches across prose line-wraps)', () => {
    const els: AuthoredElement[] = [
      { id: 'wrapped', anchor: { kind: 'ask_span', ref: 'prevent   drift\n  specs' } },
    ];
    expect(checkAnchors(els, universe()).drift).toEqual([]);
  });

  it('elements anchored to in-scope file_line / wg_id / design resolve', () => {
    const els: AuthoredElement[] = [
      { id: 'a', anchor: { kind: 'file_line', ref: 'src/runtime/coverage/check.ts:105' } },
      { id: 'b', anchor: { kind: 'wg_id', ref: 'wg-78616437da18' } },
      { id: 'c', anchor: { kind: 'design', ref: 'CFD.2-§4.3' } },
    ];
    expect(checkAnchors(els, universe()).drift).toEqual([]);
  });

  it('an element with NO anchor is drift (no_anchor)', () => {
    const els: AuthoredElement[] = [{ id: 'orphan', anchor: null }];
    expect(checkAnchors(els, universe()).drift).toEqual([{ id: 'orphan', reason: 'no_anchor' }]);
  });

  it('an anchor outside the task scope is drift (unresolved)', () => {
    const els: AuthoredElement[] = [
      { id: 'x', anchor: { kind: 'design', ref: 'SOME-OTHER-DESIGN' } },
    ];
    expect(checkAnchors(els, universe()).drift).toEqual([{ id: 'x', reason: 'unresolved' }]);
  });

  it('REGEX INCIDENT: an evidence-backed-but-unasked element is drift', () => {
    // The real failure: "principle 10 — regex" cited defect GM.3 (a real repo file:line) but was never in
    // the captured ask's scope. The universe (built from the ask + spec refs) does NOT contain GM.3, so the
    // element is unresolved → drift. This is the bug the whole feature exists to catch.
    const els: AuthoredElement[] = [
      {
        id: 'principle-10-regex',
        anchor: { kind: 'file_line', ref: 'packs/builtin/.../execute-gate/skill.yaml:18' },
      },
    ];
    const report = checkAnchors(els, universe());
    expect(report.drift).toEqual([{ id: 'principle-10-regex', reason: 'unresolved' }]);
  });

  it('an ask_span NOT present in the ask is drift (a fabricated quote cannot ground a root)', () => {
    const els: AuthoredElement[] = [
      { id: 'fake', anchor: { kind: 'ask_span', ref: 'use regex predicates' } },
    ];
    expect(checkAnchors(els, universe()).drift).toEqual([{ id: 'fake', reason: 'unresolved' }]);
  });

  it('is deterministic — same input twice yields identical output', () => {
    const els: AuthoredElement[] = [
      { id: 'ok', anchor: { kind: 'wg_id', ref: 'wg-78616437da18' } },
      { id: 'bad', anchor: null },
      { id: 'off', anchor: { kind: 'file_line', ref: 'nope.ts:1' } },
    ];
    const u = universe();
    expect(checkAnchors(els, u)).toEqual(checkAnchors(els, u));
  });
});
