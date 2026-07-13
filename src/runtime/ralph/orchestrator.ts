/**
 * GR.4 — the gated-ralph orchestrator: a thin, non-LLM loop that composes GR.1–3.
 *
 * One pass: read the oldest ready item (GR.1 `listReady`) → atomically claim it (GR.1 CAS) → run a
 * supervised lap (GR.3 `superviseLap` over an injected lap-runner that wraps the resolved harness lap +
 * GR.2 `outcomeFromEnvelope`) → act on the typed `LapOutcome` (GR.2) → repeat until BOARD_EMPTY or a
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
import type { LoopMetricRow } from '../loop/loop_metrics.js';
import { superviseLap } from './supervisor.js';
import { reapOrphans } from '../loop/reaper.js'; // WGL.4/WGL.6 — the shared per-pass reaper
import { rollUpParents } from '../loop/parent_rollup.js'; // WGL.5 — parent auto-close on all-children-terminal
import { emitMonitorEvent } from '../loop/monitor_emit.js'; // LMP.2 — push item_closed/wedged to the feed
import { sweepTerminalBacklog } from '../loop/loop_boot_sweep.js'; // F1c — one-time boot drain of the terminal backlog
import { escalateLap, EscalationUndeliverableError, type LapEscalator } from './escalate_lap.js';
import type { DecisionVerdict } from './decision_classifier.js';
import { addItemWorktree, removeItemWorktree, type WorktreeIo } from './worktree_pool.js'; // AGF.3 — worktree-per-item
import { renderScopeBefore, renderScopeAfter } from '../loop/scope_report.js'; // RD.3 — task/session before/after bodies
import {
  durableItemCommitExists,
  MAX_COMMIT_REDRIVES,
  NO_DURABLE_COMMIT_LABEL,
  type RalphGitSeam,
} from './consistency_gate.js'; // CG.1 — the consistency gate at the SHIPPED-close boundary
import type { ResolvedEnvironments } from '../../packs/discovery.js'; // GF.1 — the config-driven git-flow environments
import type { ReconcileOutcome } from './auto_pull.js'; // GF.6 — the base-refresh reconcile outcome

export interface RalphConfig {
  /** Auth mode from CONFIG (Inv 11; no runtime auto-detect). API → dollar budget; subscription → W. */
  authMode: 'api' | 'subscription';
  /** API dollar bound — the running sum of the verified `total_cost_usd` (Inv 11). API mode only. */
  maxBudgetUsd: number;
  /** TTL for the per-item claim (GR.1). */
  claimTtlSec: number;
  /** GR.3 supervisor opts (retry cap, backoff, heartbeat). */
  supervise: SuperviseOpts;
  /** LSF.5 — the harness that drove this run (`file.harness.cli`), stamped on every loop_metrics row (§3a). */
  harness: string;
  /** LSF.5 — a stable id for THIS `opensquid loop` invocation; the `run_id` every metrics row shares (§3a). */
  runId: string;
}

/** Why the loop stopped. NB: the per-item residual reasons (IRREVERSIBLE_BOUNDARY / SCOPE_FORK /
 * UNRECOVERABLE_WEDGE) never STOP the loop — they park the item and the loop takes the next. The loop
 * RUNS TO EXHAUSTION: only an empty board or a RESOURCE pause (budget) ends the run — never a per-item stop.
 * (There is deliberately no single-item mode: that would reintroduce the per-item pause the loop exists to
 * eliminate — the run-to-exhaustion architecture.) */
