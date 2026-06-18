/**
 * PV.1 — emit a Graphviz DOT graph from a PackV2 (T-pack-viz §PV.1).
 *
 * The VISIBLE graph is nodes (shaped/colored by the 5 state kinds) + edges (labelled with the
 * guard/branch). The LOSSLESS round-trip rides in a single `// __osq_pack:` comment carrying the
 * whole pack as JSON — a `//` line is non-semantic per the DOT grammar (graphviz.org/doc/info/lang.html
 * defines C++-style line + block comments), so it is render-invisible by construction. `JSON.stringify`
 * is single-line, so the whole pack fits one comment line.
 */
import type { PackV2, StateV2 } from '../schemas/pack_v2.js';

const KIND_STYLE: Record<StateV2['kind'], string> = {
  executor: 'shape=box,style=filled,fillcolor="#dbeafe"',
  gate: 'shape=diamond,style=filled,fillcolor="#fee2e2"',
  decision: 'shape=diamond,style=filled,fillcolor="#fef9c3"',
  sub_flow: 'shape=box,peripheries=2,style=filled,fillcolor="#ede9fe"',
  terminal: 'shape=oval,style=filled,fillcolor="#dcfce7"',
};

/** Escape a string for a DOT double-quoted label/id context. */
const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

interface Edge {
  from: string;
  to: string;
  label?: string;
}

/** The visible transitions per kind (gate's on_fail is an action, not an edge — it rides in the JSON). */
function edgesOf(pack: PackV2): Edge[] {
  const edges: Edge[] = [];
  for (const [name, s] of Object.entries(pack.fsm.states)) {
    switch (s.kind) {
      case 'executor':
        edges.push({ from: name, to: s.next, label: s.completion });
        break;
      case 'gate':
        edges.push({ from: name, to: s.on_pass.to, label: s.guard });
        break;
      case 'decision':
        for (const b of s.branches) {
          edges.push({ from: name, to: b.to, label: 'else' in b ? 'else' : b.guard });
        }
        break;
      case 'sub_flow':
        edges.push({ from: name, to: s.on_complete.to, label: s.flow });
        break;
      case 'terminal':
        break; // no outgoing transition
    }
  }
  return edges;
}

export function emitDot(pack: PackV2): string {
  const lines: string[] = ['digraph pack {', `  // __osq_pack: ${JSON.stringify(pack)}`];
  for (const [name, s] of Object.entries(pack.fsm.states)) {
    lines.push(`  "${esc(name)}" [${KIND_STYLE[s.kind]}];`);
  }
  for (const e of edgesOf(pack)) {
    const label = e.label !== undefined ? ` [label="${esc(e.label)}"]` : '';
    lines.push(`  "${esc(e.from)}" -> "${esc(e.to)}"${label};`);
  }
  lines.push('}');
  return lines.join('\n');
}
