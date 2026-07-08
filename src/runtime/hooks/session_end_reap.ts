/**
 * WGL.4 — the SESSION-END reaper seam (docs/tasks/T-workgraph-lifecycle.md, §6.4 "both, not one").
 *
 * Mirrors `session_end_retention.ts`'s injectable + fail-open shape, but WITHOUT its destructive gate: the
 * retention sweep hard-deletes (irreversible → gated on a complete cycle + clean tree), whereas the reaper
 * ARCHIVES (soft, reversible, non-destructive), so it runs UNCONDITIONALLY per §6.4. Fail-open is the CALLER's
 * try/catch (session-end); this returns the reaped ids or [] and never itself blocks teardown.
 *
 * INJECTABLE (`deps.reap`): tests pass a spy; the default binds the shipped `reapOrphans`.
 * Imports from: ../loop/reaper.js, ../../workgraph/types.js. Imported by: session-end.ts + session_end_reap.test.ts.
 */
import { reapOrphans } from '../loop/reaper.js';

import type { WorkGraphFacade } from '../../workgraph/types.js';

/** Injectable seam — tests stub the reaper; the default binds the shipped `reapOrphans`. */
export interface ReapGateDeps {
  reap?: (wg: WorkGraphFacade) => Promise<string[]>;
}

/**
 * Reap orphaned stubs at session-end (like the memory prune). No destructive-gate needed — archive is
 * reversible + non-destructive (unlike the 30-day hard-delete sweep), so it runs unconditionally per §6.4.
 * `cwd` is accepted to mirror `sweepRetiredIfAllowed`'s signature (the caller passes it) but is not gated on.
 */
export async function reapOrphansIfAllowed(
  wg: WorkGraphFacade,
  _cwd: string,
  deps: ReapGateDeps = {},
): Promise<string[]> {
  return (deps.reap ?? reapOrphans)(wg);
}
