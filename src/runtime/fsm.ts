/**
 * T-PACK-FSM-STANDARDIZATION slice A + T-harel-full HAR.0 — the FSM engine.
 *
 * TWO LAYERS, cleanly split (the wire/runtime separation `compile_v2` already uses):
 *
 *  1. WIRE (flat, declarative) — `Fsm` (Zod): `{ initial, states[], transitions }`, the
 *     `fsm.yaml` shape. Validated by `validateFsm`. This is what packs DECLARE.
 *  2. RUNTIME (tree, executable) — `Statechart`: a natively HIERARCHICAL Harel statechart
 *     (a state is a `leaf`, a `compound` with one active child, or `parallel` with all
 *     regions active). `step` runs over a CONFIGURATION — the set of active leaf PATHS
 *     (`build/backend`) — resolving the enabled transition through the LCCA (least common
 *     compound ancestor) to compute the exit + entry sets. `fromFlat` lifts a flat `Fsm`
 *     into the degenerate all-leaf tree, so every existing flat FSM runs byte-identically
 *     (a singleton configuration).
 *
 * The engine is the tree statechart (HAR.0, the de-flatten); the flat wire is its
 * degenerate case. Pillars built on this: HAR.1 hierarchy (nested machines), HAR.2
 * orthogonality (parallel fork/join), HAR.3 history (`lastActive`).
 *
 * Invariants (opensquid-fsm-architecture.html): #1 PURE (injected `evalWhen`; no
 * clock/queue — the XState-interpreter trap is forbidden) · #2 TOTAL (every
 * (config,event) → a defined outcome; explicit per-config stay default).
 *
 * Imports: zod only. Imported by: fsm_state, actor/port, loop/driver, exe/transitions,
 * packs/{compile_v2,loader,flows_compiler,migrate_v1_to_v2,schemas/pack_v2}, runtime/types,
 * functions/registry, daemon/host; tests.
 */
import { z } from 'zod';

/** A wildcard `from` matching any current state / active configuration (root-scoped). */
export const ANY_STATE = '*' as const;

// ─────────────────────────────────────────────────────────────────────────────
// WIRE FORMAT (flat, declarative) — `fsm.yaml`. UNCHANGED shape; lifted via fromFlat.
// ─────────────────────────────────────────────────────────────────────────────
export const Transition = z
  .object({
    /** Source state (a wire state name, or a runtime path for a tree); `*` matches any. */
    from: z.string().min(1),
    /** Event name that fires this transition. ABSENT = an EVENTLESS transition (HAR.2 parallel join):
     *  `step`'s event-loop skips it (`t.on !== event` when undefined); only `settle` fires it. */
    on: z.string().min(1).optional(),
    /** Target state — MUST be a declared state (validateFsm / validateStatechart enforce). */
    to: z.string().min(1),
    /** Optional `if:`-expression guard; evaluated via the injected evalWhen. */
    when: z.string().min(1).optional(),
  })
  .strict();
export type Transition = z.infer<typeof Transition>;

export const Fsm = z
  .object({
    initial: z.string().min(1),
    states: z.array(z.string().min(1)).min(1),
    transitions: z.array(Transition).default([]),
  })
  .strict();
export type Fsm = z.infer<typeof Fsm>;

/**
 * Load-time validation of the flat WIRE FSM. Returns human-readable errors ([] = valid).
 * Total by construction once these pass: every declared transition lands on a real state,
 * and the runner defines an outcome for every (state, event).
 */
