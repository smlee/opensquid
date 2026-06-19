/**
 * T3c — the genesis boot caller (T-fsm-actor-rescope §T3c).
 *
 * `reconcile()` (GR.1) is a total `reconcile(persisted_world) → live_world`, but nothing CALLED it — so the
 * design's "genesis resolves three registries (workspace × topology × agent) before `system_ready`" invariant
 * was unenforced. This wires it: `buildGenesisWorld` POPULATES the three `ReconcileDescriptor`s from the real
 * world-state (projects WHERE, the live `Topology` WHAT, the seeded `AgentRegistry` WHO); `runGenesis` runs the
 * total `reconcile` with the shutdown-marker classifier (clean resume vs crash recovery). The daemon host awaits
 * `runGenesis` BEFORE `advance('ready')`, so the host never reaches `running` until the three registries resolve.
 *
 * Crash handling is NOT re-implemented here — `reconcile` already downgrades resume→wedge on a missing marker.
 */
import { reconcile, type ReconcileDescriptor, type ReconcileResult } from './reconcile.js';
import { markerClassifier } from './shutdown_marker.js';
import type { AgentRegistry } from '../registry/agent_registry.js';

export interface GenesisWorld {
  workspace: ReconcileDescriptor<unknown>; // WHERE: projects
  topology: ReconcileDescriptor<unknown>; // WHAT: connected packs / execution-FSMs
  agent: ReconcileDescriptor<unknown>; // WHO: the seeded AgentRegistry
}

/** null/empty persisted state → new_start; any non-empty → resume. (Inconsistent→wedge is each reader's call.) */
function classifyPresence(p: unknown): 'new_start' | 'resume' {
  if (p === null || p === undefined) return 'new_start';
  if (Array.isArray(p) && p.length === 0) return 'new_start';
  return 'resume';
}

export interface GenesisInputs {
  /** read the persisted workspace state (projects) — a thunk so boot stays decoupled from the projects format. */
  readProjects: () => Promise<unknown>;
  /** the live connected-actor set (`Topology.connected()`). */
  topologyConnected: () => unknown;
  /** the seeded WHO registry (T3a). */
  agents: AgentRegistry;
}

/** Build the THREE descriptors from the real world-state (POPULATES genesis — not a pre-built world). */
export function buildGenesisWorld(inputs: GenesisInputs): GenesisWorld {
  return {
    workspace: {
      actor: 'workspace',
      read: () => inputs.readProjects(),
      classify: classifyPresence,
      entry: (c) => ({ mode: c }),
    },
    topology: {
      actor: 'topology',
      read: () => Promise.resolve(inputs.topologyConnected()),
      classify: classifyPresence,
      entry: (c) => ({ mode: c }),
    },
    agent: {
      actor: 'agent',
      read: () => Promise.resolve(inputs.agents.snapshot()),
      classify: classifyPresence,
      entry: (c) => ({ mode: c }),
    },
  };
}

/**
 * Resolve workspace × topology × agent via the total `reconcile`; the caller gates `system_ready` on this.
 * `home` keys the shutdown-marker classifier — pass the HOST's home so clean-resume vs crash-recovery is read
 * from the same dir the host writes its marker to (defaults to `OPENSQUID_HOME()`).
 */
export async function runGenesis(world: GenesisWorld, home?: string): Promise<ReconcileResult> {
  return reconcile([world.workspace, world.topology, world.agent], markerClassifier(home));
}
