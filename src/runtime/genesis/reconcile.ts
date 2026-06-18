/**
 * GR.1 — genesis reconcile: the TOTAL function reconcile(persisted_world) → live_world.
 *
 * Genesis is a *run of this function*, not an imperative fall-through. Per actor:
 *   read → classify(new_start | resume | wedge) → validate? → entry
 * No actor reaches `system_ready` until classified. A crash (no graceful-shutdown
 * marker) puts the whole reconcile in `recovery` mode — the caller MUST get the
 * user's confirmation before applying any `resume` plan.
 *
 * Spec: loop/docs/tasks/T-fsm-actor-runtime.md §GR.1.
 * Design: loop/docs/opensquid-update-plan.html "Reconciling genesis".
 */

export type Classification = 'new_start' | 'resume' | 'wedge';
export type ActorId = string;

export interface EntryPlan {
  mode: Classification;
  /** resume: the persisted current state (possibly a hierarchical sub-flow path, e.g. `build/backend_api`). */
  state?: string;
  rebind?: { skills: string[]; executor?: string };
  /** wedge: why. */
  reason?: string;
}

export interface ReconcileDescriptor<S> {
  // Property function types (not method shorthand) — these are pure/injected fns, not `this`-bound methods.
  actor: ActorId;
  read: () => Promise<S | null>;
  classify: (p: S | null) => Classification; // null→new · valid non-terminal→resume · inconsistent→wedge
  /** CONNECTED packs only — never the universe. Presence of `validate` marks an actor as a pack. */
  validate?: (p: S) => { ok: true } | { ok: false; reason: string };
  entry: (c: Classification, p: S | null) => EntryPlan;
}

export interface GenesisClassifier {
  /** present → clean resume; null → crash → recovery (user-confirmed). */
  shutdownMarker: () => Promise<{ status: 'clean'; digest: string; ts: number } | null>;
}

export interface Failure {
  actor: ActorId;
  reason: string;
}

export type PackStatus = 'connected' | { disabled: string } | { wedged: string };

export interface StartupReport {
  packs: Record<string, PackStatus>; // binary: connected, or off-until-fixed
  actors: Record<ActorId, Classification>;
  failures: Failure[];
  remediation?: 'fix-all' | 'fix-some' | 'skip';
}

export interface ReconcileResult {
  plan: Record<ActorId, EntryPlan>;
  report: StartupReport;
  /** true ⇒ crash (no marker): the caller MUST user-confirm before applying any `resume` plan. */
  recovery: boolean;
}

export async function reconcile(
  descriptors: ReconcileDescriptor<unknown>[],
  classifier: GenesisClassifier,
): Promise<ReconcileResult> {
  const recovery = (await classifier.shutdownMarker()) === null; // crash ⇒ recovery mode
  const plan: Record<ActorId, EntryPlan> = {};
  const report: StartupReport = { packs: {}, actors: {}, failures: [] };

  for (const d of descriptors) {
    const p = await d.read();
    const c = d.classify(p);
    const isPack = Boolean(d.validate);

    if (isPack && p !== null && c !== 'new_start') {
      const v = d.validate!(p);
      if (!v.ok) {
        report.failures.push({ actor: d.actor, reason: v.reason });
        report.packs[d.actor] = { disabled: v.reason };
        report.actors[d.actor] = 'wedge';
        plan[d.actor] = { mode: 'wedge', reason: v.reason };
        continue;
      }
    }

    plan[d.actor] = d.entry(c, p);
    report.actors[d.actor] = c;
    if (isPack)
      report.packs[d.actor] = c === 'wedge' ? { wedged: 'classified inconsistent' } : 'connected';
  }

  return { plan, report, recovery };
}
