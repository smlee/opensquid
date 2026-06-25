/**
 * CFD.2 / AD.4 — the anchor-universe builder (the I/O companion of the pure `checkAnchors`).
 *
 * Mirrors the `index_build.ts` split (CFD.1): the pure checker (`anchors.ts`) does membership only; THIS
 * module assembles the in-scope universe — the transitive closure rooted at the captured ask (pre-research
 * §4.3). The load-bearing step is **root-edge verification**: a scope element's design-id is admitted into
 * the universe ONLY if its declared `ask_span` is a whitespace-normalized verbatim SUBSTRING of the frozen
 * captured ask. A declared-but-unverifiable root is NOT admitted — so the drift hole "cannot move up one
 * layer" (the exact failure the spec-audit caught). Leaves (file:lines / wg-ids) enter the universe only
 * under a verified root. The regex incident: a design-id declared into scope with an `ask_span` the ask does
 * not contain fails verification → its task's `GM.3` leaf is excluded → an element anchored to `GM.3` is
 * drift. Deterministic, no LLM.
 *
 * Spec: docs/tasks/T-anti-drift-gate.md AD.4; pre-research §4.3.
 */
import type { AnchorUniverse } from './anchors.js';

/** A scope element's ROOT-edge declaration: a design-id grounded by a verbatim quote of the captured ask. */
export interface ScopeElement {
  designId: string;
  askSpan: string; // must be a verbatim substring of the frozen ask for the design-id to be admitted
}

/** A spec task's lower-edge declaration: the design-id it implements + the leaves it owns. */
export interface TaskLink {
  designId: string;
  fileLines: string[];
  wgIds: string[];
}

/** The link fields the builder joins on (pre-research §5 item 6). `askText` is AD.1's frozen captured ask. */
export interface LinkFields {
  askText: string;
  scopeElements: ScopeElement[];
  tasks: TaskLink[];
}

/** Collapse whitespace runs + trim — the same contract as anchors.ts `normWs` (matches across prose wraps). */
function normWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Build the in-scope anchor universe by VERIFYING each scope element's root edge, then admitting only the
 * leaves owned by a verified design-id. PURE (its inputs are the already-read `LinkFields`).
 */
export function buildAnchorUniverse(lf: LinkFields): AnchorUniverse {
  const ask = normWs(lf.askText);
  // ROOT-EDGE VERIFICATION: admit a design-id ONLY if its scope element quotes a verbatim span of the ask.
  const verified = new Set(
    lf.scopeElements.filter((e) => ask.includes(normWs(e.askSpan))).map((e) => e.designId),
  );
  const live = lf.tasks.filter((t) => verified.has(t.designId)); // leaves only under a verified root
  return {
    askText: lf.askText,
    fileLines: new Set(live.flatMap((t) => t.fileLines)),
    wgIds: new Set(live.flatMap((t) => t.wgIds)),
    designIds: verified,
  };
}
