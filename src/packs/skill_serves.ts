/**
 * ORCH/fractal — match a SKILL's `serves` declaration against the classified turn facets, so the dispatcher
 * fires only the task-relevant lens disciplines (not all 18 lenses on every tool_call).
 *
 * Subset-match with OR over blocks (mirrors the pack matcher, `match.ts`): a skill fires iff ANY of its
 * serves-blocks has EVERY declared facet equal to the classified turn's facet. A `serves`-LESS skill is the
 * always-on core spine and is never passed here (the dispatcher treats it as ungated). PURE — no I/O.
 *
 * Imported by: src/runtime/hooks/dispatch.ts (the intra-pack containment filter).
 */
import { contains } from './taxonomy.js';

import type { SkillServes, SkillServesBlock } from './schemas/pack_v2.js';
import type { Facets } from '../runtime/classify.js';

/** The classified facets as a flat string map (undefined optionals omitted — no phantom keys). */
function facetMap(f: Facets): Record<string, string> {
  const m: Record<string, string> = { intent: f.intent };
  if (f.domain !== undefined) m.domain = f.domain; // a DOTTED path (root + derived sub-domain)
  if (f.stakes !== undefined) m.stakes = f.stakes;
  return m;
}

/**
 * A block matches when every facet it DECLARES (string-valued) is satisfied by the turn. The taxonomy axes
 * (`domain`/`lang`/`framework`) match by HIERARCHICAL CONTAINMENT with GRACEFUL DEPTH: a lens at node `v` fires
 * iff the turn's path is at-or-below `v`. So a cross-cutting `domain: coding` lens fires on any `coding.*` turn;
 * a `domain: coding.frontend` lens fires ONLY when the turn deepened to `coding.frontend` — a shallow `coding`
 * (full-stack/ambiguous) turn fires the broad coding lenses, NOT the deep frontend ones (no false depth). Every
 * other key is a strict equality match.
 *
 * FAIL-OPEN PER AXIS: a key the turn did NOT classify (absent from `fm` — e.g. a project that never declared a
 * `domain`, so `classify` emits facets with no `domain`) is NOT a constraint. We gate ONLY on the axes the turn
 * actually carries; an un-classified axis cannot exclude a lens. Without this, a domainless turn would skip EVERY
 * `domain`-declaring lens (all 18) — the opposite of the intended "when unsure, fire the discipline" back-compat.
 */
const HIERARCHICAL = new Set(['domain', 'lang', 'framework']);
function blockMatches(block: SkillServesBlock, fm: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(block)) {
    if (typeof v !== 'string') continue; // an omitted optional is not a constraint
    const turnVal = fm[k];
    if (turnVal === undefined) continue; // FAIL-OPEN: the turn carries no value for this axis → cannot gate on it
    if (HIERARCHICAL.has(k)) {
      if (!contains(v, turnVal)) return false;
    } else if (turnVal !== v) {
      return false;
    }
  }
  return true;
}

/** True iff the skill's `serves` (block or OR-list) subset-matches the classified turn facets. */
export function skillServesMatches(serves: SkillServes, facets: Facets): boolean {
  const blocks = Array.isArray(serves) ? serves : [serves];
  const fm = facetMap(facets);
  return blocks.some((b) => blockMatches(b, fm));
}

/**
 * LAYER-3 #37 — domain-only match for the null-classifiedFacets fallback in dispatch.ts.
 *
 * When the turn's classified facets are null (no prompt classified yet) but the project's declared
 * `domain` is known (from orchestrator_settings), checks whether a `serves`-bearing skill's domain
 * constraint allows this project domain. A block MATCHES (skill fires) iff it either
 * (a) declares no `domain` field, or (b) its declared `domain` CONTAINS the project domain via
 * hierarchical containment (`contains(declaredDomain, projectDomain)`): `coding` contains `coding`,
 * but `coding.frontend` does NOT contain `coding` — no false depth. OR-over-blocks: any matching
 * block fires the skill.
 *
 * Does NOT gate on `intent` or `stakes` — those axes are unconstrained in the null-classification
 * fallback (only the project domain is known, not the current turn's intent). A serves-less skill
 * (the always-on spine) never reaches this function; the dispatcher handles that upstream.
 *
 * PURE — no I/O. Imported only by dispatch.ts.
 */
export function skillServesDomainMatches(serves: SkillServes, projectDomain: string): boolean {
  const blocks = Array.isArray(serves) ? serves : [serves];
  return blocks.some((b) => {
    const dom = (b as Record<string, unknown>).domain;
    if (typeof dom !== 'string') return true; // no domain constraint in this block → matches
    return contains(dom, projectDomain);
  });
}
