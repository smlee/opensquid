/** PV.1 — pack-viz: lossless DOT round-trip + skeleton import + compile-first. */
import { describe, expect, it } from 'vitest';

import { PackV2 } from '../schemas/pack_v2.js';
import { fromDot, fromMermaid, toDot, toMermaid } from './index.js';

// A fixture exercising all 5 kinds + non-empty detected_by/guards/messages (incl. a value with
// quotes / `//` / a newline / nested objects — the JSON-escape contract).
const FIXTURE = PackV2.parse({
  name: 'demo',
  version: '0.1.0',
  scope: 'project',
  detected_by: [{ kind: 'file_exists', path: 'package.json' }],
  guards: {
    size_ok: {
      expr: 'lines < 500',
      note: 'a "tricky" value with // and\na newline',
      nested: { a: [1, 2] },
    },
  },
  messages: { too_big: 'split it' },
  fsm: {
    initial: 'review',
    states: {
      review: {
        kind: 'executor',
        executor: 'codex',
        skills: ['spec'],
        directive: 'review',
        completion: 'ok',
        emits: 'reviewed',
      },
      size: {
        kind: 'gate',
        guard: 'size_ok',
        on_pass_emits: 'size_passed',
        on_fail: { action: 'block', message: 'too big' },
      },
      decide: {
        kind: 'decision',
        branches: [
          { guard: 'hot', emits: 'is_hot' },
          { else: true, emits: 'not_hot' },
        ],
      },
      build: { kind: 'sub_flow', flow: 'build_impl', emits: 'built' },
      done: { kind: 'terminal', outcome: 'shipped' },
    },
    transitions: [
      { from: 'review', on: 'reviewed', to: 'size' },
      { from: 'size', on: 'size_passed', to: 'decide' },
      { from: 'decide', on: 'is_hot', to: 'build' },
      { from: 'decide', on: 'not_hot', to: 'done' },
      { from: 'build', on: 'built', to: 'done' },
    ],
  },
});

describe('toDot / fromDot (PV.1)', () => {
  it('fromDot(toDot(p)) deep-equals p — LOSSLESS over all kinds + non-empty config', () => {
    expect(fromDot(toDot(FIXTURE))).toEqual(FIXTURE);
  });

  it('the lossless config (the tricky guards value) survives the round-trip exactly', () => {
    const back = fromDot(toDot(FIXTURE));
    expect(back.guards).toEqual(FIXTURE.guards); // quotes / // / newline / nested object all preserved
  });

  it('toDot shapes/colors nodes by kind + carries the embedded comment', () => {
    const dot = toDot(FIXTURE);
    expect(dot).toContain('// __osq_pack:');
    expect(dot).toMatch(/"review" \[shape=box/); // executor
    expect(dot).toMatch(/"size" \[shape=diamond/); // gate
    expect(dot).toMatch(/"done" \[shape=oval/); // terminal
    expect(dot).toContain('"review" -> "size" [label="reviewed"]'); // edge labelled with the named event
    expect(dot).toContain('"decide" -> "done" [label="not_hot"]'); // decision else-branch event
  });

  it('a comment-less (hand-sketched) DOT graph → a valid stub skeleton', () => {
    const sketch = 'digraph g {\n  "a" [shape=box];\n  "b" [shape=oval];\n  "a" -> "b";\n}';
    const pack = fromDot(sketch);
    expect(pack.fsm.initial).toBe('a');
    expect(pack.fsm.states.a?.kind).toBe('executor');
    expect(pack.fsm.states.b?.kind).toBe('terminal');
    // the stub is a VALID PackV2: the executor emits a named event routed to its out-edge target
    expect(pack.fsm.states.a).toMatchObject({ kind: 'executor', emits: 'a__b' });
    expect(pack.fsm.transitions).toContainEqual({ from: 'a', on: 'a__b', to: 'b' });
  });
});

describe('toMermaid / fromMermaid (PV.1)', () => {
  it('toMermaid shapes nodes by kind', () => {
    const m = toMermaid(FIXTURE);
    expect(m).toContain('flowchart TD');
    expect(m).toContain('review["review"]'); // executor
    expect(m).toContain('size{"size"}'); // gate diamond
    expect(m).toContain('done(("done"))'); // terminal
  });

  it('fromMermaid recovers a skeleton (states + transitions + kind)', () => {
    const skel = fromMermaid(toMermaid(FIXTURE));
    expect(Object.keys(skel.fsm?.states ?? {})).toEqual(
      expect.arrayContaining(['review', 'size', 'decide', 'build', 'done']),
    );
    expect(skel.fsm?.states.review?.kind).toBe('executor');
  });
});

describe('compile-first (PV.1)', () => {
  it('toDot throws on an invalid pack (a decision with a dangling target)', () => {
    const bad = PackV2.parse({
      name: 'bad',
      version: '0.0.0',
      scope: 'project',
      fsm: {
        initial: 's',
        states: { s: { kind: 'decision', branches: [{ else: true, emits: 'go' }] } },
        transitions: [{ from: 's', on: 'go', to: 'nowhere' }],
      },
    });
    expect(() => toDot(bad)).toThrow(); // validateFsm: `nowhere` is not a declared state
  });
});
