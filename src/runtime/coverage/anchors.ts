/**
 * CFD.2 / AD.3 — the PURE, deterministic anchor checker (the anti-drift verdict).
 *
 * The mirror of `check.ts`'s orphan join (check.ts:105-111): there, a gated symbol with no requirement is an
 * orphan; here, an authored/scoped element whose provenance anchor does NOT resolve in the task's anchor
 * universe is DRIFT. Pure set-membership — no I/O, no LLM, no subprocess: same input → same output. This is
 * the deterministic predicate the audit law requires (pre-research §4.5: "an audit verdict is a deterministic
 * predicate over resolvable evidence, never an LLM judgment").
 *
 * The §5 subtlety (pre-research §3.1, §4.3): resolving ANY evidence anchor is necessary but NOT sufficient —
 * an element must trace to the ASK. That is enforced by HOW the `AnchorUniverse` is built (AD.4): it contains
 * ONLY anchors that are in THIS task's specced scope (captured-ask spans + the spec's own references), NOT
 * arbitrary repo file:lines. So the regex-incident element (anchor = defect `GM.3` file:line, which exists in
 * the repo but was NOT in the captured ask's scope) is `unresolved` here → drift. The checker is pure
 * membership; the scoping lives in the universe.
 *
 * Anchor resolution: an `ask_span` is a verbatim quoted SPAN of the captured ask → whitespace-normalized
 * substring containment in the frozen ask text (a contiguous quote, never a fuzzy/semantic overlap). The
 * id-kinds (file_line/wg_id/design) are EXACT membership (check.ts:92-98 — "never a substring").
 *
 * Spec: docs/tasks/T-anti-drift-gate.md AD.3; pre-research §4.3.
 */

/** The kinds of resolvable provenance anchor (pre-research §4.3). */
export type AnchorKind = 'file_line' | 'wg_id' | 'design' | 'ask_span';

/** A single provenance anchor on an authored element. `ref` is matched EXACTLY against the universe. */
export interface Anchor {
  kind: AnchorKind;
  ref: string;
}

/** An authored/scoped element under check. `anchor === null` = ungrounded (no provenance at all). */
export interface AuthoredElement {
  id: string;
  anchor: Anchor | null;
}

/** The in-scope anchor universe for THIS task — built by AD.4 from the captured ask + the spec's references.
 *  Membership here means "traces to the ask"; an anchor outside it is out-of-scope = drift. */
export interface AnchorUniverse {
  askText: string; // the FROZEN captured user ask (the union of turns) — an ask_span resolves by verbatim
  // whitespace-normalized SUBSTRING containment in this text (a span is a contiguous quote, not an id).
  fileLines: Set<string>; // 'src/x.ts:42' refs that are part of the specced scope (leaves of the closure)
  wgIds: Set<string>; // workgraph ids in scope
  designIds: Set<string>; // design-anchor-ids in the cited design
}

/** Collapse whitespace runs to a single space + trim — so a verbatim span matches across prose line-wraps. */
function normWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Why an element is drift. `no_anchor` = no provenance at all; `unresolved` = anchor not in the task scope. */
export interface DriftItem {
  id: string;
  reason: 'no_anchor' | 'unresolved';
}

export interface DriftReport {
  drift: DriftItem[];
}

/** Does an anchor resolve in the universe? An `ask_span` is a verbatim quoted SPAN → whitespace-normalized
 *  substring containment in the frozen ask. The id-kinds (file_line/wg_id/design) are EXACT membership (no
 *  substring — check.ts:92-98), since those are identifiers, not prose. */
function resolves(a: Anchor, u: AnchorUniverse): boolean {
  switch (a.kind) {
    case 'ask_span':
      return normWs(u.askText).includes(normWs(a.ref));
    case 'file_line':
      return u.fileLines.has(a.ref);
    case 'wg_id':
      return u.wgIds.has(a.ref);
    case 'design':
      return u.designIds.has(a.ref);
  }
}

/**
 * PURE — report every element that does not trace to the captured ask / specced scope. Deterministic:
 * same input → same output. Mirrors `gatedSymbolsWithoutRequirement` (check.ts:105-111).
 */
export function checkAnchors(els: AuthoredElement[], u: AnchorUniverse): DriftReport {
  const drift: DriftItem[] = [];
  for (const el of els) {
    if (el.anchor === null) {
      drift.push({ id: el.id, reason: 'no_anchor' });
      continue;
    }
    if (!resolves(el.anchor, u)) {
      drift.push({ id: el.id, reason: 'unresolved' });
    }
  }
  return { drift };
}
