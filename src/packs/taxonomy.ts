/**
 * ORCH / pack-taxonomy — the canonical activation DICTIONARY + hierarchical containment (the v2 design,
 * docs/design/pack-taxonomy.md). The mechanism is dotted-path nodes per axis (`domain`/`lang`/`framework`) with
 * GRACEFUL-DEPTH containment: a pack/skill at node N activates when the classified path is AT-OR-BELOW N
 * (`coding.frontend.react` fires nodes at `coding`, `coding.frontend`, and `coding.frontend.react`; a
 * `coding.frontend` request does NOT fire `coding.frontend.react`). Replaces the flat two-value `area` axis —
 * the full settled design, not a reduced subset (completeness law).
 *
 * The dictionary is the SINGLE SOURCE with three consumers (no drift): the classifier's vocabulary, the
 * load-time pack/skill `categories` validation (off-dictionary → fail-loud), and the generated docs. Growth is a
 * DELIBERATE edit here — an off-dictionary node is ALWAYS an error, never an auto-create (guess-free).
 *
 * PURE — no I/O. Imported by classify (emit), match (containment), and the loader (validate).
 */

/** A node tree per axis: each key is a node; its value is the sub-tree (`{}` = a leaf). Dotted paths address it. */
export interface NodeTree {
  [node: string]: NodeTree;
}

/**
 * The canonical dictionary (seeded from docs/design/pack-taxonomy.md §"Canonical dictionary"). Each axis is its
 * own registry of dotted nodes. Growth = a deliberate edit HERE (reviewed); an off-registry coordinate fails load.
 */
export const TAXONOMY: Record<string, NodeTree> = {
  // WHAT the work is. `coding` carries the sub-domains the fullstack-flow lenses gate by.
  domain: {
    coding: { frontend: {}, backend: {}, testing: {} },
    content: { seo: {}, brand: {} },
    research: {},
    planning: {},
    docs: {},
    design: {},
    ops: {},
    meta: { 'pack-authoring': {}, 'scope-authoring': {}, 'task-authoring': {} },
  },
  // orthogonal — cross-cuts domain (typescript spans front+back).
  lang: { typescript: {}, python: {}, go: {} },
  // orthogonal — frameworks/runtimes.
  framework: { react: {}, vue: {}, node: {} },
};

/** Split a dotted path into its segments (`'coding.frontend'` → `['coding','frontend']`); '' → []. */
function segments(path: string): string[] {
  return path.length === 0 ? [] : path.split('.');
}

/**
 * Is `path` a valid node of `axis` in the dictionary? Walks the dotted segments through the axis tree; an unknown
 * segment at any depth → false (fail-loud is the caller's job). An empty path is NOT a valid node.
 */
export function isNode(axis: string, path: string): boolean {
  const segs = segments(path);
  if (segs.length === 0) return false;
  let tree: NodeTree | undefined = TAXONOMY[axis];
  for (const s of segs) {
    if (tree === undefined || !Object.prototype.hasOwnProperty.call(tree, s)) return false;
    tree = tree[s];
  }
  return true;
}

/**
 * Hierarchical containment: does the declared node `at` CONTAIN the classified `path` — i.e. is `path` at-or-below
 * `at`? True iff `at`'s segments are a PREFIX of `path`'s segments (`coding` contains `coding.frontend`;
 * `coding.frontend` does NOT contain `coding`; equal paths contain each other). Segment-wise (never substring):
 * `coding` does not contain `coding2`.
 */
export function contains(at: string, path: string): boolean {
  const a = segments(at);
  const p = segments(path);
  if (a.length > p.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== p[i]) return false;
  return true;
}