export type RalphStop =
  | 'BOARD_EMPTY'
  | 'BUDGET'
  | 'RATE_BUDGET'
  | 'PROCESS_PAUSED'
  | 'CANCELLED_BY_HUMAN';

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
   * Run ONE lap for an item → its typed outcome + cost. The CLI wraps the resolved harness lap + outcomeFromEnvelope.
   * `stagePrompt` (T-v2-per-stage-loop PSL.3): when present, the per-stage bundle + directive prepended to the
   * lap's prompt so the lap completes ONLY that stage and reports its resulting `stage` in RALPH-EXIT. Absent →
   * the open-ended per-item lap (unchanged).
   */
  runLap: (item: Issue, stagePrompt?: string, checkpointStage?: string) => Promise<LapResult>;
  /** The undroppable escalation transport (GR.3) — the CLI wires `escalateSeverity`. */
  escalate: LapEscalator;
  /** Optional per-step progress narration for a live play-by-play (the CLI wires stdout; omit → silent, as in tests). */
  narrate?: (msg: string) => void;
  /**
   * RD.3 — the orchestrator's live REPORT channel: DISPLAY a rendered before/after body for the higher scopes
   * (task at claim/close, session at run start/end). The CLI binds it to `displayReport(body, process.stdout)`
   * (the orchestrator runs in the PARENT process, so its live channel is stdout — there is no `onStderrLine`
   * indirection here). OPTIONAL + fail-safe: omitting it (tests, non-wired callers) is a silent no-op — no
   * behavior break — mirroring `narrate`. Distinct from `narrate` (a one-line play-by-play): `display` shows
   * the full before/after report body.
   */
  display?: (body: string) => void;
  /**
   * T2.9 loop-driver hook — called after a lap SHIPS a task (phases_complete). The CLI wires this to
   * `onPhasesComplete` (emit the CODE stage report + compute the next run-group via batchDecide). Optional +
   * fail-open: a report/grouping error must never break the drain loop.
   */
  onShipped?: (taskId: string) => Promise<void>;
  /**
   * #26 HWS.5(b) — the loop-pass harness↔workgraph reconcile: once per drained pass (beside the orphan
   * reaper), observe OUT-OF-SESSION wg changes off the op-log cursor (no Task tick) and emit the outbound
   * nudge. INJECTED (the CLI wires the real openers + `ccNudgeWriter`; tests stub or omit it) so the
   * orchestrator stays db-free/testable. Returns the advisory nudge string (or `null`). Fail-open BY CONTRACT
   * — the orchestrator wraps the call in try/catch (mirroring the reaper), so a reconcile fault never breaks
   * the drive pass. Absent → no loop-pass reconcile (tests / the v1 non-project path).
   */
  loopPassReconcile?: () => Promise<string | null>;
  /**
   * LSF.5 (subprocess-harness-push.md §3a) — the per-STAGE metrics writer, INJECTED so the loop stays unit-
   * testable without a real libsql. Called once per completed/exited stage of a `stageLoop` drive with the
   * folded cost/tokens/timing row. Fail-open by contract (the orchestrator swallows a write error) — a metrics
   * fault must NEVER break the drive. Absent → no history recorded (tests / the v1 non-stage path).
   */
  recordMetric?: (row: LoopMetricRow) => Promise<void>;
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
    /**
     * scope-3 (T-in-lap-gating) — CONDITIONAL durable-stage fallback. Persist the gate-accepted `stage` THROUGH
     * the single `upsertTaskStage` seam (one write + one stage_advance emit). The orchestrator calls this ONLY when
     * a post-lap re-read shows the in-lap FSM write-through did not land — so it is a defensive fallback writer,
     * never a concurrent second writer, and never a double emit. Optional-additive: absent ⇒ no reconcile
     * (byte-unchanged; every existing `stageLoop` fixture that omits it drives exactly as before).
     */
    reconcileStage?: (itemId: string, stage: string) => Promise<void>;
  };
  /**
   * AGF.3 (T-opensquid-automated-gitflow, wg-4ae1004c931b) — the bounded concurrency pool + worktree-per-item.
   * When PRESENT, the claim-and-drive runs each item in its OWN git worktree (cut from fresh `main`, `auto/wg-<id>`)
   * so concurrent laps never clobber each other's edits, up to `bound` in flight (`drainPool`). Every git effect is
   * behind the injected `WorktreeIo` (tests pass a stub — no real git). ABSENT (default) ⇒ the serial in-place
   * drive (the `bound:1` degenerate case) — unchanged. Opt-in + additive, the framework pattern (like `stageLoop`).
   */
  pool?: {
    bound: number;
    poolRoot: string;
    mainRoot: string;
    io: WorktreeIo;
  };
  /**
   * CG.1 (T-consistency-gate, wg-1c620a56b733) — the injected git seam the CONSISTENCY GATE reads through.
   * PRESENT ⇒ before an item's drive the orchestrator records the target tip (`baseSha`), and at the SHIPPED
   * close it VERIFIES a durable item-owned commit landed (`durableItemCommitExists`); if not, it re-drives up to
   * MAX_COMMIT_REDRIVES then PARKS `NO_DURABLE_COMMIT` (never a silent close). ABSENT (default; every existing
   * test, v1 coding-flow) ⇒ the gate is a NO-OP and the SHIPPED-close is byte-unchanged (backward compatible).
   * Optional + additive, exactly like `stageLoop?`/`pool?`/`recordMetric?`. The CLI wires `makeRalphGitSeam(root)`.
   */
  git?: RalphGitSeam;
  /**
   * GF.2 (T-gitflow-integration-fix, scope-1/scope-2) — the resolved config-driven git-flow environments
   * (`version-control.environments`, GF.1's `resolveEnvironments(root)`). PRESENT ⇒ the consistency gate verifies
   * the durable item commit landed on the CONFIGURED integration target (`staging ?? local`), not merely `HEAD`;
   * `baseSha` is recorded on the target tip. ABSENT (default; unconfigured project, every existing test) ⇒ the
   * gate is the current HEAD-based check (no behavior change). Optional + additive, like `git?`. The CLI wires
   * `resolveEnvironments(root)`.
   */
  environments?: ResolvedEnvironments;
  /**
   * GF.6 (scope-6) — the LIVE per-pass base-refresh reconcile (BLOCKING-1 fix: `autoPullMain` had ZERO live
   * callers). Called ONCE PER PASS at the top of the drive loop (before `listReady`), mirroring the existing
   * per-pass `loopPassReconcile?`. Reconciles the local base (`environments.production`) with origin PRESERVING
   * whoever is ahead (a trunk hot patch is never lost); a `conflict` outcome routes to the human-surface/park
   * path. The CLI wires `reconcileBase(root, env.production)`. ABSENT (default) ⇒ no base-refresh (a non-automated
   * project never refreshes a base it did not declare). Fail-open on a transient fetch fault (mirrors the reaper).
   */
  baseRefresh?: () => Promise<ReconcileOutcome>;
}