export function validateFsm(fsm: Fsm): string[] {
  const errors: string[] = [];
  const states = new Set(fsm.states);
  if (!states.has(fsm.initial)) {
    errors.push(`initial state "${fsm.initial}" is not in states [${fsm.states.join(', ')}]`);
  }
  fsm.transitions.forEach((t, i) => {
    if (t.from !== ANY_STATE && !states.has(t.from)) {
      errors.push(`transition[${String(i)}] from "${t.from}" is not a declared state`);
    }
    if (!states.has(t.to)) {
      errors.push(`transition[${String(i)}] to "${t.to}" is not a declared state`);
    }
  });
  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// RUNTIME MODEL (tree) — the executable Harel statechart.
// ─────────────────────────────────────────────────────────────────────────────
/** The separator between path segments in a leaf path (`compound/child/leaf`). */
export const PATH_SEP = '/' as const;

/** A node in the state tree. `leaf` atomic; `compound` one active child; `parallel` all regions active. */
export type StateNode =
  | { kind: 'leaf' }
  | { kind: 'final' } // HAR.2 — a region's terminal marker (atomic, like leaf); drives the parallel join
  | { kind: 'compound'; initial: string; states: Record<string, StateNode> }
  | { kind: 'parallel'; regions: Record<string, StateNode> };

/** The executable statechart: top-level states + the cross-tree transition list. */
export interface Statechart {
  initial: string; // a top-level child name
  root: Record<string, StateNode>;
  transitions: Transition[];
}

/** A configuration = the set of active LEAF PATHS. compound → one child path; parallel → all regions. */
export type Configuration = ReadonlySet<string>;

export interface StepResult {
  /** The next configuration (== current when no transition fired — total/explicit stay). */
  next: Configuration;
  /** True iff a transition actually changed the configuration. */
  transitioned: boolean;
  /** The id (index) of the transition taken, or null for the stay default. */
  via: number | null;
}

const segs = (path: string): string[] => path.split(PATH_SEP);
const joinPath = (...parts: string[]): string => parts.filter((p) => p.length > 0).join(PATH_SEP);

/** Resolve a node by its path (`a/b/c`) against the tree, or undefined if absent. */
export function resolveNode(sc: Statechart, path: string): StateNode | undefined {
  let level: Record<string, StateNode> | undefined = sc.root;
  let node: StateNode | undefined;
  for (const name of segs(path)) {
    if (level === undefined) return undefined;
    node = level[name];
    if (node === undefined) return undefined;
    level =
      node.kind === 'compound' ? node.states : node.kind === 'parallel' ? node.regions : undefined;
  }
  return node;
}

/**
 * The leaf paths activated by ENTERING the node at `path` (resolving downward):
 * leaf → [path]; compound → enter its `initial` child; parallel → union of all regions.
 */
export function enterLeaves(sc: Statechart, path: string): string[] {
  const node = resolveNode(sc, path);
  if (node === undefined) return [];
  if (node.kind === 'leaf' || node.kind === 'final') return [path]; // both atomic
  if (node.kind === 'compound') return enterLeaves(sc, joinPath(path, node.initial));
  return Object.keys(node.regions).flatMap((r) => enterLeaves(sc, joinPath(path, r)));
}

/** The initial configuration: enter the tree's `initial` top-level state down to leaves. */
export function initialConfig(sc: Statechart): Configuration {
  return new Set(enterLeaves(sc, sc.initial));
}

/** The single active leaf of a degenerate/flat configuration (back-compat for string-state consumers). */
export function soleState(config: Configuration): string {
  return config.values().next().value ?? '';
}

/** Is `path` an active leaf, or an ancestor of one, in `config`? (a transition's `from` is "active".) */
function isActive(config: Configuration, path: string): boolean {
  const prefix = path + PATH_SEP;
  for (const leaf of config) if (leaf === path || leaf.startsWith(prefix)) return true;
  return false;
}

/**
 * The least common compound ANCESTOR path of two state paths (`''` = the root scope) — the node
 * where the source and target diverge. The exit set is its active descendants on the source side,
 * so a transition stays scoped to the smallest enclosing region (parallel regions stay independent).
 * (No `pop`: the divergence-point IS the enclosing ancestor — a leaf can't be a common ancestor of
 * two distinct paths, and an equal path self-transition exits+re-enters that state.)
 */
function lcca(a: string, b: string): string {
  const A = segs(a);
  const B = segs(b);
  const common: string[] = [];
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    if (A[i] === B[i]) common.push(A[i]!);
    else break;
  }
  return common.join(PATH_SEP);
}

/** Active leaves that are descendants of `scope` (`''` = all) — the exit set when leaving `scope`. */
function descendantsOf(config: Configuration, scope: string): string[] {
  if (scope === '') return [...config];
  const prefix = scope + PATH_SEP;
  return [...config].filter((leaf) => leaf === scope || leaf.startsWith(prefix));
}

/** Collect every resolvable node path in the tree (for transition-target checking). */
function allPaths(level: Record<string, StateNode>, base: string, out: Set<string>): void {
  for (const [name, node] of Object.entries(level)) {
    const path = joinPath(base, name);
    out.add(path);
    if (node.kind === 'compound') allPaths(node.states, path, out);
    else if (node.kind === 'parallel') allPaths(node.regions, path, out);
  }
}

