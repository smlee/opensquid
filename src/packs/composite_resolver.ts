/**
 * MM.1 — Composite-pack include expansion at load time.
 *
 * Walks every composite pack's `includes: [{pack_id, semver}]` against the
 * registry of discovered packs (passed in as the input list). Returns an
 * expanded flat list containing:
 *   - every original focused pack (in input order)
 *   - every composite pack (preserved for identity / audit / diagnostics)
 *   - every focused pack referenced by any composite's includes (deduped
 *     across composites; first-occurrence-wins for ordering;
 *     scope-precedence per `sortPacksByScope` preserved when the caller
 *     applies it AFTER expansion)
 *
 * Cycle detection: per-root visited-set keyed on pack name; revisit within
 * one walk → load-time error with the cycle path.
 *
 * Depth-cap: MAX_COMPOSITE_DEPTH (3) levels of nested composite expansion
 * per audit risk callout (composite-of-composites is allowed but capped).
 * Exceeding the cap → load-time error.
 *
 * Missing include: composite references a pack_id not in the registry →
 * load-time error with clear path-bearing message naming the composite,
 * the missing pack_id, and the unsatisfied semver range.
 *
 * Semver mismatch: composite references pack_id present in registry but
 * the registry pack's version does NOT satisfy the composite's semver
 * range → load-time error naming all three (composite, included pack,
 * range, found version).
 *
 * Pure: no I/O; takes the registry as input. Caller (discovery.ts)
 * supplies the already-loaded pack list.
 *
 * Discovery-time caching contract: composite expansion happens AT DISCOVERY
 * TIME (not at dispatch time). The expanded list is cached for the session.
 * A user `pnpm install` of a new pack mid-session won't be picked up until
 * session restart (matches IDF.3 caching contract).
 *
 * Duplicate `pack_id` entries within one composite's includes are allowed by
 * the schema; the resolver picks first-occurrence semver per
 * include-order intent.
 */
import {
  satisfies as semverSatisfies,
  valid as semverValid,
  validRange as semverValidRange,
} from 'semver';

import type { Pack } from '../runtime/types.js';

export const MAX_COMPOSITE_DEPTH = 3;

export class CompositeResolutionError extends Error {
  constructor(
    message: string,
    public readonly compositePack: string,
    public readonly cause?: string,
  ) {
    super(message);
    this.name = 'CompositeResolutionError';
  }
}

interface ResolutionState {
  visited: Set<string>;
  depth: number;
  rootComposite: string;
}

/**
 * Expand composite packs into their includes. Returns the flat list per the
 * module-header contract. Throws `CompositeResolutionError` on cycle,
 * depth-exceeded, missing include, semver-mismatch, or invalid-semver.
 */
export function expandComposites(packs: readonly Pack[]): Pack[] {
  const registry = new Map<string, Pack>();
  for (const p of packs) registry.set(p.name, p);

  const out: Pack[] = [];
  const seen = new Set<string>();

  for (const pack of packs) {
    const kind = pack.kind ?? 'focused';
    if (kind === 'composite') {
      if (!seen.has(pack.name)) {
        out.push(pack);
        seen.add(pack.name);
      }
      const state: ResolutionState = {
        visited: new Set([pack.name]),
        depth: 0,
        rootComposite: pack.name,
      };
      walkIncludes(pack, registry, state, out, seen);
    } else {
      if (!seen.has(pack.name)) {
        out.push(pack);
        seen.add(pack.name);
      }
    }
  }
  return out;
}

function walkIncludes(
  composite: Pack,
  registry: Map<string, Pack>,
  state: ResolutionState,
  out: Pack[],
  seen: Set<string>,
): void {
  if (state.depth >= MAX_COMPOSITE_DEPTH) {
    throw new CompositeResolutionError(
      `composite ${state.rootComposite}: include-expansion depth exceeded ${String(MAX_COMPOSITE_DEPTH)} levels (chain: ${[...state.visited].join(' → ')})`,
      state.rootComposite,
      'depth-exceeded',
    );
  }
  const includes = composite.includes ?? [];
  for (const inc of includes) {
    if (!isValidRange(inc.semver)) {
      throw new CompositeResolutionError(
        `composite ${composite.name}: include "${inc.pack_id}" has invalid semver range "${inc.semver}"`,
        composite.name,
        'invalid-semver',
      );
    }
    const found = registry.get(inc.pack_id);
    if (found === undefined) {
      throw new CompositeResolutionError(
        `composite ${composite.name}: include "${inc.pack_id}@${inc.semver}" — no pack with that name in the registry (registry has ${String(registry.size)} packs)`,
        composite.name,
        'missing-include',
      );
    }
    if (!semverSatisfies(found.version, inc.semver)) {
      throw new CompositeResolutionError(
        `composite ${composite.name}: include "${inc.pack_id}@${inc.semver}" — registry has version ${found.version} which does NOT satisfy range`,
        composite.name,
        'semver-mismatch',
      );
    }
    if (state.visited.has(found.name)) {
      throw new CompositeResolutionError(
        `composite ${state.rootComposite}: include cycle detected (chain: ${[...state.visited].join(' → ')} → ${found.name})`,
        state.rootComposite,
        'cycle',
      );
    }
    if (!seen.has(found.name)) {
      out.push(found);
      seen.add(found.name);
    }
    if ((found.kind ?? 'focused') === 'composite') {
      walkIncludes(
        found,
        registry,
        {
          visited: new Set([...state.visited, found.name]),
          depth: state.depth + 1,
          rootComposite: state.rootComposite,
        },
        out,
        seen,
      );
    }
  }
}

/**
 * semver.valid accepts only pinned versions ('1.0.0'); semver.validRange
 * returns the parsed range string or null. We accept anything either lib
 * recognizes. semver.satisfies tolerates malformed input by returning false
 * (not throwing) so isValidRange must NOT rely on satisfies' throw behavior.
 */
function isValidRange(s: string): boolean {
  if (semverValid(s) !== null) return true;
  return semverValidRange(s) !== null;
}
