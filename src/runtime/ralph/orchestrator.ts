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
import type { Issue, WorkGraphFacade, ClaimAudience } from '../../workgraph/types.js';
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
  wg: WorkGraphFacade;
  /** Env-derived claim audience (GR.1 — never caller input). */
  claimAudience: () => ClaimAudience;
  /**
   * Run ONE lap for an item → its typed outcome + cost. The CLI wraps `claude -p RALPH.md` + parseLapOutcome.
   * `stagePrompt` (T-v2-per-stage-loop PSL.3): when present, the per-stage bundle + directive prepended to the
   * lap's prompt so the lap completes ONLY that stage and reports its resulting `stage` in RALPH-EXIT. Absent →
   * the open-ended per-item lap (unchanged).
   */
  runLap: (item: Issue, stagePrompt?: string) => Promise<LapResult>;
  /** The undroppable escalation transport (GR.3) — the CLI wires `escalateSeverity`. */
  escalate: LapEscalator;
  /**
   * T2.9 loop-driver hook — called after a lap SHIPS a task (phases_complete). The CLI wires this to
   * `onPhasesComplete` (emit the CODE stage report + compute the next run-group via batchDecide). Optional +
   * fail-open: a report/grouping error must never break the drain loop.
   */
  onShipped?: (taskId: string) => Promise<void>;
  /**
   * T-v2-per-stage-loop PSL.3 — present ONLY for a stage-gated pack (fullstack-flow). When present, the
   * orchestrator drives each AUTOMATED stage as its OWN fresh-context lap (priming `stagePrompt` per stage,
   * advancing via the lap's reported resulting stage), then falls back to the open-ended per-item lap for the
   * deploy/accept HUMAN boundary (never-auto-ship). Absent → the open-ended per-item lap for the whole item
   * (unchanged — v1 coding-flow + any non-per-stage pack).
   */
  stageLoop?: {
    /** The pack's initial stage (seeded for a FRESH item when no durable stage is recorded). */
    initialStage: string;
    /** True while `stage` is an AUTOMATED stage the loop drives; false at the human boundary (deploy/accept/done). */
    isAutomated: (stage: string) => boolean;
    /** The per-stage prompt (bundle + 'do only this stage' directive) to prepend for `stage`. */
    stagePrompt: (item: Issue, stage: string) => Promise<string>;
    /** Read the item's durable loop stage (null → seed `initialStage`). */
    readStage: (itemId: string) => Promise<string | null>;
    /** Drop the item's durable stage once it leaves the loop (closed). */
    clearStage: (itemId: string) => Promise<void>;
    /**
     * GS1 — the SCOPE GATE (automation must NEVER scope). Before an item is claimed/driven, verify it is really
     * scoped: 'drive' → automation-eligible (checkpoint past the human `scope` stage WITH on-disk artifact proof);
     * 'hold' → NOT scoped (no checkpoint / stage `scope` / no-or-missing artifact), so its checkpoint has been
     * FIXED back to `scope` and it is skipped this pass. A held item is non-blocking — the picker passes over it
     * (never re-picked → no spin) and awaits interactive human scope, which re-admits it via the FSM write-through.
     */
    scopeGate: (item: Issue) => Promise<'drive' | 'hold'>;
  };
}

/** PSL.3 — a stage that reports the SAME stage this many times in a row (no advance) is genuinely stuck. */
const MAX_STAGE_RETRIES = 3;

/** Resource pauses END the run; everything else is per-item decision-residual that parks + continues. */
const RESOURCE_PAUSES: readonly HumanRequiredReason[] = ['BUDGET', 'RATE_BUDGET', 'BOARD_EMPTY'];
const isResourcePause = (r: HumanRequiredReason): r is RalphStop & HumanRequiredReason =>
  (RESOURCE_PAUSES as readonly string[]).includes(r);

/**
 * PSL.3 / GS1 — run ONE work-item to its outcome. With `stageLoop`, a unified per-iteration loop handles BOTH
 * automated and human-boundary stages: AUTOMATED stages (scope_write, plan, author, code) run a per-stage lap
 * (stagePrompt); HUMAN-BOUNDARY stages (scope, deploy/accept) run the open-ended per-item lap (no stagePrompt).
 * Two human boundaries exist: the interactive `scope` stage first, then the deploy/accept stage last. A SHIPPED
 * human-boundary lap with no resulting `stage` = item complete (the final human lap reported nothing to advance
 * to). A no-advance lap (automated or human-boundary) retries up to MAX_STAGE_RETRIES then escalates
 * UNRECOVERABLE_WEDGE. Costs accumulate so the caller's budget accounting is unaffected.
 * Without `stageLoop`, ONE open-ended per-item lap drives the whole item (unchanged — v1 coding-flow).
 */
