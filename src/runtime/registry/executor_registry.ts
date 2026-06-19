/**
 * T3b — the concrete, fail-closed `ExecutorRegistry` (T-fsm-actor-rescope §T3b).
 *
 * `src/runtime/loop/driver.ts` declares `interface ExecutorRegistry { ensureExecutor(name) → Executor }` with a
 * FAIL-CLOSED contract ("THROW if it can't be connected — never wrong-fallback"), and the LoopDriver consumes it,
 * but no production implementation existed. This is it, backed by the agent registry (T3a): `ensureExecutor(name)`
 * resolves the live agent providing `name`, returns the executor its registered FACTORY produces, or THROWS.
 *
 * A FACTORY is how an agent supplies its connection at `register()` time (keyed by agent id). A disk-discovered
 * STUB (id+liveness, no factory) is NOT connectable → excluded → throw. The live step-execution adapter that
 * bridges the agent_bridge turn-runner to the LoopDriver step-puller is the FSM-actor cutover; T3b returns the
 * registered factory's executor — the model-built-now / cutover-later seam.
 */
import type { Executor, ExecutorRegistry } from '../loop/driver.js';
import type { AgentRegistry } from './agent_registry.js';

export class RegistryBackedExecutors implements ExecutorRegistry {
  constructor(
    private readonly agents: AgentRegistry,
    /** agent id → its executor factory, supplied by the agent at register() time. */
    private readonly factories: Map<string, () => Executor>,
    /** this host's own id — preferred on a tie when several agents provide the same backend. */
    private readonly selfId: string,
  ) {}

  async ensureExecutor(name: string): Promise<Executor> {
    const live = await this.agents.resolve(name, this.selfId); // lease-fresh, self-first then most-recent
    const chosen = live.find((e) => this.factories.has(e.id)); // first WITH a registered factory (stubs excluded)
    const factory = chosen ? this.factories.get(chosen.id) : undefined;
    if (factory === undefined) {
      // FAIL-CLOSED: no connected executor for this backend — the LoopDriver turns this throw into the correct
      // failure (never a wrong-fallback executor).
      throw new Error(`ExecutorRegistry: no connected executor for '${name}' (fail-closed)`);
    }
    return factory();
  }
}
