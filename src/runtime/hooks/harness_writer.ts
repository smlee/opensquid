/**
 * #26 HWS.4 — the abstracted OUTBOUND seam + the default CC advisory-nudge writer.
 *
 * The wg → harness delta-set ({@link OutboundDelta}, computed by `reconcileHarnessWorkgraph`) is applied
 * through a consumer-agnostic {@link HarnessWriter} — the outbound SIBLING of the shipped inbound injected
 * seams (`WgSyncFacade` / `HarnessMapReaderWriter` in `harness_sync.ts`). INJECTED, so the reconcile core
 * never depends on a concrete harness; a write-capable harness plugs a real writer in without touching the
 * core (CLOSED decision 1).
 *
 * The DEFAULT {@link ccNudgeWriter} is for Claude Code, which is AGENT-EXECUTED: the transcript is read-only
 * and the Task tools are agent-only, so a hook-side silent write is impossible. The ONLY honest outbound is an
 * advisory nudge on `additionalContext` (`pre-tool-use.ts`) telling the agent to make the Task call itself
 * (decision 1). It GENERALIZES the shipped stale-closed-only `buildInstruction` (formerly in
 * `harness_graph_sync.ts`) to all three delta kinds — the `close` rendering is byte-for-byte the shipped nudge
 * (no user-visible regression). A real non-CC adapter (Codex / external kanban) is explicitly OUT (decision 7);
 * the seam is the hedge, not a second shipped writer.
 *
 * Imports from: ../../workgraph/harness_sync.js (OutboundDelta, type-only).
 * Imported by: src/runtime/hooks/harness_graph_sync.ts, src/runtime/ralph/orchestrator.ts (via CLI wiring),
 *   src/runtime/hooks/harness_writer.test.ts.
 */
import type { OutboundDelta } from '../../workgraph/harness_sync.js';

/**
 * The abstracted OUTBOUND surface: apply the wg → harness delta-set, returning the advisory-context string to
 * inject (or `null` when there is nothing to say). Injected so the core never depends on a concrete harness —
 * a write-capable harness plugs a real writer here without touching the reconciler (decision 1). CC's default
 * only NUDGES (it cannot write); a different adapter could perform a real write and return `null`.
 */
export interface HarnessWriter {
  apply(deltas: OutboundDelta[]): Promise<string | null>;
}

/**
 * The shipped stale-closed nudge (formerly `buildInstruction` in `harness_graph_sync.ts`), verbatim — the
 * single line telling the agent to `TaskUpdate("<id>", "completed")` for wg issues that closed ahead of their
 * still-open harness tasks. Kept byte-for-byte so the generalized writer never regresses the live message.
 */
export function buildStaleClosedNudge(harnessIds: string[]): string | null {
  if (harnessIds.length === 0) return null;
  const list = harnessIds.map((id) => `#${id}`).join(', ');
  const plural = harnessIds.length > 1;
  return (
    `🦑 [workgraph sync] ${plural ? 'Tasks' : 'Task'} ${list} ${plural ? 'are' : 'is'} closed in the ` +
    `work-graph but still open in your task list — call TaskUpdate("<id>", "completed") ` +
    `${plural ? 'for each' : ''} to reconcile.`
  ).trim();
}

/**
 * The DEFAULT CC writer — GENERALIZES the stale-closed-only nudge to create + status + close. It WRITES
 * NOTHING (CC transcript read-only, Task tools agent-only, decision 1); the returned string rides
 * `additionalContext` as an agent-executed nudge. `close` and `status` (a bound task whose wg went terminal)
 * share the SAME "mark it completed" nudge — rendered via {@link buildStaleClosedNudge}, byte-for-byte the
 * shipped message. `create` (a wg issue with no bound task) renders a `TaskCreate` nudge.
 */
export const ccNudgeWriter: HarnessWriter = {
  // NOT `async` (it does no I/O — CC's nudge is a pure render): a non-async method returning `Promise.resolve`
  // satisfies the `Promise<string | null>` contract without tripping `require-await` (repo idiom, e.g.
  // `secrets/backends/literal.ts`). A write-capable harness's writer WOULD be async (it performs the write).
  apply(deltas) {
    if (deltas.length === 0) return Promise.resolve(null);
    // close + status:'closed' both mean "the work-graph is done — mark the task completed" → the shipped nudge.
    const completeIds: string[] = [];
    const createLines: string[] = [];
    for (const d of deltas) {
      if (d.kind === 'create') {
        createLines.push(
          `🦑 [workgraph sync] the work-graph opened ${d.wgId} ("${d.title}") — ` +
            `call TaskCreate(...) to mirror it in your task list.`,
        );
      } else {
        completeIds.push(d.harnessId);
      }
    }
    const lines: string[] = [];
    const completeNudge = buildStaleClosedNudge(completeIds);
    if (completeNudge !== null) lines.push(completeNudge);
    lines.push(...createLines);
    return Promise.resolve(lines.length === 0 ? null : lines.join('\n'));
  },
};
