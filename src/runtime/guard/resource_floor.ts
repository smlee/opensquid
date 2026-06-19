/**
 * T2 — the Resource floor (T-fsm-actor-rescope §T2).
 *
 * The substrate's RESOURCE floor: a consumption budget over a single agent tool-loop. It is the
 * smallest possible EFSM — one counter — emitting the gate `Action` as the loop approaches and then
 * reaches its iteration cap. It replaces the raw `throw` the api-mode agent loop used on overflow
 * (`agent_loop.ts`) with a floor emission the caller can surface as a typed halt.
 *
 * IN-MEMORY by design: unlike the Progress floor (which persists via `floor_state.ts` because it spans
 * short-lived PostToolUse hook subprocesses), the Resource budget lives inside ONE `runAgentTurn` call
 * — a single process, no boundary to persist across — so there is no `resource_state.ts`.
 *
 * `cap` = `MAX_TOOL_ITERATIONS` (the reused constant — no new magic number). `warnOffset` is config-
 * driven (default 1 ⇒ warn on the single iteration immediately before the cap); there is no literal
 * `cap-2`. Resource emits only pass | warn | halt (the design's Resource action set), never block.
 */
import type { Action } from '../gate/kernel.js';

export type ResourceAction = Extract<Action, 'pass' | 'warn' | 'halt'>;

export interface ResourceConfig {
  /** the hard cap = MAX_TOOL_ITERATIONS (reused; no new magic number). */
  cap: number;
  /** iterations before the cap at which `warn` first fires; config-driven, default 1 (⇒ warn at cap-1). */
  warnOffset: number;
}

export const DEFAULT_WARN_OFFSET = 1;

export class ResourceFloor {
  private count = 0;

  constructor(private readonly cfg: ResourceConfig) {}

  /** Observe one tool-loop iteration; returns the floor Action (halt AT the cap, warn approaching it). */
  observe(): ResourceAction {
    this.count += 1;
    if (this.count >= this.cfg.cap) return 'halt';
    if (this.count >= this.cfg.cap - this.cfg.warnOffset) return 'warn';
    return 'pass';
  }

  /** The iterations observed so far (for the halt reason / tests). */
  count_(): number {
    return this.count;
  }
}
