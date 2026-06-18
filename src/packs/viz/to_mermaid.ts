/**
 * PV.1 — emit a Mermaid flowchart from a PackV2 (T-pack-viz §PV.1).
 *
 * Human-first VIZ: node shape by kind (executor `[ ]`, gate/decision `{ }` diamond, sub_flow `[[ ]]`,
 * terminal `( )`), edges labelled with the guard/branch. Mermaid is viz + skeleton-import only (the
 * lossless round-trip lives in DOT) — so this emits the structure, not the non-visual config.
 */
import type { PackV2, StateV2 } from '../schemas/pack_v2.js';

/** Wrap a node id in the kind's Mermaid shape; the label is the state name. */
function node(name: string, kind: StateV2['kind']): string {
  const label = name.replace(/"/g, '&quot;');
  switch (kind) {
    case 'executor':
      return `${name}["${label}"]`;
    case 'gate':
    case 'decision':
      return `${name}{"${label}"}`;
    case 'sub_flow':
      return `${name}[["${label}"]]`;
    case 'terminal':
      return `${name}(("${label}"))`;
  }
}

interface Edge {
  from: string;
  to: string;
  label?: string;
}

/** The edges ARE the explicit named-event transitions, labelled with the event name. */
function edgesOf(pack: PackV2): Edge[] {
  return pack.fsm.transitions.map((t) => ({ from: t.from, to: t.to, label: t.on }));
}

export function emitMermaid(pack: PackV2): string {
  const lines: string[] = ['flowchart TD'];
  for (const [name, s] of Object.entries(pack.fsm.states)) lines.push(`  ${node(name, s.kind)}`);
  for (const e of edgesOf(pack)) {
    const label = e.label !== undefined ? `|${e.label.replace(/"/g, '&quot;')}|` : '';
    lines.push(`  ${e.from} -->${label} ${e.to}`);
  }
  return lines.join('\n');
}
