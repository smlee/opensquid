/**
 * T-AUTO-HANDOFF AHO.4 — the ONE substance predicate both handoff writers
 * consume (the SessionEnd backup and the SessionStart tier-3 lazy generator).
 *
 * A handoff is worth generating iff the dump would contain at least one
 * RESUMABLE item: an active task, an FSM beyond bare `scoping`, or a recorded
 * pre-research artifact. Bare `scoping` with no task and no artifact renders
 * the zero-information resume ("start the track at SCOPE") — the junk class
 * two cleanups chased: scope-intent-matching prompts (every audit
 * subprocess, codex coding probes) mint an FSM at scoping, and AHO.3's
 * FSM-exists check passed for them while SessionEnd's own clearFsmState
 * erased the evidence afterwards. Total over all trivial sessions whatever
 * spawned them.
 *
 * Imports from: node:fs/promises, ../paths.js, ../session_state.js.
 * Imported by: ../hooks/session-end.ts, ../../functions/handoff_session_start.ts.
 */

import { readFile } from 'node:fs/promises';

import { sessionStateFile } from '../paths.js';
import { readActiveTask } from '../session_state.js';
import { readCheckpointBySession } from '../ralph/loop_stage.js';

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function hasResumableState(sessionId: string): Promise<boolean> {
  if ((await readActiveTask(sessionId)) !== null) return true;
  // PACK-AGNOSTIC resume signal: a bound task checkpoint past `scope` OR carrying a recorded scope artifact.
  // Reads the durable checkpoint (keyed by wg id) so a v2 (fullstack-flow) session is recognized — the
  // pack-named session keys below are v1 (coding-flow) only and are invisible for v2 (the key-drift bug).
  const cp = await readCheckpointBySession(sessionId).catch(() => null);
  if (
    cp !== null &&
    (cp.scopeArtifacts.length > 0 || (cp.stage !== 'scope' && cp.stage !== 'scoping'))
  ) {
    return true;
  }
  try {
    const fsm = (await readJson(sessionStateFile(sessionId, 'fsm-coding-flow'))) as {
      state?: unknown;
    };
    if (typeof fsm.state === 'string' && fsm.state !== 'scoping') return true;
  } catch {
    /* no FSM → fall through */
  }
  try {
    // The key stores a bare JSON string (write_state, scope-lifecycle:64) —
    // present the moment a pre-research artifact lands, so a genuine
    // cap-hit-at-SCOPE session keeps its handoff.
    const p = await readJson(sessionStateFile(sessionId, 'coding-flow-pre-research-path'));
    if (typeof p === 'string' && p.length > 0) return true;
  } catch {
    /* no artifact */
  }
  return false;
}
