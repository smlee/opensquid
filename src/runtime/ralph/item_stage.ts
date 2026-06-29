/**
 * T-v2-per-stage-loop PSL.1 — the DURABLE per-item loop stage (orchestration runtime state).
 *
 * The per-stage subprocess loop (PSL.3) primes each lap for the item's CURRENT stage. To prime correctly on a
 * FRESH item it uses the pack's initial stage; to prime correctly on a RESUMED item (the loop stopped mid-item —
 * BUDGET/RATE_BUDGET/crash — and re-picked it after the claim-TTL) it must know where the item left off. The
 * per-task FSM is keyed by sessionId (v2_supply.ts), so the orchestrator (a different process from the lap, with
 * a different session) cannot reliably read it cross-session. Instead the loop persists the item's stage HERE,
 * keyed by item id under OPENSQUID_HOME — session-independent + survives a loop restart.
 *
 * This is ORCHESTRATION runtime state (where the loop is in driving the item), deliberately NOT a field on the
 * event-sourced work-graph issue: the work-graph op-log records work-item DOMAIN facts (title/body/status/edges),
 * and a transient loop position does not warrant op-log provenance/sync. Keeping it in a sidecar avoids
 * perturbing the event-sourced graph.
 *
 * Imports from: node:fs/promises, node:path, ../paths.js, ../../storage/atomic_file.js.
 * Imported by: src/runtime/ralph/orchestrator.ts (the per-stage loop), src/setup/cli/ralph.ts (wiring).
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { atomicWriteFile, safeRecordId } from '../../storage/atomic_file.js';
import { OPENSQUID_HOME } from '../paths.js';

/** The sidecar file for an item's durable loop stage. `safeRecordId` keeps an arbitrary item id filesystem-safe. */
function itemStagePath(itemId: string): string {
  return join(OPENSQUID_HOME(), 'loop-item-stage', `${safeRecordId(itemId)}.json`);
}

/** The item's last-recorded loop stage, or null when none (a fresh item → the caller seeds the pack initial). */
export async function readItemStage(itemId: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(itemStagePath(itemId), 'utf8')) as { stage?: unknown };
    return typeof parsed.stage === 'string' && parsed.stage.length > 0 ? parsed.stage : null;
  } catch {
    return null; // ENOENT / malformed → no recorded stage
  }
}

/** Record the item's current loop stage (written from each lap's reported resulting stage). */
export async function writeItemStage(itemId: string, stage: string): Promise<void> {
  const path = itemStagePath(itemId);
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, JSON.stringify({ stage }));
}

/** Drop the sidecar once the item leaves the loop (closed/SHIPPED) so a future id reuse starts clean. Best-effort. */
export async function clearItemStage(itemId: string): Promise<void> {
  try {
    await rm(itemStagePath(itemId), { force: true });
  } catch {
    /* best-effort: a stale sidecar is harmless (re-read seeds the pack initial / the next lap report corrects it) */
  }
}
