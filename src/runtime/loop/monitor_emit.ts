/**
 * LMP.2 — the consumer-agnostic, FAIL-OPEN emit primitive at the state-mutation choke-points.
 *
 * Every state change PUSHES one {@link MonitorEvent} the instant it happens, through THIS one primitive — the
 * write path knows NOTHING about who consumes it (modularity §6.1), and an emit fault NEVER breaks the mutation
 * that called it (a stage advance / phase write / close / park is load-bearing and must survive a monitor-store
 * fault — the exact fail-open posture at loop_stage.ts:132-140).
 *
 * The store append (`appendMonitorEvent`, LMP.1) is deliberately fail-CLOSED so it stays testable; THIS wrapper
 * is the fail-open layer the mutations call. A choke-point calls `emitMonitorEvent`, never `appendMonitorEvent`
 * directly.
 *
 * Imports from: ./loop_events.js.
 * Imported by: ./loop_stage.ts (stage_advance), src/mcp/tools/set_loop_phase.ts (phase enter/leave),
 *   src/runtime/ralph/orchestrator.ts (item_shipped / item_closed / item_wedged).
 */
import { appendMonitorEvent, type NewMonitorEvent } from './loop_events.js';

/** Push one monitor event; a store fault is swallowed (logged to stderr) and NEVER propagates to the mutation. */
export async function emitMonitorEvent(ev: NewMonitorEvent): Promise<void> {
  try {
    await appendMonitorEvent(ev);
  } catch (err) {
    process.stderr.write(`[monitor] emit failed (ignored): ${String(err)}\n`);
  }
}
