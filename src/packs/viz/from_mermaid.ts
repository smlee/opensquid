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

const stub = (kind: StateV2['kind'], next: string): StateV2 => {
  switch (kind) {
    case 'executor':
      return { kind, skills: [], directive: 'TODO', completion: 'TODO', next };
    case 'gate':
      return {
        kind,
        guard: 'TODO',
        on_pass: { to: next },
        on_fail: { action: 'block', message: 'TODO' },
      };
    case 'decision':
      return { kind, branches: [{ else: true, to: next }] };
    case 'sub_flow':
      return { kind, flow: 'TODO', on_complete: { to: next } };
    case 'terminal':
      return { kind, outcome: 'shipped' };
  }
};

export function skeletonFromMermaid(mmd: string): Partial<PackV2> {
  const out: Record<string, string[]> = {};
  const kinds: Record<string, StateV2['kind']> = {};
  let initial = '';
  for (const raw of mmd.split('\n')) {
    const line = raw.trim();
    // edge: `A -->|label| B` or `A --> B`
    const e = /^(\w+)\s*-->(?:\|[^|]*\|)?\s*(\w+)/.exec(line);
    if (e?.[1] !== undefined && e[2] !== undefined) {
      (out[e[1]] ??= []).push(e[2]);
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
  for (const [name, kind] of Object.entries(kinds))
    states[name] = stub(kind, out[name]?.[0] ?? name);
  return { fsm: { initial, states } };
}
