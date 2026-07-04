/**
 * PV.1 — recover a PackV2 from DOT (T-pack-viz §PV.1).
 *
 * Two paths: (1) LOSSLESS — read the single `// __osq_pack:` comment `toDot` embedded and `JSON.parse`
 * the whole pack; (2) SKELETON — for a hand-sketched graph with no such comment, reconstruct stub states
 * from the nodes (shape → kind) + edges (transition targets), filling required fields with `TODO`
 * placeholders so the result is a valid (editable) PackV2. `index.ts` validates either through `PackV2.parse`.
 */
import type { PackV2, StateV2 } from '../schemas/pack_v2.js';

const MARK = '// __osq_pack:';

/** The embedded whole-pack JSON, or null when the graph carries none (a hand sketch). */
export function extractPackComment(dot: string): unknown {
  const line = dot.split('\n').find((l) => l.trimStart().startsWith(MARK));
  if (line === undefined) return null;
  return JSON.parse(line.slice(line.indexOf(MARK) + MARK.length).trim()); // a `//` or `"` inside the JSON is just data
}

const SHAPE_KIND: Record<string, StateV2['kind']> = {
  box: 'executor',
  diamond: 'gate',
  oval: 'terminal',
};

/** One recovered out-edge: the routed target + the named event the source emits to reach it. */
interface OutEdge {
  to: string;
  on: string;
}

/** A synthesized, collision-free event name for a sketched edge (consistent between emit + routing). */
const evName = (from: string, to: string): string => `${from}__${to}`;

/** A valid placeholder state per kind, emitting the named event(s) the skeleton routes (author edits TODOs). */
function stub(kind: StateV2['kind'], out: OutEdge[]): StateV2 {
  const first = out[0]?.on ?? 'TODO_emit';
  switch (kind) {
    case 'executor':
      return { kind, skills: [], directive: 'TODO', completion: 'TODO', emits: first };
    case 'gate':
      return {
        kind,
        guard: 'TODO',
        on_pass_emits: first,
        on_fail: { action: 'block', message: 'TODO' },
      };
    case 'decision': {
      if (out.length === 0) return { kind, branches: [{ else: true, emits: 'TODO_emit' }] };
      // one branch per out-edge; the LAST is the total `else` (the totality refine requires exactly one, last).
      const branches = out.map((o, i) =>
        i === out.length - 1
          ? { else: true as const, emits: o.on }
          : { guard: 'TODO', emits: o.on },
      );
      return { kind, branches };
    }
    case 'sub_flow':
      return { kind, flow: 'TODO', emits: first };
    case 'terminal':
      return { kind, outcome: 'shipped' };
  }
}

/** Reconstruct a stub PackV2 from a comment-less DOT graph (nodes shape→kind, edges → named-event transitions). */
export function skeletonFromGraph(dot: string): PackV2 {
  const out: Record<string, OutEdge[]> = {};
  const transitions: { from: string; on: string; to: string }[] = [];
  const kinds: Record<string, StateV2['kind']> = {};
  let initial = '';
  for (const raw of dot.split('\n')) {
    const line = raw.trim();
    const e = /^"([^"]+)"\s*->\s*"([^"]+)"/.exec(line);
    if (e?.[1] !== undefined && e[2] !== undefined) {
      const on = evName(e[1], e[2]);
      (out[e[1]] ??= []).push({ to: e[2], on });
      transitions.push({ from: e[1], on, to: e[2] });
      continue;
    }
    const n = /^"([^"]+)"\s*\[([^\]]*)\]/.exec(line);
    if (n?.[1] === undefined || n[2] === undefined) continue;
    const attrs = n[2];
    const shape = /shape=(\w+)/.exec(attrs)?.[1] ?? '';
    const kind: StateV2['kind'] = attrs.includes('peripheries=2')
      ? 'sub_flow'
      : (SHAPE_KIND[shape] ?? 'executor');
    kinds[n[1]] = kind;
    if (initial === '') initial = n[1];
  }
  const states: Record<string, StateV2> = {};
  for (const [name, kind] of Object.entries(kinds)) states[name] = stub(kind, out[name] ?? []);
  return {
    name: 'sketch',
    version: '0.0.0',
    scope: 'project',
    activation: 'on-demand',
    detected_by: [],
    fsm: { initial, states, transitions },
    guards: {},
    messages: {},
  };
}
