/**
 * PV.1 — recover a PackV2 SKELETON from a Mermaid flowchart (T-pack-viz §PV.1).
 *
 * Mermaid carries no clean home for the non-visual config, so this is honestly partial: it returns a
 * `Partial<PackV2>` — the FSM structure (states + kind-from-shape + transitions) the author fills in.
 * Kind is inferred from the node shape `toMermaid` emits: `[ ]` executor, `{ }` gate, `[[ ]]` sub_flow,
 * `(( ))` terminal. (`gate` vs `decision` both use `{ }`; the skeleton defaults the diamond to `gate`.)
 */
import type { PackV2, StateV2 } from '../schemas/pack_v2.js';

/** Infer the kind from the Mermaid shape delimiters around a node declaration. */
function kindFromShape(decl: string): StateV2['kind'] {
  if (decl.includes('[[')) return 'sub_flow';
  if (decl.includes('((')) return 'terminal';
  if (decl.includes('{')) return 'gate'; // `{ }` diamond — gate (decision shares the shape; default to gate)
  return 'executor'; // `[ ]`
}

/** One recovered out-edge: the routed target + the named event the source emits to reach it. */
interface OutEdge {
  to: string;
  on: string;
}

/** A synthesized, collision-free event name for a sketched edge (consistent between emit + routing). */
const evName = (from: string, to: string): string => `${from}__${to}`;

const stub = (kind: StateV2['kind'], out: OutEdge[]): StateV2 => {
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
};

export function skeletonFromMermaid(mmd: string): Partial<PackV2> {
  const out: Record<string, OutEdge[]> = {};
  const transitions: { from: string; on: string; to: string }[] = [];
  const kinds: Record<string, StateV2['kind']> = {};
  let initial = '';
  for (const raw of mmd.split('\n')) {
    const line = raw.trim();
    // edge: `A -->|label| B` or `A --> B`
    const e = /^(\w+)\s*-->(?:\|[^|]*\|)?\s*(\w+)/.exec(line);
    if (e?.[1] !== undefined && e[2] !== undefined) {
      const on = evName(e[1], e[2]);
      (out[e[1]] ??= []).push({ to: e[2], on });
      transitions.push({ from: e[1], on, to: e[2] });
      // a bare target seen only on an edge still counts as a node (executor default)
      kinds[e[1]] ??= 'executor';
      kinds[e[2]] ??= 'executor';
      if (initial === '') initial = e[1];
      continue;
    }
    // node declaration: `id[...]` / `id{...}` / `id[[...]]` / `id((...))`
    const n = /^(\w+)\s*([[{(].*)$/.exec(line);
    if (n?.[1] === undefined || n[2] === undefined) continue;
    kinds[n[1]] = kindFromShape(n[2]);
    if (initial === '') initial = n[1];
  }
  const states: Record<string, StateV2> = {};
  for (const [name, kind] of Object.entries(kinds)) states[name] = stub(kind, out[name] ?? []);
  return { fsm: { initial, states, transitions } };
}