/** PSL.3 — a stage that reports the SAME stage this many times in a row (no advance) is genuinely stuck.
 *  Raised 3→10 (2026-07-06): a real multi-lap CODE stage needed ~6 laps to complete (the deploy-commit-gate
 *  task), so 3 wedged legitimate progress. 10 gives generous headroom while staying bounded (a genuinely stuck
 *  stage still wedges — no unbounded spin/OOM). NOTE: a fixed cap can still park a very large task; the durable
 *  fix is progress-aware (reset the counter on real progress). Errors are a separate, per-lap bound (`maxRetries`). */
const MAX_STAGE_RETRIES = 10;

/** Resource pauses END the run; everything else is per-item decision-residual that parks + continues. */
const RESOURCE_PAUSES: readonly HumanRequiredReason[] = [
  'BUDGET',
  'RATE_BUDGET',
  'PROCESS_PAUSED',
  'CANCELLED_BY_HUMAN',
  'BOARD_EMPTY',
];
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

  // LSF.5 (§3a) — per-STAGE metrics accumulation. One row per stage: SUM the cost/tokens of the lap(s) that ran
  // in it, timed from stage-entry to stage-exit. `flushStage` writes the completed/exited stage's row and is
  // FAIL-OPEN (a metrics fault never breaks the drive). `stageAcc` resets on every real advance.
  let stageStartMs = Date.now();
  let stageCost = 0;
  let stageIn = 0;
  let stageOut = 0;
  const flushStage = async (stageName: string): Promise<void> => {
    if (deps.recordMetric === undefined) return;
    const endedAtMs = Date.now();
    try {
      await deps.recordMetric({
        runId: cfg.runId,
        itemId: item.id,
        stage: stageName, // OPAQUE pack label — core stamps whatever the stage string is (§3a boundary rule)
        harness: cfg.harness,
        authMode: cfg.authMode,
        startedAtMs: stageStartMs,
        endedAtMs,
        durationMs: endedAtMs - stageStartMs,
        costUsd: stageCost,
        inputTokens: stageIn,
        outputTokens: stageOut,
      });
    } catch {
      /* fail-open: the metrics history must NEVER break the drive */
    }
  };

  for (;;) {
    const isAuto = sl.isAutomated(stage);
    const sp = isAuto ? await sl.stagePrompt(item, stage) : undefined;
    deps.narrate?.(`  ▷ ${item.id} · ${stage} lap…`);
    const res = await superviseLap(() => deps.runLap(item, sp, stage), cfg.supervise);
    cost += res.costUsd;
    stageCost += res.costUsd;
    stageIn += res.inputTokens ?? 0;
    stageOut += res.outputTokens ?? 0;
    if (res.kind !== 'SHIPPED') {
      await flushStage(stage); // record the resources this stage burned before the escalation parks the item
      return { ...res, costUsd: cost }; // escalation/wedge → the uniform handler parks it
    }
    const next = res.stage;
    // A SHIPPED human-boundary lap with no resulting stage = item complete (deploy/accept done, or the scope lap
    // when the agent reports no stage to advance to). Return the lap result as the item's final outcome.
    if (!isAuto && next === undefined) {
      await flushStage(stage);
      return { ...res, costUsd: cost };
    }
    // No advance (stage didn't change, or undefined for an automated lap) → bounded retry.
    if (next === undefined || next === stage) {
      if (++sameStage >= MAX_STAGE_RETRIES) {
        await flushStage(stage); // the stuck stage still burned resources — record before wedging
        return { kind: 'HUMAN_REQUIRED', reason: 'UNRECOVERABLE_WEDGE', costUsd: cost };
      }
      continue; // retry the same stage with a fresh lap (bounded) — accumulators carry across the retry
    }
    await flushStage(stage); // the stage COMPLETED (advanced) → write its per-stage row, then reset for `next`
    deps.narrate?.(`  ✓ ${item.id} · ${stage} → ${next}`);
    sameStage = 0;
    stage = next; // in-run priming; the durable projection is written THROUGH by the FSM (v2_supply → upsertTaskStage)
    // DURING the lap (hooks live — T-in-lap-gating), the single writer, and scope-3's conditional fallback below
    // reconciles through that SAME seam if it ever did not land — a loop restart resumes from `readStage`.
    // scope-3 — belt-and-suspenders: the in-lap FSM write-through is authoritative and USUALLY already persisted
    // `next` DURING the lap. But if it did NOT land (a silenced hook path, a crash before PostToolUse), re-read the
    // durable stage and reconcile THROUGH the SAME single seam — conditional (only on divergence), same accepted
    // value → exactly one write + one stage_advance emit per transition (the shipped single-writer/single-emit
    // invariant, loop_stage.ts:126-140/:139, holds). `next` is the FSM-accepted transition, never a blind stamp.
    if (sl.reconcileStage !== undefined) {
      const durable = await sl.readStage(item.id);
      if (durable !== next) await sl.reconcileStage(item.id, next);
    }
    stageStartMs = Date.now();
    stageCost = 0;
    stageIn = 0;
    stageOut = 0;
  }
}

