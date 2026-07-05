/**
 * The "block-on-unresolved" enforcement facet — the stage-exit gate half of the reporting model
 * (design: loop/docs/design/opensquid-reporting-model.md §7.3 + §6).
 *
 * A before-stage report commits a checklist — its parent-child workgraph sub-issues. At the stage-exit
 * gate, that committed checklist must be RESOLVED: every item either closed, or explicitly deferred with a
 * reason. Whether the checklist is fully resolved is computed elsewhere (`resolveChecklist` in
 * report_checklist.ts) and passed IN as `allResolved` — this module stays PURE and does NOT import it.
 *
 * This is a GATE FACET, modeled on readiness.ts: it is one predicate the FSM stage-exit gate ANDs into its
 * decision. Two disciplines it holds to:
 *
 *   - It NEVER denies a tool. A facet only advances/holds a gate; it never blocks a write or a tool call.
 *     The checklist stays authorable while the gate holds — the hold is on STAGE ADVANCE, not on work.
 *
 *   - It is AUTOMATION-GATED. Enforcement is active only under automation (`OPENSQUID_AUTOMATION === '1'`).
 *     Interactively (unset / any other value) the facet WARNS but never blocks: a human is present to judge
 *     an unresolved item, so `reportResolved` returns TRUE regardless of `allResolved`. Only in automation —
 *     where no human is watching — does an unresolved committed item HOLD the gate.
 *
 * So the facet returns TRUE (gate may pass) when either enforcement is off (interactive is never blocked) OR
 * the committed checklist is fully resolved; it returns FALSE (gate HOLDS) ONLY when automation is enforcing
 * AND a committed item is still unresolved.
 */

/** Is automation enforcement active? True only when `OPENSQUID_AUTOMATION === '1'`. */
export function automationEnforcing(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENSQUID_AUTOMATION === '1';
}

/**
 * The stage-exit gate facet. `allResolved` = every committed before-checklist item is resolved (closed or
 * deferred-with-reason), as computed by `resolveChecklist` (report_checklist.ts) and passed in.
 *
 * Returns TRUE (gate may pass) when NOT enforcing (interactive => never block) OR when `allResolved`.
 * Returns FALSE (gate HOLDS) only when enforcing AND there is an unresolved committed item.
 */
export function reportResolved(
  allResolved: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !automationEnforcing(env) || allResolved;
}
