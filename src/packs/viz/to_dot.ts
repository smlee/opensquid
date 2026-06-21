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

/** The visible edges ARE the explicit named-event transitions (labelled with the event); gate's on_fail
 *  is an action, not a transition, so it rides in the JSON comment, not the graph. */
function edgesOf(pack: PackV2): Edge[] {
  // a conformance/foundation pack has no fsm → no visible flowchart edges (the round-trip comment is lossless).
  // HAR.2: an eventless transition (no `on`, e.g. a parallel join) is labelled ε (epsilon).
  return (pack.fsm?.transitions ?? []).map((t) => ({ from: t.from, to: t.to, label: t.on ?? 'ε' }));
}

export function emitDot(pack: PackV2): string {
  const lines: string[] = ['digraph pack {', `  // __osq_pack: ${JSON.stringify(pack)}`];
  for (const [name, s] of Object.entries(pack.fsm?.states ?? {})) {
    lines.push(`  "${esc(name)}" [${KIND_STYLE[s.kind]}];`);
  }
  for (const e of edgesOf(pack)) {
    const label = e.label !== undefined ? ` [label="${esc(e.label)}"]` : '';
    lines.push(`  "${esc(e.from)}" -> "${esc(e.to)}"${label};`);
  }
  lines.push('}');
  return lines.join('\n');
}
