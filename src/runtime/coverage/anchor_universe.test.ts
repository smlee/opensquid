/**
 * CFD.2 / AD.4 — anchor-universe builder tests. The load-bearing case drives buildAnchorUniverse +
 * checkAnchors END-TO-END (not a pre-pruned set): the dog-food drift is produced by the live root-edge
 * verification, exactly as the spec-audit required.
 */
import { describe, expect, it } from 'vitest';

import { type AuthoredElement, checkAnchors } from './anchors.js';
import { buildAnchorUniverse, type LinkFields } from './anchor_universe.js';

const askText = 'I need you to properly spec a feature that will prevent drift specs slipping in.';

describe('buildAnchorUniverse (AD.4)', () => {
  it('admits a design-id whose ask_span is a verbatim substring of the ask, and its leaves', () => {
    const lf: LinkFields = {
      askText,
      scopeElements: [{ designId: 'D-CHECKER', askSpan: 'prevent drift specs slipping in' }],
      tasks: [
        { designId: 'D-CHECKER', fileLines: ['src/runtime/coverage/anchors.ts:1'], wgIds: [] },
      ],
    };
    const u = buildAnchorUniverse(lf);
    expect(u.designIds.has('D-CHECKER')).toBe(true);
    expect(u.fileLines.has('src/runtime/coverage/anchors.ts:1')).toBe(true);
  });

  it('REGEX INCIDENT end-to-end: a design-id declared into scope with an unverifiable ask_span is excluded, so its leaf is drift', () => {
    // The agent ASSERTS "addresses the ask" by declaring a design-id, citing a real file:line (GM.3). But its
    // ask_span is not a substring of the captured ask → root unverified → design-id excluded → GM.3 not in
    // the universe → an element anchored to GM.3 is drift. Produced by the LIVE builder, not a pruned fixture.
    const lf: LinkFields = {
      askText,
      scopeElements: [{ designId: 'D-REGEX', askSpan: 'use structured regex predicates' }],
      tasks: [
        { designId: 'D-REGEX', fileLines: ['packs/builtin/execute-gate/skill.yaml:18'], wgIds: [] },
      ],
    };
    const u = buildAnchorUniverse(lf);
    expect(u.designIds.has('D-REGEX')).toBe(false); // root NOT verified
    expect(u.fileLines.has('packs/builtin/execute-gate/skill.yaml:18')).toBe(false); // leaf excluded

    const els: AuthoredElement[] = [
      {
        id: 'principle-10-regex',
        anchor: { kind: 'file_line', ref: 'packs/builtin/execute-gate/skill.yaml:18' },
      },
    ];
    expect(checkAnchors(els, u).drift).toEqual([
      { id: 'principle-10-regex', reason: 'unresolved' },
    ]);
  });

  it('a verified element resolves end-to-end through the live builder', () => {
    const lf: LinkFields = {
      askText,
      scopeElements: [{ designId: 'D-OK', askSpan: 'prevent drift' }],
      tasks: [{ designId: 'D-OK', fileLines: ['src/x.ts:7'], wgIds: ['wg-1'] }],
    };
    const u = buildAnchorUniverse(lf);
    const els: AuthoredElement[] = [
      { id: 'ok-file', anchor: { kind: 'file_line', ref: 'src/x.ts:7' } },
      { id: 'ok-wg', anchor: { kind: 'wg_id', ref: 'wg-1' } },
    ];
    expect(checkAnchors(els, u).drift).toEqual([]);
  });

  it('is deterministic — same input twice yields identical output', () => {
    const lf: LinkFields = {
      askText,
      scopeElements: [{ designId: 'D', askSpan: 'prevent drift' }],
      tasks: [{ designId: 'D', fileLines: ['a.ts:1'], wgIds: [] }],
    };
    expect(buildAnchorUniverse(lf)).toEqual(buildAnchorUniverse(lf));
  });
});
