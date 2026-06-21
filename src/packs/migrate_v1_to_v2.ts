/**
 * M.2 — migrate a v1 `Pack` (flat skills + rules + side-file fsm/foundation) to a v2 `PackV2`,
 * BY FORM and fail-loud. A v1 pack migrates as one of two forms:
 *
 *   behavior   → a lifecycle FSM (states + transitions + emits). The FSM is NOT derivable from the
 *                flat skills — it comes from the v1 `fsm.yaml` side-file, supplied as `table.fsm`.
 *   foundation → pure expertise: the v1 `foundation` block passes through; neither fsm nor gates.
 *
 * CONFORMANCE-RECONCILE: there is NO `conformance` form. v2 has no fsm-less gate list — conformance
 * lives IN the execution FSM as gate-STATES (a gate on a transition). A v1 discipline rule-pack
 * therefore migrates as a `behavior` FSM whose checks are gate-states (authored per-pack, FAC-CUT.3),
 * not auto-flattened into a rule list. The migration RE-SHAPES the schema only — it adds NO logic.
 *
 * Spec: loop/docs/tasks/T-conformance-reconcile.md (+ T-pack-migrate-v2.md §M.2).
 */
import type { Transition } from '../runtime/fsm.js';
import type { Pack } from '../runtime/types.js';
import { PackV2, type StateV2 } from './schemas/pack_v2.js';

/** The EXPLICIT per-pack migration plan — never inferred. `form` selects the shape; a behavior pack
 *  carries the FSM (from the v1 `fsm.yaml` side-file). CONFORMANCE-RECONCILE: there is no `conformance`
 *  form — v2 has no fsm-less gate list; discipline packs migrate as behavior FSMs with gate-STATES. */
export interface MigrationTable {
  form: 'behavior' | 'foundation';
  fsm?: { initial: string; states: Record<string, StateV2>; transitions: Transition[] };
}

/** Migrate a v1 `Pack` to a `PackV2` by FORM. Returns a parsed (validated, defaults-applied) PackV2 —
 *  so a malformed migration fails LOUD at the schema boundary. CONFORMANCE-RECONCILE: the v1 rule-LIST
 *  `conformance` form is GONE (v2 has no fsm-less gate list); a v1 discipline pack migrates as a behavior
 *  FSM whose conformance checks are gate-STATES (authored per-pack, FAC-CUT.3). */
export function migrateV1(v1: Pack, table: MigrationTable): PackV2 {
  const base = { name: v1.name, version: v1.version, scope: v1.scope };
  switch (table.form) {
    case 'foundation':
      return PackV2.parse({
        ...base,
        ...(v1.foundation !== undefined ? { foundation: v1.foundation } : {}),
      });
    case 'behavior': {
      if (table.fsm === undefined) {
        // a behavior FSM is NOT derivable from the flat skills — it must be supplied (never synthesize).
        throw new Error(`migrateV1: behavior pack '${v1.name}' needs table.fsm`);
      }
      return PackV2.parse({ ...base, fsm: table.fsm });
    }
  }
}