export async function runRalphLoop(cfg: RalphConfig, deps: RalphDeps): Promise<RalphResult> {
  const { wg } = deps;
  const closed: string[] = [];
  const parked: { id: string; reason: HumanRequiredReason }[] = [];
  let spent = 0;

  // F1c — ONCE at loop start, drain the pre-existing terminal backlog: any item that still folds LIVE on the feed
  // but reads wg-terminal (a close that landed before this fix, or in the non-atomic close/emit crash window) gets
  // a synthetic `item_closed`. Bounded set-based read, off the hot path. Fail-open — a sweep fault (a monitor-store
  // or wg-read error) must NEVER block the drain.
  try {
    const drainedStale = await sweepTerminalBacklog(wg);
    if (drainedStale > 0)
      deps.narrate?.(`■ boot sweep drained ${drainedStale} stale terminal item(s)`);
  } catch {
    /* fail-open: the boot sweep is best-effort backlog hygiene, never a drain blocker */
  }

  // RD.3 — the SESSION scope's before/after communication report (an orchestrator run = one sitting), DISPLAYED
  // live (never saved). before-session: a reconcile-before over the ready board — "Will: drive N ready item(s)".
  // The after-session is the handoff summary (`displayAfterSession`), fired at EVERY run-end return (BOARD_EMPTY,
  // the resource-pause returns, BUDGET) so a session never ends without its after. The handoff RESUME STATE keeps
  // persisting in its own subsystem — this only DISPLAYS the session-communication report. Fail-open by contract.
  try {
    const readyAtStart = await wg.listReady();
    deps.display?.(
      renderScopeBefore(
        'session',
        `${readyAtStart.length} ready item(s)`,
        readyAtStart.length > 0
          ? readyAtStart.map((i) => `${i.id} — ${i.title.slice(0, 60)}`)
          : ['(board empty at start)'],
        new Date().toISOString(),
      ).body,
    );
  } catch {
    /* fail-open: a before-session display fault must never break the drive */
  }
  const displayAfterSession = (stopped: RalphStop): void => {
    try {
      deps.display?.(
        renderScopeAfter(
          'session',
          `${stopped} · closed ${closed.length} / parked ${parked.length}`,
          [
            ...closed.map((id) => ({ item: id, done: true })),
            ...parked.map((p) => ({ item: p.id, done: false, note: p.reason })),
          ],
          closed.length > 0 ? `closed ${closed.join(', ')}` : undefined,
          parked.length > 0 ? `resume ${parked.map((p) => p.id).join(', ')}` : undefined,
          new Date().toISOString(),
        ).body,
      );
    } catch {
      /* fail-open: an after-session display fault must never break the return */
    }
  };

  // THE single uniform stop-layer (Inv 5): every reason chat-escalates through ONE path — no per-trigger
  // code paths (rejects Alt D). Two SEPARATE, explicit decisions ride alongside it: (a) wedge-mark ONLY the
  // per-item residual (IRREVERSIBLE_BOUNDARY/SCOPE_FORK/UNRECOVERABLE_WEDGE) — a resource pause
  // (BUDGET/RATE_BUDGET/BOARD_EMPTY) is TRANSIENT, so the item stays in `ready` to retry after the
  // window/budget resets (wedge-marking it would PERMANENTLY park healthy work); (b) continue-vs-stop is
  // isResourcePause at the call sites.
  const parkAndEscalate = async (reason: HumanRequiredReason, item?: Issue): Promise<void> => {
    if (item !== undefined && !isResourcePause(reason)) {
      await wg.wedgeMark(item.id, reason); // a marked item SKIPS on re-attempt (residual only — GR.3)
      await emitMonitorEvent({ wgId: item.id, kind: 'item_wedged', atMs: Date.now() }); // LMP.2 — GUARDED on a present item (the item-less BOARD_EMPTY park emits none)
      parked.push({ id: item.id, reason });
    }
    // GR.3 — undroppable for a RESIDUAL per-item escalation (IRREVERSIBLE_BOUNDARY / SCOPE_FORK /
    // UNRECOVERABLE_WEDGE): a delivery failure THROWS so a wedged item never silently strands the human (Inv 6).
    // A RESOURCE PAUSE (BOARD_EMPTY / BUDGET / RATE_BUDGET) is a TRANSIENT clean stop, not a wedge — its notice
    // failing to deliver (daemon down, or no chat binding for this cwd) must NOT crash the loop with exit 1.
    // Fail-open on DELIVERY there: log it and let the loop return its stop cleanly.
    try {
      await escalateLap(
        reason,
        item === undefined
          ? { escalate: deps.escalate }
          : { item: item.id, escalate: deps.escalate },
      );
    } catch (e) {
      if (e instanceof EscalationUndeliverableError && isResourcePause(reason)) {
        process.stderr.write(`⚠️ ${e.message} — non-fatal (resource pause); loop stops cleanly\n`);
        return;
      }
      throw e;
    }
  };

  // GF.6 — a genuine base-reconcile conflict is surfaced+escalated ONCE, then the reconcile is skipped on later
  // passes (the merge was aborted by `reconcileBase`, so the base is clean/unchanged; a human resolves the
  // divergence out of band). This prevents both work-loss (nothing auto-picked) AND an escalate-spin.
  let baseConflictSurfaced = false;
  for (;;) {
    // GF.6 (BLOCKING-1 fix) — the LIVE per-pass base-refresh: reconcile the base BEFORE driving so a trunk hot
    // patch is pulled into the base (never later reverted). Fail-open on a transient fetch fault (mirrors the
    // reaper's catch); a genuine `conflict` is surfaced to a human, never auto-resolved.
    if (deps.baseRefresh !== undefined && !baseConflictSurfaced) {
      try {
        const rc = await deps.baseRefresh();
        if (rc.kind === 'conflict') {
          baseConflictSurfaced = true;
          deps.narrate?.(
            '⚠ base reconcile conflict — surfacing to a human (base left unchanged; drive continues on the un-refreshed base)',
          );
          await parkAndEscalate('SCOPE_FORK'); // item-less escalate (undroppable); no wedge-mark, no spin
        }
      } catch {
        /* fail-open: a transient fetch/reconcile fault must never break the drive pass (mirrors the reaper) */
      }
    }
    const ready = await wg.listReady(); // GR.1 ordering, claim+wedge aware (live-claimed items excluded)
    // GS1 — THE SCOPE GATE, as the PICKER's eligibility filter (automation must NEVER scope). Iterate the ready
    // list oldest-first and drive the first AUTOMATION-ELIGIBLE (really-scoped) item. An unscoped item is NON-
    // BLOCKING: the gate fixes its checkpoint back to `scope` and returns 'hold', so it is PASSED OVER within the
    // pass (never re-picked — no spin) and the loop advances to the next. A held item awaits interactive human
    // scope, which advances its checkpoint past `scope` + records the artifact (v2_supply write-through) and
    // re-admits it on a later pass. Without a stageLoop (v1 coding-flow) every item is eligible (no gate).
    let item: Issue | undefined;
    for (const cand of ready) {
      if (deps.stageLoop !== undefined && (await deps.stageLoop.scopeGate(cand)) === 'hold')
        continue;
      item = cand; // oldest-first eligible (listReady ORDER BY created_lamport ASC; no priority column)
      break;
    }
    if (item === undefined) {
      // Nothing automation-eligible (an empty board, OR every ready item is unscoped/held) → automation is
      // drained. WGL.6 (§6.6) — before declaring BOARD_EMPTY, REAP orphaned stubs so junk never masquerades as
      // an empty board. This is the SINGLE per-pass reaper call site (also WGL.4's loop-pass trigger). If the
      // reap archived anything, re-drain (the board changed); only a reap that archives NOTHING NEW is a genuine
      // empty/all-held board → escalate. Converges (the reaper is idempotent, so pass 2 archives nothing).
      // #26 HWS.5(b) — the loop-pass reconcile: observe out-of-session wg changes off the op-log cursor and
      // emit the outbound nudge (wg→harness only; no Task tick). Fail-open, exactly like the reaper below.
      try {
        const nudge = await deps.loopPassReconcile?.();
        if (nudge !== undefined && nudge !== null) deps.narrate?.(nudge);
      } catch {
        /* fail-open: a loop-pass reconcile fault must never break the drive pass (mirrors the reaper's catch) */
      }
      let reaped: string[] = [];
      try {
        reaped = await reapOrphans(wg);
      } catch {
        /* fail-open: a reap error must never break the drain — fall through to BOARD_EMPTY */
      }
      if (reaped.length > 0) {
        deps.narrate?.(`■ reaped ${reaped.length} orphan(s) before BOARD_EMPTY — re-draining`);
        continue; // re-evaluate: the orphans are gone; the held/real items are re-considered
      }
      deps.narrate?.(
        `■ board drained — BOARD_EMPTY (closed ${closed.length}, parked ${parked.length})`,
      );
      await parkAndEscalate('BOARD_EMPTY');
      displayAfterSession('BOARD_EMPTY'); // RD.3 — after-session handoff summary (displayed live)
      return { stopped: 'BOARD_EMPTY', spent, closed, parked };
    }
    const { won } = await wg.claimIssue(item.id, deps.claimAudience(), cfg.claimTtlSec); // GR.1 atomic CAS
    if (!won) continue; // another runner/harness won it — it now carries a live claim, excluded next pass

    deps.narrate?.(`▶ claim ${item.id} — ${item.title.slice(0, 60)}`);
    // RD.3 — before-task: DISPLAY "Before-task · <id> · Will: <title>" live at the claim boundary (§5.2 before-task).
    deps.display?.(renderScopeBefore('task', item.id, [item.title], new Date().toISOString()).body);
    // AGF.3 — when the pool is enabled, drive the item in its OWN worktree (cut from fresh `main`, `auto/wg-<id>`)
    // so concurrent laps never clobber each other's edits; the worktree is always torn down (fail-open) even on a
    // driven-item throw. ABSENT (default) ⇒ the serial in-place drive, unchanged. The claim/fold semantics below
    // (SHIPPED close, roll-up, onShipped, parked escalate) are PRESERVED — the pool changes WHERE the drive runs.
    // CG.1 — the CONSISTENCY GATE: record the integration target's tip BEFORE the drive (per-item by
    // construction — one binding per for-loop iteration, which drives exactly one claimed item; generalizes to
    // a per-item-keyed record in the future pool drainer with NO logic change). Absent seam ⇒ undefined ⇒ no gate.
    // GF.2 — the CONFIGURED integration target (staging ?? local); `undefined` for an unconfigured project ⇒ the
    // gate defaults to HEAD (byte-identical to the shipped base gate). `baseSha` is recorded on the TARGET's tip.
    const target = deps.environments
      ? (deps.environments.staging ?? deps.environments.local)
      : undefined;
    const baseSha = deps.git ? await deps.git.tip(target) : undefined;
    let outcome = await driveMaybePooled(item, deps, cfg); // GR.3 → LapResult (PSL.3 per-stage when stageLoop present)
    spent += outcome.costUsd; // GR.3 propagates costUsd across retries

    // CG.1 — a SHIPPED lap that produced NO durable item commit is re-driven up to MAX_COMMIT_REDRIVES, then
    // PARKED `NO_DURABLE_COMMIT` (never silently closed). `baseSha` is recorded ONCE (before the FIRST drive) and
    // reused across re-drives, so a late-landing commit reads as advanced past the ORIGINAL base. The gate is a
    // no-op when the seam is absent (backward compatible) — the whole block is skipped.
    if (outcome.kind === 'SHIPPED' && deps.git !== undefined && baseSha !== undefined) {
      let redrives = 0;
      let parkedNoCommit = false;
      while (!(await durableItemCommitExists(deps.git, baseSha, target))) {
        if (redrives >= MAX_COMMIT_REDRIVES) {
          deps.narrate?.(
            `⚠ ${item.id} SHIPPED without a durable commit — parking (${NO_DURABLE_COMMIT_LABEL})`,
          );
          deps.display?.(
            `⚠ ${item.id}: ${NO_DURABLE_COMMIT_LABEL} — work not committed after ${MAX_COMMIT_REDRIVES} re-drives; NOT closed`,
          );
          await parkAndEscalate('NO_DURABLE_COMMIT', item); // non-resource residual → wedge-mark + item_wedged + undroppable escalate
          parkedNoCommit = true;
          break;
        }
        redrives++;
        deps.narrate?.(
          `  ↻ ${item.id} re-drive ${redrives}/${MAX_COMMIT_REDRIVES} to land the commit`,
        );
        const re = await driveMaybePooled(item, deps, cfg);
        spent += re.costUsd;
        if (re.kind !== 'SHIPPED') {
          outcome = re; // a re-drive that itself escalates → fall into the uniform park path below (parked once there)
          break;
        }
      }
      // Divert PAST the SHIPPED-close AND the else-park: the item is ALREADY parked once here, so `continue` to
      // the next ready item (mirrors the picker's `continue` idiom) — no double-park, no double SHIPPED-close.
      if (parkedNoCommit) continue;
    }

    if (outcome.kind === 'SHIPPED') {
      // F1a — the close PUSHES its `item_closed` from the store boundary (`onIssueTerminal`, wired by the loop
      // opener), NOT from a manual emit here. One boundary, every path: this SHIPPED close and every rolled-up
      // parent close below both flow through `wg.updateIssue`, so neither needs (nor keeps) its own emit.
      await wg.updateIssue(item.id, { status: 'closed' });
      await deps.stageLoop?.clearStage(item.id); // PSL.3 — the item left the loop; drop its durable stage
      closed.push(item.id);
      deps.narrate?.(`✓ SHIPPED ${item.id} (closed ${closed.length})`);
      // RD.3 — after-task: DISPLAY the task-completion report live at the SHIPPED close (§5.2 after-task).
      deps.display?.(
        renderScopeAfter(
          'task',
          item.id,
          [{ item: item.title, done: true }],
          `closed ${closed.length}`,
          undefined,
          new Date().toISOString(),
        ).body,
      );
      // WGL.5 — parent roll-up: after the child's close is durable, close every ancestor parent whose children
      // are ALL non-drivable (closed/archived/wedged). A wedged child stays independently escalated (never
      // buried). Fail-open: a roll-up error must never break the drain (mirrors the onShipped hook).
      try {
        const rolled = await rollUpParents(wg, item.id);
        for (const p of rolled) {
          closed.push(p);
          deps.narrate?.(`✓ rolled up parent ${p} (all children terminal)`);
        }
      } catch {
        /* fail-open: never break the drain over the parent roll-up */
      }
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
      deps.narrate?.(`⚠ parked ${item.id}: ${reason}`);
      await parkAndEscalate(reason, item);
      if (isResourcePause(reason)) {
        displayAfterSession(reason); // RD.3 — after-session on a resource-pause stop (reason narrowed to RalphStop)
        return { stopped: reason, spent, closed, parked }; // e.g. lap-emitted RATE_BUDGET
      }
      // else (IRREVERSIBLE_BOUNDARY / SCOPE_FORK / UNRECOVERABLE_WEDGE): parked, take the next item
    }

    if (cfg.authMode === 'api' && spent > cfg.maxBudgetUsd) {
      await parkAndEscalate('BUDGET'); // Inv 11 API bound (verified total_cost_usd) → resource pause → STOP
      displayAfterSession('BUDGET'); // RD.3 — after-session on the budget stop
      return { stopped: 'BUDGET', spent, closed, parked };
    }
    // No single-item stop: the loop takes the next ready item and runs to exhaustion (BOARD_EMPTY).
  }
}

/** AGF.3 — drive one item, in its own worktree when the pool is enabled (else the serial in-place drive). The
 *  worktree is cut BEFORE the drive (`addItemWorktree`) and torn down AFTER in a `finally` (`removeItemWorktree`,
 *  fail-open) — the lifecycle is attached to the claim/drive so a concurrent lap gets an isolated checkout, and the
 *  fold at the call site is unchanged. ABSENT pool ⇒ `runItemLaps` directly (the `bound:1` degenerate case). */
async function driveMaybePooled(
  item: Issue,
  deps: RalphDeps,
  cfg: RalphConfig,
): Promise<LapResult> {
  const pool = deps.pool;
  if (pool === undefined) return runItemLaps(item, deps, cfg);
  let path: string | undefined;
  try {
    path = await addItemWorktree(item.id, pool.mainRoot, pool.poolRoot, pool.io);
    deps.narrate?.(`⑃ worktree ${path} (auto/${item.id})`);
    return await runItemLaps(item, deps, cfg);
  } finally {
    if (path !== undefined)
      await removeItemWorktree(path, pool.mainRoot, pool.io).catch(() => undefined);
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
