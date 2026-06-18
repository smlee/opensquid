/**
 * SKILL.1 — state-keyed skill injection (T-fsm-actor-runtime §SKILL.1).
 *
 * The FSM state IS the router. On entry to state S, bind EXACTLY `skills(S)` and
 * `executor(S)` (from `CompiledPack.meta`); on leave, unload. This replaces the
 * relevance-GUESSING router/prefilter (embedder/classifier picking "relevant"
 * skills) and the `unload_when`/skill-tick lifecycle with deterministic, exact,
 * per-state binding — minimal context (the efficiency half of the mission) and no
 * cross-state bleed.
 *
 * Pure injection logic over an injected `SkillRuntime` (the host applies the actual
 * load/unload). The eventual deletion of `skill_router.ts` + `skill_prefilter.ts`
 * is the V1→V2 cutover step (they are still imported by the live V1 dispatch path;
 * removing them before the FSM runtime is the live router would break the running
 * gate) — this module is the additive replacement that makes that deletion safe.
 */
import type { StateMeta } from '../../packs/compile_v2.js';

/** The host's skill-binding surface (load/unload skills + bind the executor). */
export interface SkillRuntime {
  /** bind EXACTLY these skills for the current state (replacing whatever was bound). */
  bindSkills(skills: string[]): void;
  /** bind the executor for the current state (executor-state only). */
  bindExecutor(executor: string): void;
  /** unload all state-bound skills (called on leave; exact, not additive). */
  unloadSkills(): void;
}

/**
 * On entry to `state`: bind exactly `skills(S)` + `executor(S)` from the compiled meta.
 * Deterministic — the state IS the router, no prefilter/classifier guess. A state with no
 * skills binds the empty set (NOT a fallback to "all skills"), keeping context minimal.
 */
export function onStateEntry(
  state: string,
  meta: Record<string, StateMeta>,
  runtime: SkillRuntime,
): void {
  const m = meta[state];
  if (m === undefined) throw new Error(`SKILL.1: no meta for state '${state}'`); // total: unknown state is a bug
  runtime.bindSkills(m.skills); // exact, deterministic bind (m.skills is [] for non-executor kinds)
  if (m.executor !== undefined) runtime.bindExecutor(m.executor);
}

/** On leave: unload the state-bound skills (exact — the next entry rebinds from scratch). */
export function onStateLeave(_state: string, runtime: SkillRuntime): void {
  runtime.unloadSkills();
}

/**
 * A minimal in-memory `SkillRuntime` — the deterministic binding semantics (exact, not
 * additive across states). The production host wires the real loader; this is the reference
 * the tests pin and a lightweight default.
 */
export class InMemorySkillRuntime implements SkillRuntime {
  private bound: string[] = [];
  private executor: string | null = null;

  bindSkills(skills: string[]): void {
    this.bound = [...skills]; // replace (exact), never append — no cross-state accumulation
  }
  bindExecutor(executor: string): void {
    this.executor = executor;
  }
  unloadSkills(): void {
    this.bound = [];
    this.executor = null;
  }
  /** Inspect the currently-bound set (observability / tests). */
  current(): { skills: string[]; executor: string | null } {
    return { skills: [...this.bound], executor: this.executor };
  }
}