async function runItemLaps(item: Issue, deps: RalphDeps, cfg: RalphConfig): Promise<LapResult> {
  const sl = deps.stageLoop;
  if (sl === undefined) return superviseLap(() => deps.runLap(item), cfg.supervise);

  // Seed from the DURABLE stage (resume-correct) or the pack initial (fresh item) — never a cross-session FSM read.
  let stage = (await sl.readStage(item.id)) ?? sl.initialStage;
  let cost = 0;
  let sameStage = 0;
  for (;;) {
    const isAuto = sl.isAutomated(stage);
    const sp = isAuto ? await sl.stagePrompt(item, stage) : undefined;
    const res = await superviseLap(() => deps.runLap(item, sp), cfg.supervise);
    cost += res.costUsd;
    if (res.kind !== 'SHIPPED') return { ...res, costUsd: cost }; // escalation/wedge → the uniform handler parks it
    const next = res.stage;
    // A SHIPPED human-boundary lap with no resulting stage = item complete (deploy/accept done, or the scope lap
    // when the agent reports no stage to advance to). Return the lap result as the item's final outcome.
    if (!isAuto && next === undefined) return { ...res, costUsd: cost };
    // No advance (stage didn't change, or undefined for an automated lap) → bounded retry.
    if (next === undefined || next === stage) {
      if (++sameStage >= MAX_STAGE_RETRIES)
        return { kind: 'HUMAN_REQUIRED', reason: 'UNRECOVERABLE_WEDGE', costUsd: cost };
      continue; // retry the same stage with a fresh lap (bounded)
    }
    sameStage = 0;
    stage = next; // in-run priming only; the DURABLE projection is written THROUGH by the FSM (v2_supply),
    // the single writer — a loop restart resumes from that FSM-written stage via `readStage`.
  }
}

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
    // GS1 — THE SCOPE GATE, as the PICKER's eligibility filter (automation must NEVER scope). Iterate the ready
    // list oldest-first and drive the first AUTOMATION-ELIGIBLE (really-scoped) item. An unscoped item is NON-
    // BLOCKING: the gate fixes its checkpoint back to `scope` and returns 'hold', so it is PASSED OVER within the
    // pass (never re-picked — no spin) and the loop advances to the next. A held item awaits interactive human
    // scope, which advances its checkpoint past `scope` + records the artifact (v2_supply write-through) and
    // re-admits it on a later pass. Without a stageLoop (v1 coding-flow) every item is eligible (no gate).
    let item: Issue | undefined;
    for (const cand of ready) {
      if (deps.stageLoop !== undefined && (await deps.stageLoop.scopeGate(cand)) === 'hold') continue;
      item = cand; // oldest-first eligible (listReady ORDER BY created_lamport ASC; no priority column)
      break;
    }
    if (item === undefined) {
      // Nothing automation-eligible (an empty board, OR every ready item is unscoped/held) → automation is
      // drained. Escalate + STOP (not a silent stop); the held items await interactive human scope.
      await parkAndEscalate('BOARD_EMPTY');
      return { stopped: 'BOARD_EMPTY', spent, closed, parked };
    }
    const { won } = await wg.claimIssue(item.id, deps.claimAudience(), cfg.claimTtlSec); // GR.1 atomic CAS
    if (!won) continue; // another runner/harness won it — it now carries a live claim, excluded next pass

    const outcome = await runItemLaps(item, deps, cfg); // GR.3 → LapResult (PSL.3: per-stage when stageLoop present)
    spent += outcome.costUsd; // GR.3 propagates costUsd across retries

    if (outcome.kind === 'SHIPPED') {
      await wg.updateIssue(item.id, { status: 'closed' });
      await deps.stageLoop?.clearStage(item.id); // PSL.3 — the item left the loop; drop its durable stage
      closed.push(item.id);
      // T2.9: the loop-driver lives here — on phases_complete (a SHIPPED lap) emit the CODE report + compute the
      // next run-group. Fail-open: a report/grouping error must never break the drain.
      try {
        await deps.onShipped?.(item.id);
      } catch {
        /* fail-open: never break the loop over the report/next-group hook */
      }
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
    wg: WorkGraphFacade;
    recordMisclassification: RecordMisclassification;
    sessionId: string;
    nowIso: string;
  },
): Promise<void> {
  const item = await deps.wg.getIssue(itemId);
  if (item?.wedgeReason === undefined)
    throw new Error(`resolveParked: not a parked item: ${itemId}`);
  await deps.recordMisclassification(deps.sessionId, 'DECIDE', 'ESCALATE', item.title, deps.nowIso);
  await deps.wg.clearWedge(itemId); // un-wedge
  await deps.wg.releaseClaim(itemId); // wg-8e1104f1934b: drop the lap's claim → re-surfaces NOW, not at TTL
}
