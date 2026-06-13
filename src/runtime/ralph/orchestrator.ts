/**
 * GR.4 — the gated-ralph orchestrator: a thin, non-LLM loop that composes GR.1–3.
 *
 * One pass: read the oldest ready item (GR.1 `listReady`) → atomically claim it (GR.1 CAS) → run a
 * supervised lap (GR.3 `superviseLap` over an injected lap-runner that wraps `claude -p RALPH.md` +
 * GR.2 `parseLapOutcome`) → act on the typed `LapOutcome` (GR.2) → repeat until BOARD_EMPTY or a
 * stopping escalation. No new state store (claim/wedge are work-graph ops); no new gate logic (the lap
 * is gated by the same coding-flow); ONE uniform escalation (GR.3 `escalateLap`).
 *
 * Dependencies are INJECTED (`RalphDeps`) so the loop is pure composition and unit-testable without the
 * notification stack or a real `claude` subprocess — the CLI (`ralph.ts`) wires the real store, the
 * `claude -p` lap-runner, and `escalateSeverity`.
 *
 * The S1 spike PROVED spawn-a-lap is safe (a nested `--dangerously-skip-permissions` lap's ungated
 * commit was blocked by the gate), so this loop spawns laps directly rather than via Alternative F.
 */
import type { Issue, WorkGraphStore, ClaimAudience } from '../../workgraph/types.js';
import type { HumanRequiredReason } from './lap_outcome.js';
import type { LapResult, SuperviseOpts } from './supervisor.js';
import { superviseLap } from './supervisor.js';
import { escalateLap, type LapEscalator } from './escalate_lap.js';
import type { DecisionVerdict } from './decision_classifier.js';

export interface RalphConfig {
  /** Auth mode from CONFIG (Inv 11; no runtime auto-detect). API → dollar budget; subscription → W. */
  authMode: 'api' | 'subscription';
  /** API dollar bound — the running sum of the verified `total_cost_usd` (Inv 11). API mode only. */
  maxBudgetUsd: number;
  /** TTL for the per-item claim (GR.1). */
  claimTtlSec: number;
  /** Stop after one item (the `--once` flag). */
  once: boolean;
  /** GR.3 supervisor opts (retry cap, backoff, heartbeat). */
  supervise: SuperviseOpts;
}

/** Why the loop stopped. NB: the per-item residual reasons (IRREVERSIBLE_BOUNDARY / SCOPE_FORK /
 * UNRECOVERABLE_WEDGE) never STOP the loop — they park the item and the loop takes the next. Only the
 * RESOURCE pauses + an explicit `--once` end the run. */
export type RalphStop = 'BOARD_EMPTY' | 'BUDGET' | 'RATE_BUDGET' | 'once';

export interface RalphResult {
  stopped: RalphStop;
  spent: number; // running sum of lap costUsd (meaningful in API mode)
  closed: string[]; // item ids closed (SHIPPED)
  parked: { id: string; reason: HumanRequiredReason }[]; // items parked + escalated (residual)
}

export interface RalphDeps {
  wg: WorkGraphStore;
  /** Env-derived claim audience (GR.1 — never caller input). */
  claimAudience: () => ClaimAudience;
  /** Run ONE lap for an item → its typed outcome + cost. The CLI wraps `claude -p RALPH.md` + parseLapOutcome. */
  runLap: (item: Issue) => Promise<LapResult>;
  /** The undroppable escalation transport (GR.3) — the CLI wires `escalateSeverity`. */
  escalate: LapEscalator;
}

/** Resource pauses END the run; everything else is per-item decision-residual that parks + continues. */
const RESOURCE_PAUSES: readonly HumanRequiredReason[] = ['BUDGET', 'RATE_BUDGET', 'BOARD_EMPTY'];
const isResourcePause = (r: HumanRequiredReason): r is RalphStop & HumanRequiredReason =>
  (RESOURCE_PAUSES as readonly string[]).includes(r);

