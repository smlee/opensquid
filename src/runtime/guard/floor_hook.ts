/**
 * P0.3 — observe one live PostToolUse call against the persisted Progress floor
 * (T-fsm-actor-runtime §P0.3).
 *
 * Builds a `ToolObservation` from the PostToolUse payload (`tool`, `args`, `exit_code`), seeds a
 * `ProgressFloor` from the persisted counters, observes the call, persists the updated counters,
 * and returns the floor's `Action`. The two FAILURE patterns (exact_failure 2/5, same_tool 3/8)
 * fire from `exit_code !== 0` — the only payload-confirmed per-call signal (Bash; a tool that omits
 * `exit_code` defaults to 0 ⇒ not tracked, no false fire). `no_progress` is DEFERRED
 * (`idempotentSameResult: false`) until a follow-up cites the read-only-tool result-content payload.
 *
 * The post-tool-use hook surfaces a non-`pass` action on opensquid's existing drift-stderr channel.
 */
import { createHash } from 'node:crypto';

import type { Action } from '../gate/kernel.js';
import { loadFloorState, saveFloorState } from './floor_state.js';
import { ProgressFloor, type ToolObservation } from './progress_floor.js';

const hash = (v: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(v ?? null))
    .digest('hex')
    .slice(0, 16);

export interface ObservedCall {
  tool: string;
  args: unknown;
  exitCode: number;
}

/**
 * Observe one tool call against the session's persisted floor; returns the gate Action. Reloads +
 * persists each call (cross-process), so counters accumulate across short-lived hook subprocesses.
 */
export async function observeCall(session: string, call: ObservedCall): Promise<Action> {
  const floor = new ProgressFloor(await loadFloorState(session)); // seed from persisted counters
  const obs: ToolObservation = {
    tool: call.tool,
    argsHash: hash(call.args),
    failed: call.exitCode !== 0,
    idempotentSameResult: false, // no_progress deferred (unverified read-only result-content)
  };
  const action = floor.observe(obs);
  await saveFloorState(session, floor.snapshot());
  return action;
}

/** The agent-facing loop-break message for a non-`pass` floor action (surfaced on drift-stderr). */
export function floorMessage(action: Exclude<Action, 'pass'>, tool: string): string {
  switch (action) {
    case 'warn':
      return `Progress floor: '${tool}' is repeating a failing call — inspect the error and change strategy instead of retrying it unchanged.`;
    case 'block':
      return `Progress floor: '${tool}' failed the identical call repeatedly — STOP retrying it unchanged; change approach or explain the blocker.`;
    case 'halt':
      return `Progress floor: '${tool}' failed too many times this run — stop this tool path and choose a different approach.`;
  }
}