/** Recursive validation of the runtime tree: compound.initial declared; transitions resolve. [] = valid. */
export function validateStatechart(sc: Statechart): string[] {
  const errors: string[] = [];
  const paths = new Set<string>();
  allPaths(sc.root, '', paths);
  if (!(sc.initial in sc.root))
    errors.push(`initial state "${sc.initial}" is not a top-level state`);

  const checkInitials = (level: Record<string, StateNode>, base: string): void => {
    for (const [name, node] of Object.entries(level)) {
      const path = joinPath(base, name);
      if (node.kind === 'compound') {
        if (!(node.initial in node.states)) {
          errors.push(`compound "${path}" initial "${node.initial}" is not one of its states`);
        }
        checkInitials(node.states, path);
      } else if (node.kind === 'parallel') {
        checkInitials(node.regions, path);
      }
    }
  };
  checkInitials(sc.root, '');

  sc.transitions.forEach((t, i) => {
    if (t.from !== ANY_STATE && !paths.has(t.from)) {
      errors.push(`transition[${String(i)}] from "${t.from}" is not a declared state path`);
    }
    if (!paths.has(t.to)) {
      errors.push(`transition[${String(i)}] to "${t.to}" is not a declared state path`);
    }
    // HAR.2 — an eventless edge (no `on`) may ONLY originate from a parallel (the join construct).
    if (
      t.on === undefined &&
      t.from !== ANY_STATE &&
      resolveNode(sc, t.from)?.kind !== 'parallel'
    ) {
      errors.push(
        `transition[${String(i)}] eventless from "${t.from}" is not a parallel (only a parallel join may be eventless)`,
      );
    }
  });
  // HAR.2 — a FINALIZABLE parallel (its subtree contains a `final`) MUST have an eventless join edge,
  // else an all-regions-final config silently deadlocks.
  for (const p of parallelPaths(sc)) {
    if (subtreeHasFinal(sc, p) && !sc.transitions.some((t) => t.from === p && t.on === undefined)) {
      errors.push(
        `finalizable parallel "${p}" has no eventless join transition (would deadlock on all-regions-final)`,
      );
    }
  }
  return errors;
}

/**
 * The TOTAL transition function over configurations. Resolves the FIRST enabled transition for
 * `event` (document order): `from` is `*` or active, `on` equals `event`, `when` guard (if any)
 * holds. The enabled transition exits the active descendants of the LCCA(from,to) and enters `to`
 * down to its leaves. No enabled transition → explicit stay (whole config, transitioned:false). PURE.
 */
export function step(
  sc: Statechart,
  config: Configuration,
  event: string,
  evalWhen?: (expr: string) => boolean,
): StepResult {
  for (let i = 0; i < sc.transitions.length; i++) {
    const t = sc.transitions[i]!;
    if (t.on !== event) continue;
    if (!(t.from === ANY_STATE || isActive(config, t.from))) continue;
    if (t.when !== undefined && evalWhen !== undefined && !evalWhen(t.when)) continue;

    const scope = t.from === ANY_STATE ? '' : lcca(t.from, t.to);
    const exit = new Set(descendantsOf(config, scope));
    const next = new Set<string>();
    for (const leaf of config) if (!exit.has(leaf)) next.add(leaf);
    for (const leaf of enterLeaves(sc, t.to)) next.add(leaf);

    const changed = next.size !== config.size || [...next].some((p) => !config.has(p));
    return { next, transitioned: changed, via: i };
  }
  return { next: config, transitioned: false, via: null };
}

/** Lift a flat wire `Fsm` (all states leaves at the root) into the degenerate-tree `Statechart`. */
export function fromFlat(fsm: Fsm): Statechart {
  const root: Record<string, StateNode> = {};
  for (const s of fsm.states) root[s] = { kind: 'leaf' };
  return { initial: fsm.initial, root, transitions: fsm.transitions };
}

/** The flat-FSM result shape (string next-state) — the back-compat return of `stepFlat`. */
export interface FlatStepResult {
  next: string;
  transitioned: boolean;
  via: number | null;
}

/**
 * Flat-FSM convenience: step a flat wire `Fsm` by a single string state, returning a string
 * next-state. The degenerate-tree path (singleton configuration) every current flat consumer +
 * parity test uses — a thin facade over the tree `step`, identical behavior to the pre-HAR.0 engine.
 */