export async function runRalphLoop(cfg: RalphConfig, deps: RalphDeps): Promise<RalphResult> {
  const { wg } = deps;
  const closed: string[] = [];
  const parked: { id: string; reason: HumanRequiredReason }[] = [];
  let spent = 0;

  // THE single uniform stop-layer (Inv 5): every reason chat-escalates through ONE path — no per-trigger
  // code paths (rejects Alt D). Two SEPARATE, explicit decisions ride alongside it: (a) wedge-mark ONLY the
  // per-item residual (IRREVERSIBLE_BOUNDARY/SCOPE_FORK/UNRECOVERABLE_WEDGE) — a resource pause
  // (BUDGET/RATE_BUDGET/BOARD_EMPTY) is TRANSIENT, so the item stays in `ready` to retry after the
  // window/budget resets (wedge-marking it would PERMANENTLY park healthy work); (b) continue-vs-stop is
  // isResourcePause at the call sites.
  const parkAndEscalate = async (reason: HumanRequiredReason, item?: Issue): Promise<void> => {
    if (item !== undefined && !isResourcePause(reason)) {
      await wg.wedgeMark(item.id, reason); // a marked item SKIPS on re-attempt (residual only — GR.3)
      parked.push({ id: item.id, reason });
    }
    // GR.3 — undroppable. Omit `item` entirely when absent (exactOptionalPropertyTypes: no explicit undefined).
    await escalateLap(
      reason,
      item === undefined ? { escalate: deps.escalate } : { item: item.id, escalate: deps.escalate },
    );
  };

  for (;;) {
    const ready = await wg.listReady(); // GR.1 ordering, claim+wedge aware (live-claimed items excluded)
    if (ready.length === 0) {
      await parkAndEscalate('BOARD_EMPTY'); // resource pause → escalate + STOP
      return { stopped: 'BOARD_EMPTY', spent, closed, parked };
    }
    const item = ready[0]; // oldest-first (shipped listReady ORDER BY created_at; no priority column)
    if (item === undefined) continue; // unreachable (length checked) — narrows for strict indexing
    const { won } = await wg.claimIssue(item.id, deps.claimAudience(), cfg.claimTtlSec); // GR.1 atomic CAS
    if (!won) continue; // another runner/harness won it — it now carries a live claim, excluded next pass

    const outcome = await superviseLap(() => deps.runLap(item), cfg.supervise); // GR.3 → LapResult
    spent += outcome.costUsd; // GR.3 propagates costUsd across retries

    if (outcome.kind === 'SHIPPED') {
      await wg.updateIssue(item.id, { status: 'closed' });
      closed.push(item.id);
    } else {
      // Non-SHIPPED → the ONE uniform path. HUMAN_REQUIRED carries its reason; WEDGE (and the
      // post-supervision CRASH/TIMEOUT the type allows but superviseLap never returns — it exhausts
      // them to HUMAN_REQUIRED{UNRECOVERABLE_WEDGE}) map to UNRECOVERABLE_WEDGE.
      const reason: HumanRequiredReason =
        outcome.kind === 'HUMAN_REQUIRED' ? outcome.reason : 'UNRECOVERABLE_WEDGE';
      await parkAndEscalate(reason, item);
      if (isResourcePause(reason)) return { stopped: reason, spent, closed, parked }; // e.g. lap-emitted RATE_BUDGET
      // else (IRREVERSIBLE_BOUNDARY / SCOPE_FORK / UNRECOVERABLE_WEDGE): parked, take the next item
    }

    if (cfg.authMode === 'api' && spent > cfg.maxBudgetUsd) {
      await parkAndEscalate('BUDGET'); // Inv 11 API bound (verified total_cost_usd) → resource pause → STOP
      return { stopped: 'BUDGET', spent, closed, parked };
    }
    if (cfg.once) return { stopped: 'once', spent, closed, parked };
  }
}

/** GR.2's recordMisclassification, injected (kept testable / decoupled). */
export type RecordMisclassification = (
  sessionId: string,
  expected: DecisionVerdict,
  got: DecisionVerdict,
  decision: string,
  nowIso: string,
) => Promise<void>;

/**
 * `opensquid loop resolve <itemId> --misclassified` — the human-override INPUT (post-hoc residual-shrink
 * path; NOT the hot loop). The human marks a parked escalation as principle-settleable: we record the
 * misclassification (the heuristic said ESCALATE, the correct verdict was DECIDE) and un-wedge the item so
 * it re-enters `ready` for another lap. The SOLE caller of GR.2's recordMisclassification.
 */
export async function resolveParked(
  itemId: string,
  deps: {
    wg: WorkGraphStore;
    recordMisclassification: RecordMisclassification;
    sessionId: string;
    nowIso: string;
  },
): Promise<void> {
  const item = await deps.wg.getIssue(itemId);
  if (item?.wedgeReason === undefined)
    throw new Error(`resolveParked: not a parked item: ${itemId}`);
  await deps.recordMisclassification(deps.sessionId, 'DECIDE', 'ESCALATE', item.title, deps.nowIso);
  await deps.wg.clearWedge(itemId); // un-wedge → re-enters listReady
}
