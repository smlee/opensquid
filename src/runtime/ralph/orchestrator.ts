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
import {
  inspectBoardAvailability,
  summarizeBoardWaiting,
  type BoardWaitingItem,
} from './board_availability.js';

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
  | 'BOARD_WAITING'
  | 'BUDGET'
  | 'RATE_BUDGET'
  | 'PROCESS_PAUSED'
  | 'CANCELLED_BY_HUMAN';

export interface RalphResult {
  stopped: RalphStop;
  spent: number; // running sum of lap costUsd (meaningful in API mode)
  closed: string[]; // item ids closed (SHIPPED)
  parked: { id: string; reason: HumanRequiredReason }[]; // items parked + escalated (residual)
  /** Present only for BOARD_WAITING: every nonterminal item and why it was unavailable to automation. */
  waiting?: BoardWaitingItem[];
}

export interface RalphDeps {
  wg: WorkGraphFacade;
  /** Env-derived claim audience (GR.1 — never caller input). */
  claimAudience: () => ClaimAudience;
  /**
   * Run ONE lap for an item → its typed outcome + cost. The CLI wraps the resolved harness lap + outcomeFromEnvelope.
   * `stagePrompt` (T-v2-per-stage-loop PSL.3): when present, the per-stage bundle + directive prepended to the
   * lap's prompt so the lap completes only that stage. The model-authored exit does not own progression; the
   * coordinator reads the gate-accepted session receipt by harness-generated attempt id.
   */
  runLap: (item: Issue, stagePrompt?: string, checkpointStage?: string) => Promise<LapResult>;
  /** The undroppable escalation transport (GR.3) — the CLI wires `escalateSeverity`. */
  escalate: LapEscalator;
  /** Optional per-step progress narration for a live play-by-play (the CLI wires stdout; omit → silent, as in tests). */
  narrate?: (msg: string) => void;
  /**
   * RD.3 — the orchestrator's live REPORT channel: DISPLAY a rendered before/after body for the higher scopes
   * (task at claim/close, session at run start/end). The CLI binds it to `displayReport(body, process.stdout)`
   * (the coordinator's live channel is stdout; StageProcess stderr has its own relay). OPTIONAL + fail-safe:
   * omitting it (tests, non-wired callers) is a silent no-op — no
   * behavior break — mirroring `narrate`. Distinct from `narrate` (a one-line play-by-play): `display` shows
   * the full before/after report body.
   */
  display?: (body: string) => void;
  /** Pack/application completion hook. Optional and fail-open so reporting or routing cannot break the drain. */
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
   * Present when the active pack declares process-driven states. The coordinator treats every state id as opaque,
   * runs one fresh StageProcess attempt for each declared state, and waits when the checkpoint reaches any
   * undeclared state. Absent preserves the legacy open-ended item path.
   */
  stageLoop?: {
    /** The pack-declared process entry, used only when admission has established a fresh eligible item. */
    initialStage: string;
    /** Membership in the pack-declared process-driven state set. */
    isAutomated: (stage: string) => boolean;
    /** True when the pack FSM classifies this opaque state as terminal. */
    isTerminal: (stage: string) => boolean;
    /** The per-stage prompt (bundle + 'do only this stage' directive) to prepend for `stage`. */
    stagePrompt: (item: Issue, stage: string) => Promise<string>;
    /** Deterministically skip model work when pack-owned durable evidence already completes this state. */
    completedStage?: (item: Issue, stage: string) => Promise<string | null>;
    /** Read the item's durable state (null → seed `initialStage`). */
    readStage: (itemId: string) => Promise<string | null>;
    /** Read the gate-accepted session-local state from the exact completed attempt. */
    readAttemptStage: (attemptId: string, itemId: string) => Promise<string>;
    /** Drop the item's durable stage once it leaves the loop (closed). */
    clearStage: (itemId: string) => Promise<void>;
    /**
     * Generic admission check. It proves the item has the pack-required durable handoff and that its opaque
     * checkpoint is in the declared process-driven set. Held items are skipped without rewriting pack state.
     */
    admissionGate: (item: Issue) => Promise<'drive' | 'hold'>;
    /** The coordinator's sole durable stage writer, called only with a gate-accepted attempt receipt. */
    reconcileStage: (itemId: string, stage: string) => Promise<void>;
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

/** A state that reports itself this many times in a row is stuck. The bound is intentionally generous for
 * productive multi-attempt states while still preventing an unbounded retry loop. */
const MAX_STAGE_RETRIES = 10;

/** Resource pauses END the run; everything else is per-item decision-residual that parks + continues. */
const RESOURCE_PAUSES: readonly HumanRequiredReason[] = [
  'BUDGET',
  'RATE_BUDGET',
  'PROCESS_PAUSED',
  'CANCELLED_BY_HUMAN',
  'BOARD_WAITING',
  'BOARD_EMPTY',
];
const isResourcePause = (r: HumanRequiredReason): r is RalphStop & HumanRequiredReason =>
  (RESOURCE_PAUSES as readonly string[]).includes(r);

/**
 * Run one work item. With `stageLoop`, only pack-declared process-driven states receive StageProcess attempts.
 * Reaching any other opaque state returns `AWAITING_INPUT`; core neither guesses its meaning nor runs an
 * open-ended fallback. A no-advance attempt retries up to MAX_STAGE_RETRIES, then wedges. Without `stageLoop`,
 * the legacy open-ended per-item path is unchanged.
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
    if (sl.isTerminal(stage)) {
      return { kind: 'SHIPPED', costUsd: cost };
    }
    if (!sl.isAutomated(stage)) {
      return { kind: 'AWAITING_INPUT', stage, costUsd: cost };
    }
    const completedStage = await sl.completedStage?.(item, stage);
    if (completedStage !== undefined && completedStage !== null && completedStage !== stage) {
      await flushStage(stage);
      await sl.reconcileStage(item.id, completedStage);
      deps.narrate?.(`  ✓ ${item.id} · ${stage} → ${completedStage} (durable evidence)`);
      stage = completedStage;
      sameStage = 0;
      stageStartMs = Date.now();
      stageCost = 0;
      stageIn = 0;
      stageOut = 0;
      continue;
    }
    const sp = await sl.stagePrompt(item, stage);
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
    const next =
      res.attemptId === undefined ? stage : await sl.readAttemptStage(res.attemptId, item.id);
    // No gate-accepted advance receipt → bounded fresh-attempt retry.
    if (next === stage) {
      if (++sameStage >= MAX_STAGE_RETRIES) {
        await flushStage(stage); // the stuck stage still burned resources — record before wedging
        return { kind: 'HUMAN_REQUIRED', reason: 'UNRECOVERABLE_WEDGE', costUsd: cost };
      }
      continue; // retry the same stage with a fresh lap (bounded) — accumulators carry across the retry
    }
    await flushStage(stage); // the stage COMPLETED (advanced) → write its per-stage row, then reset for `next`
    deps.narrate?.(`  ✓ ${item.id} · ${stage} → ${next}`);
    sameStage = 0;
    stage = next;
    // Only the deterministic coordinator turns the exact attempt's gate receipt into durable issue progression.
    await sl.reconcileStage(item.id, next);
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
  const displayAfterSession = (
    stopped: RalphStop,
    waiting: readonly BoardWaitingItem[] = [],
  ): void => {
    try {
      const parkedIds = new Set(parked.map((item) => item.id));
      const waitingOnly = waiting.filter((item) => !parkedIds.has(item.id));
      const resumable = [...parked.map((item) => item.id), ...waitingOnly.map((item) => item.id)];
      deps.display?.(
        renderScopeAfter(
          'session',
          `${stopped} · closed ${closed.length} / parked ${parked.length} / waiting ${waiting.length}`,
          [
            ...closed.map((id) => ({ item: id, done: true })),
            ...parked.map((p) => ({ item: p.id, done: false, note: p.reason })),
            ...waitingOnly.map((item) => ({
              item: item.id,
              done: false,
              note: `waiting:${item.reason}`,
            })),
          ],
          closed.length > 0 ? `closed ${closed.join(', ')}` : undefined,
          resumable.length > 0 ? `resume ${resumable.join(', ')}` : undefined,
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
  const awaitingInputIds = new Set<string>();
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
    // Pack-neutral admission: skip items whose durable checkpoint/evidence is absent or whose opaque state is
    // outside the pack-declared process set. The gate never rewrites state and held items do not block later
    // ready work in this pass.
    let item: Issue | undefined;
    const admissionHeldIds = new Set<string>();
    for (const cand of ready) {
      if (
        awaitingInputIds.has(cand.id) ||
        (deps.stageLoop !== undefined && (await deps.stageLoop.admissionGate(cand)) === 'hold')
      ) {
        admissionHeldIds.add(cand.id);
        continue;
      }
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
      let availability;
      try {
        availability = await inspectBoardAvailability(wg, admissionHeldIds);
      } catch {
        // A failed projection read cannot prove emptiness. Fail closed to BOARD_WAITING rather than emitting a
        // false BOARD_EMPTY; the empty detail list truthfully means the unavailable rows could not be classified.
        availability = { kind: 'waiting' as const, waiting: [] };
      }
      if (availability.kind === 'waiting') {
        const summary = summarizeBoardWaiting(availability.waiting) || 'classification unavailable';
        deps.narrate?.(
          `■ board waiting — BOARD_WAITING (${summary}; closed ${closed.length}, parked ${parked.length})`,
        );
        await parkAndEscalate('BOARD_WAITING');
        displayAfterSession('BOARD_WAITING', availability.waiting);
        return {
          stopped: 'BOARD_WAITING',
          spent,
          closed,
          parked,
          waiting: availability.waiting,
        };
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

    if (outcome.kind === 'AWAITING_INPUT') {
      awaitingInputIds.add(item.id);
      const claimed = await wg.getIssue(item.id);
      await wg.releaseClaim(item.id, claimed?.claimToken);
      deps.narrate?.(`⏸ ${item.id} awaiting pack input at ${outcome.stage}`);
      continue;
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
      // Invoke the pack/application completion hook after the durable item close. Fail-open by contract.
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
  const current = await deps.wg.getIssue(item.id);
  const stopRenewal = startClaimRenewal(
    deps.wg,
    item.id,
    current?.claimToken,
    cfg.claimTtlSec,
    deps.narrate,
  );
  try {
    const pool = deps.pool;
    if (pool === undefined) return await runItemLaps(item, deps, cfg);
    let path: string | undefined;
    try {
      path = await addItemWorktree(item.id, pool.mainRoot, pool.poolRoot, pool.io);
      deps.narrate?.(`⑃ worktree ${path} (auto/${item.id})`);
      return await runItemLaps(item, deps, cfg);
    } finally {
      if (path !== undefined)
        await removeItemWorktree(path, pool.mainRoot, pool.io).catch(() => undefined);
    }
  } finally {
    await stopRenewal();
  }
}

function startClaimRenewal(
  wg: WorkGraphFacade,
  itemId: string,
  token: string | undefined,
  ttlSec: number,
  narrate: RalphDeps['narrate'],
): () => Promise<void> {
  const renewClaim = wg.renewClaim?.bind(wg);
  if (token === undefined || renewClaim === undefined) return () => Promise.resolve();
  const intervalMs = Math.max(100, Math.floor((ttlSec * 1_000) / 3));
  let inFlight: Promise<void> = Promise.resolve();
  let renewing = false;
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = true;
    inFlight = renewClaim(itemId, token, ttlSec)
      .then(({ renewed }) => {
        if (!renewed) narrate?.(`⚠ claim renewal lost for ${itemId}`);
      })
      .catch((error: unknown) => {
        narrate?.(`⚠ claim renewal failed for ${itemId}: ${String(error)}`);
      })
      .finally(() => {
        renewing = false;
      });
  }, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await inFlight;
  };
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