export function stepFlat(
  fsm: Fsm,
  current: string,
  event: string,
  evalWhen?: (expr: string) => boolean,
): FlatStepResult {
  const r = step(fromFlat(fsm), new Set([current]), event, evalWhen);
  return { next: soleState(r.next), transitioned: r.transitioned, via: r.via };
}

// ─────────────────────────────────────────────────────────────────────────────
// HAR.2 — orthogonality: `final` regions + the eventless JOIN macrostep (`settle`).
// ─────────────────────────────────────────────────────────────────────────────
/** Is the node at `leaf` a `final` node? */
const isFinal = (sc: Statechart, leaf: string): boolean => resolveNode(sc, leaf)?.kind === 'final';

/** All `parallel` node paths, DEEPEST-FIRST (so `settle` joins inner parallels before outer → confluent). */
function parallelPaths(sc: Statechart): string[] {
  const out: string[] = [];
  const walk = (level: Record<string, StateNode>, base: string): void => {
    for (const [name, node] of Object.entries(level)) {
      const p = joinPath(base, name);
      if (node.kind === 'compound') walk(node.states, p);
      else if (node.kind === 'parallel') {
        out.push(p);
        walk(node.regions, p);
      }
    }
  };
  walk(sc.root, '');
  return out.sort((a, b) => segs(b).length - segs(a).length);
}

/** Does the subtree at `path` contain a `final` node? (a parallel is FINALIZABLE iff this holds). */
function subtreeHasFinal(sc: Statechart, path: string): boolean {
  const node = resolveNode(sc, path);
  if (node === undefined) return false;
  if (node.kind === 'final') return true;
  if (node.kind === 'compound')
    return Object.keys(node.states).some((k) => subtreeHasFinal(sc, joinPath(path, k)));
  if (node.kind === 'parallel')
    return Object.keys(node.regions).some((k) => subtreeHasFinal(sc, joinPath(path, k)));
  return false;
}

/**
 * Every region of the parallel at `parallelPath` is DONE — its active leaf is a `final` node that is the
 * region ITSELF (an atomic-`final` region) OR a DIRECT child of the region (NOT a deeper descendant; SCXML).
 * A region whose active state is deeper (e.g. an inner parallel not yet joined) is NOT done.
 */
function allRegionsFinal(sc: Statechart, parallelPath: string, config: Configuration): boolean {
  const node = resolveNode(sc, parallelPath);
  if (node?.kind !== 'parallel') return false;
  return Object.keys(node.regions).every((r) => {
    const rp = joinPath(parallelPath, r);
    const rpDepth = segs(rp).length;
    return [...config].some(
      (leaf) =>
        isFinal(sc, leaf) &&
        (leaf === rp || (leaf.startsWith(rp + PATH_SEP) && segs(leaf).length === rpDepth + 1)),
    );
  });
}

/**
 * MACROSTEP — fire EVENTLESS parallel-joins to a fixpoint, INNERMOST-FIRST (confluent). For any active,
 * all-regions-final parallel with an eventless `from: parallelPath` edge, exit the whole parallel subtree
 * and enter the join target. PURE (config + static transitions), no event queue (the D1/OQ-4 law).
 * Compose: a tree run is `step` (event microstep) then `settle` (eventless macrostep).
 */
export function settle(
  sc: Statechart,
  config: Configuration,
  evalWhen?: (expr: string) => boolean,
): Configuration {
  const joinEdge = (p: string): Transition | undefined =>
    sc.transitions.find(
      (t) =>
        t.from === p &&
        t.on === undefined &&
        (t.when === undefined || evalWhen === undefined || evalWhen(t.when)),
    );
  let cur = config;
  for (let i = 0; i < 10_000; i++) {
    // parallelPaths is deepest-first → the first eligible is the INNERMOST all-final parallel.
    const pPath = parallelPaths(sc).find(
      (p) => isActive(cur, p) && allRegionsFinal(sc, p, cur) && joinEdge(p) !== undefined,
    );
    if (pPath === undefined) return cur; // fixpoint
    const join = joinEdge(pPath)!;
    const exit = new Set(descendantsOf(cur, pPath)); // exit the whole parallel subtree
    const next = new Set<string>();
    for (const leaf of cur) if (!exit.has(leaf)) next.add(leaf);
    for (const leaf of enterLeaves(sc, join.to)) next.add(leaf);
    cur = next;
  }
  return cur; // depth backstop
}
