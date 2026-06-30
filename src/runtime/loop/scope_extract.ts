/**
 * T2.4 / AD coordination — the SINGLE shared, DETERMINISTIC scope extractor.
 *
 * A pre-research artifact → its scoped elements + their provenance anchors. The INDEPENDENT design-element
 * universe (NOT auto-decompose's output) — consumed by the SCOPE anchors gate (T2.4), by the anti-drift gate
 * (T-anti-drift-gate.md AD.3/AD.4), and by the PLAN `plan.complete` join (T2.5). Per pre-research §5
 * ("shares the captured_ask/checkAnchors/scope-element-extractor substrate — coordinate, don't duplicate") this
 * is the one place the parse lives.
 *
 * Convention (deterministic, NO LLM): each scoped element is a numbered item
 *   `N. <text> [ask: "<verbatim span of the captured ask>"]`
 * carrying its `file:line` / `wg-id` citations + optional `[needs: M]` dependency refs. The extractor PARSES
 * these markers by regex over the ARTIFACT text (not over raw command text — principle 10).
 *
 * Spec: docs/tasks/T-v2-track2-discipline.md T2.4 ("Key code shapes").
 */
import { readFile } from 'node:fs/promises';

import type { Anchor, AuthoredElement } from '../coverage/anchors.js';

export interface ScopeExtract {
  /** anchored by `ask_span` → fed to checkAnchors (on-topic = traces to the captured ask). */
  authoredElements: AuthoredElement[];
  /** AD.4 ask-grounded roots: a design-id + the verbatim ask span + the element's full authored TEXT (the
   * substance the PLAN content-audit reads — without it the audit sees only opaque ids). */
  scopeElements: { designId: string; askSpan: string; text: string }[];
  /** AD.4 leaves under a verified root: the design-id + its `file:line` / `wg-id` citations. */
  tasks: { designId: string; fileLines: string[]; wgIds: string[] }[];
  /** T2.5 autoDecompose edges: `element` depends on `dependsOn` (a `[needs: M]` ref), carrying the author's
   * DERIVED reason (the `— <reason>` slot) — what the depended-on element produces that this one consumes. */
  deps: { element: string; dependsOn: string; reason: string }[];
}

/** `path/to/file.ts:42` — a repo file:line citation. */
const FILE_LINE = /\b([a-zA-Z0-9_./-]+\.[a-z]+:\d+)\b/g;
/** `wg-abc123` — a work-graph issue id. */
const WG_ID = /\bwg-[0-9a-f]{6,}\b/g;
/** the element's DECLARED ask-trace: `[ask: "<span>"]`. */
const ASK_SPAN = /\[ask:\s*"([^"]+)"\]/;
/** a numbered list item: `N. <body>`. */
const NUMBERED = /^\s*(\d+)\.\s+(.*)$/gm;
/** a declared dependency with an OPTIONAL derived reason: `[needs: M]` or `[needs: M — <reason>]`. */
const NEEDS = /\[needs:\s*(\d+)(?:\s*[—:-]\s*([^\]]+))?\]/g;

/**
 * Parse a pre-research artifact into its scoped elements. Returns `null` when the artifact is absent (the gate
 * fails closed on a `null`). Deterministic: same file → same output.
 */
export async function extractScope(p: string): Promise<ScopeExtract | null> {
  let text: string;
  try {
    text = await readFile(p, 'utf8');
  } catch {
    return null; // absent → null (fail-closed at the gate)
  }
  const authoredElements: AuthoredElement[] = [];
  const scopeElements: ScopeExtract['scopeElements'] = [];
  const tasks: ScopeExtract['tasks'] = [];
  const deps: ScopeExtract['deps'] = [];
  for (const m of text.matchAll(NUMBERED)) {
    const num = m[1] ?? '';
    const body = m[2] ?? '';
    const id = `scope-${num}`;
    const askSpan = ASK_SPAN.exec(body)?.[1] ?? ''; // the element's DECLARED ask-trace
    const anchor: Anchor | null = askSpan ? { kind: 'ask_span', ref: askSpan } : null; // on-topic = traces to ask
    authoredElements.push({ id, anchor });
    scopeElements.push({ designId: id, askSpan, text: body.trim() });
    tasks.push({
      designId: id,
      fileLines: [...body.matchAll(FILE_LINE)].map((x) => x[1] ?? '').filter(Boolean),
      wgIds: [...body.matchAll(WG_ID)].map((x) => x[0]),
    });
    for (const d of body.matchAll(NEEDS))
      deps.push({
        element: id,
        dependsOn: `scope-${d[1] ?? ''}`,
        reason: (d[2] ?? '').trim(),
      });
  }
  return { authoredElements, scopeElements, tasks, deps };
}
