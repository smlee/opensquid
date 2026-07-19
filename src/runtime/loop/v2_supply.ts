/**
 * FAC-CUT.5b.2 — the IN-PROCESS v2 host supply (T-fac-cut-5b2-v2-host-supply).
 *
 * Makes a v2 cartridge actually RUN inside the live hook path (the FAC-CUT.4 seam: in-process, NOT the daemon
 * bus — there is no `Bus` in a hook subprocess, `host.ts:131`). On each hook event: load the active v2
 * cartridges, seed each pure `V2ObservedActor` from its persisted `fsm-<pack>` state, `receive` the event,
 * and APPLY the returned effects — `write_state` → persist; `transition` → `appendTransition` (INV2
 * observability, the v1 durable equivalent of the bus transition, `transition_log.ts:10-11`); `gate_action` →
 * the hook decision (block/halt → exit 2; warn → a nudge). The whole per-cartridge step is FAIL-OPEN: a v2
 * cartridge bug NEVER breaks the hook.
 *
 * ADDITIVE + inert: when no ACTIVE v2 cartridge exists (true today — zero `pack.yaml`, active packs all v1),
 * `runV2Cartridges` returns the ZERO decision, so the merged hook result is byte-identical to v1.
 *
 * Imports from: ../bootstrap (loadActiveV2Cartridges), ./v2_observed_actor, ../fsm_state, ../observe/transition_log.
 * Imported by: src/runtime/hooks/pre-tool-use.ts + post-tool-use.ts (merged after dispatchEvent).
 */
import { readFile } from 'node:fs/promises';

import { loadActiveV2Cartridges } from '../bootstrap.js';
import { buildBaseGuardContext, readAuditVerdict } from './guard_context.js';
import { extendFullstackGuardContext } from '../../packs/runtime/fullstack_flow.js';
import { atomicWriteFile } from '../../storage/atomic_file.js';
import { appendAsk, freezeAsk, resetAsk } from '../coverage/captured_ask.js';
import { persistActorState, readFsmState } from '../fsm_state.js';
import { readCheckpointBySession, upsertTaskStage } from '../ralph/loop_stage.js';
import { resolveCheckpointKey } from './checkpoint_key.js';
import { appendTransition } from '../observe/transition_log.js';
import { resolveProjectScopeRoot, sessionStateFile } from '../paths.js';
import {
  readActiveArchDetector,
  readActiveVerifyCommand,
  readActiveVerifySuite,
} from '../../packs/discovery.js';
import {
  bumpBugfixRounds,
  recordArch,
  recordNeedsRedesign,
  recordSuite,
  recordVerification,
  resetBugfixRounds,
} from './verification.js';
import {
  readActiveTask,
  readActiveTaskId,
  readClassifiedFacets,
  readSessionCwd,
} from '../session_state.js';
import { readSettings } from '../orchestrator_settings.js';
import { skillServesDomainMatches } from '../../packs/skill_serves.js';
import { InMemorySkillRuntime, onStateEntry, onStateLeave } from '../skill/state_skills.js';
import { capturePendingLesson } from '../wedge/capture.js';
import { goalConsult } from './goal_consult.js';
import { CODE_PHASES, renderStageReport, renderStageSummary } from './stage_report.js';
import { displayReport } from './report_display.js';
import { renderFollowReminder } from './follow_reminder.js';
import { renderFailureReport } from './failure_report.js';
import { saveProjectReport } from './reports_dir.js';
import type { AuditBinding, EvidenceRef, Reactions } from '../../packs/schemas/pack_v2.js';

/**
 * T2.12-surface — best-effort push of a phase report to the project's chat. FAIL-OPEN in every branch: no
 * channels config / no umbrella for this cwd / no daemon running → silently skip (a report must never break
 * the hook, and chat is optional). The daemon resolves `project:telegram` to the cwd-umbrella's channel.
 */
/**
 * T2.12-evidence — GENERIC render of a gate's `Evidence:` proof line from its DECLARED `reads:` keys (pack
 * data), resolved out of the just-evaluated guard ctx (flat dotted keys). The phase already passed (the
 * transition fired), so these are the checks that made it pass — a readable proof.
 *
 * The former hardcoded per-stage switch (scope/plan/author/code/deploy) is DELETED: each gate declares the ctx
 * keys it reads in pack.yaml, so a non-coding pack renders its own evidence and core carries ZERO stage
 * vocabulary. A BARE STRING key → the display label is the key minus its `<state>.` prefix and it reads
 * TRUE-is-good; the OBJECT form carries an explicit `label` and/or `expect` polarity (e.g. `open_question` is
 * GOOD when false → `{ key, label: 'no open question', expect: false }`).
 */
function stageEvidence(
  ctx: Map<string, unknown>,
  reads: readonly EvidenceRef[],
): { label: string; ok: boolean }[] {
  return reads.map((r) => {
    const key = typeof r === 'string' ? r : r.key;
    const expect = typeof r === 'string' ? true : (r.expect ?? true);
    const dot = key.indexOf('.');
    const shortLabel = dot >= 0 ? key.slice(dot + 1) : key; // key minus its `<state>.` prefix
    const label = typeof r === 'string' ? shortLabel : (r.label ?? shortLabel);
    return { label, ok: ctx.get(key) === expect };
  });
}

// LSF.4 (subprocess-harness-push.md §4) — the Telegram report-push (`surfaceReportToChat`) was REMOVED here.
// Stage reports still SAVE to `.opensquid/reports/` (the durable record); their live VISIBILITY moved to the
// harness status line / Monitor (`opensquid loop-status`), not chat. The wrong surface (fail-open telegram push,
// silently swallowing failures) is gone — no report goes to telegram.
import type { AuthorInputs } from './author_evidence.js';
import { codeEvidenceForSession, type CodeEvidenceDeps } from './code_evidence.js';
import type { FrontendEvidenceDeps } from './frontend_evidence.js';
import type { DeployEvidenceDeps } from './deploy_evidence.js';
import { openWg } from './plan_evidence.js';
import { reconcileDecomposition } from './decompose_reconcile.js';
import { extractScope } from './scope_extract.js';
import { gatherReadiness, recordReadiness, readinessResult } from './readiness.js';
import { isExternalConsultTool, recordExternalConsult } from './external_consult.js';
import { appendAcceptance, readAcceptance } from './acceptance.js';
import { isComplete, readPhaseState } from '../workflow_phases.js';
import { V2ObservedActor } from './v2_observed_actor.js';

import { applyAction } from '../gate/kernel.js';
import type { Action } from '../gate/kernel.js';
import type { Bus } from '../bus/bus.js';
import type { Envelope } from '../bus/types.js';
import type { Event } from '../event.js';
import { isMutatingCall } from '../guard/orchestrator_guard.js';
import { evaluateLane, laneBlockMessage } from './write_lane.js';
import { readAuditPolicy, type ScopeAuditPolicy } from './scope_audit_policy.js';

export { auditEntryCertifiesSubject } from './scope_audit_policy.js';

export interface V2Decision {
  exitCode: 0 | 2;
  /** block/halt instructions → stderr (the in-process observation of enforcement). */
  messages: string[];
  /** warn nudges → additionalContext. */
  injections: string[];
  /**
   * SKILL.1 (R-SKILLS-PER-STATE) — the skills bound for the cartridge's CURRENT state this event (state IS the
   * router). A DEDICATED channel, distinct from `injections` (warn nudges). Delivering this set's CONTENT into
   * the agent context is the Track-2 skill-loader host; this field is the binding's observable.
   */
  boundSkills: string[];
}

const ZERO: V2Decision = { exitCode: 0, messages: [], injections: [], boundSkills: [] };

/** Compatibility entry point restored after the interrupted context refactor. */
export async function buildGuardCtx(
  event: Event,
  sessionId: string,
  phase: string,
  authorInputs?: AuthorInputs,
  codeDeps?: CodeEvidenceDeps,
  deployDeps?: DeployEvidenceDeps,
  frontendDeps?: FrontendEvidenceDeps,
  approvedArtifactWrites?: readonly string[],
  audits: Readonly<
    Record<string, { binding: AuditBinding; policy?: ScopeAuditPolicy | null }>
  > = {},
): Promise<Map<string, unknown>> {
  const base = await buildBaseGuardContext(event, sessionId, phase, approvedArtifactWrites, audits);
  const verdictGuess = await readAuditVerdict(sessionId, 'coding-flow-guess-audit-cache');
  const verdictSpec = await readAuditVerdict(sessionId, 'coding-flow-spec-audit-cache');
  base.values.set('verdict.guess', verdictGuess);
  base.values.set('verdict.spec', verdictSpec);
  base.values.set('verdict', { guess: verdictGuess, spec: verdictSpec });
  return extendFullstackGuardContext(
    base,
    event,
    sessionId,
    authorInputs,
    codeDeps,
    deployDeps,
    frontendDeps,
  );
}

/**
 * F1 (fork decision): NO-OP Bus stub for kernel.applyAction gate decisions.
 * There is no live Bus in a hook subprocess (`host.ts:131`).
 * `bus.publish` is a no-op until a real Bus is reachable; durable INV2 observability stays via `appendTransition`.
 */
const NOOP_BUS = { publish: () => undefined } as unknown as Bus;

// Reporting cadence, labels, evidence, phase charts, goal enrichment, and summaries are compiled pack data.

async function readLatestArtifactPath(sessionId: string): Promise<string | null> {
  try {
    return (await readCheckpointBySession(sessionId))?.scopeArtifacts.at(-1) ?? null;
  } catch {
    return null;
  }
}

/** Preserve the existing once-per-task CODE report arbitration across transition and completion paths. */
async function claimCodeReport(sessionId: string, taskId: string, now: string): Promise<boolean> {
  const path = sessionStateFile(sessionId, `complete-reported-${taskId}`);
  try {
    await readFile(path, 'utf8');
    return false;
  } catch {
    // Not claimed yet.
  }
  try {
    await atomicWriteFile(path, now);
  } catch {
    // Reporting is fail-open.
  }
  return true;
}

/**
 * Run every ACTIVE v2 cartridge over `event` and return the merged decision (most-severe exit wins). ADDITIVE:
 * returns ZERO when there are no active v2 cartridges, so a caller merging this into the v1 decision is a no-op.
 */
type TransitionReaction = NonNullable<Reactions['on_enter']>[string][number];

async function runTransitionReaction(
  reaction: TransitionReaction,
  sessionId: string,
  taskId: string | null,
  now: string,
  approvedArtifactPath?: string,
): Promise<void> {
  switch (reaction) {
    case 'freeze_captured_ask':
      await freezeAsk(sessionId);
      return;
    case 'reset_captured_ask':
      await resetAsk(sessionId);
      return;
    case 'reconcile_decomposition': {
      const artifact = approvedArtifactPath ?? (await readLatestArtifactPath(sessionId));
      const extracted = artifact === null ? null : await extractScope(artifact);
      if (
        artifact === null ||
        extracted === null ||
        extracted.authoredElements.length === 0 ||
        taskId === null
      ) {
        return;
      }
      const wg = await openWg(sessionId);
      await reconcileDecomposition(wg, taskId, artifact, extracted);
      return;
    }
    case 'ensure_acceptance': {
      if (taskId === null) return;
      const existing = await readAcceptance(sessionId);
      if (!existing.some((item) => item.id === taskId)) {
        await appendAcceptance(sessionId, {
          id: taskId,
          taskId,
          status: 'waiting',
          addedAt: now,
        });
      }
      return;
    }
    case 'reset_verification_loop':
      if (taskId !== null) {
        await resetBugfixRounds(sessionId, taskId);
        await recordNeedsRedesign(sessionId, taskId, false);
      }
      return;
  }
}

async function runTransitionReactions(
  reactions: Reactions | undefined,
  transition: { from: string; to: string },
  sessionId: string,
  taskId: string | null,
  now: string,
  approvedArtifactPath?: string,
): Promise<void> {
  const actions = [
    ...(reactions?.on_leave?.[transition.from] ?? []),
    ...(reactions?.on_enter?.[transition.to] ?? []),
  ];
  for (const action of actions) {
    try {
      await runTransitionReaction(action, sessionId, taskId, now, approvedArtifactPath);
    } catch (error) {
      process.stderr.write(
        `[v2-supply] transition reaction '${action}' failed (ignored): ${String(error)}\n`,
      );
    }
  }
}

async function resolveSeededActorState(
  sessionId: string,
  actor: V2ObservedActor,
  packName: string,
  taskId: string | null,
): Promise<string> {
  let seededState = await readFsmState(sessionId, packName, actor.fsm, taskId);
  if (process.env.OPENSQUID_AUTOMATION === '1' && seededState === actor.fsm.initial) {
    try {
      const checkpoint = await readCheckpointBySession(sessionId);
      if (checkpoint !== null && actor.fsm.states.includes(checkpoint.stage)) {
        seededState = checkpoint.stage;
      }
    } catch (error) {
      process.stderr.write(`[v2-supply] task-checkpoint seed failed (ignored): ${String(error)}\n`);
    }
  }
  return seededState;
}

/** Resolve and persist active pack-owned FSM starting states before lifecycle dispatch. */
export async function initializeV2Cartridges(
  sessionId: string,
  now: string,
  cwd: string = process.cwd(),
): Promise<void> {
  for (const loaded of await loadActiveV2Cartridges(sessionId, cwd)) {
    if (loaded.compiled.fsm === undefined) continue;
    const actor = new V2ObservedActor(`pack:${loaded.pack.name}`, loaded);
    const taskId = await readActiveTaskId(sessionId);
    const state = await resolveSeededActorState(sessionId, actor, loaded.pack.name, taskId);
    await persistActorState(sessionId, loaded.pack.name, state, now, taskId);
  }
}

export async function runV2Cartridges(
  sessionId: string,
  event: Event,
  now: string,
  options?: {
    /**
     * When true, enforce the current state's write lane and any gate that the pack explicitly binds to this
     * event, without advancing state or logging transitions. Core never rewrites the event kind to manufacture
     * an earlier gate trigger: a `post_tool_call` gate remains post-tool policy, while a pack-declared
     * `tool_call` gate may block before execution. This keeps trigger timing pack-owned.
     */
    enforceOnly?: boolean;
  },
): Promise<V2Decision> {
  const enforceOnly = options?.enforceOnly ?? false;
  const cartridges = await loadActiveV2Cartridges(sessionId);
  if (cartridges.length === 0) return ZERO; // INERT — the nothing-breaks path (no active v2 pack today)
  // AD.1 capture (coordinated with T2.4): when a v2 cartridge is active, every user prompt appends to the
  // per-task captured ask (no-op once frozen / on a duplicate). This is what makes `scope.anchors_ok` have a
  // populated ask to verify against — captured_ask.ts is shipped but had NO callers (dormant); this wires it.
  if (event.kind === 'prompt_submit') {
    try {
      await appendAsk(sessionId, event.prompt);
    } catch (err) {
      // FAIL-OPEN: capture plumbing must never break the hook (observe-never-breaks).
      process.stderr.write(`[v2-supply] captured-ask append failed (ignored): ${String(err)}\n`);
    }
  }
  // T2.7 LIVE WIRING (the fix for the FSM stalling at CODE): once the active task's 7 phases are complete, RECORD
  // the readiness result so `code.readiness_ran` + `code.deprecated_clean` become real and the CODE gate can
  // advance CODE→DEPLOY. Cheap (staged-file deprecated scan, NO CodeIndex) + FAIL-OPEN. Re-scans while a
  // deprecated hit remains (so a fix clears it — no permanent block); skips once recorded clean.
  if (event.kind === 'post_tool_call') {
    try {
      const taskId = await readActiveTaskId(sessionId);
      const cwd = 'cwd' in event ? (event as { cwd?: unknown }).cwd : undefined;
      if (taskId !== null && typeof cwd === 'string' && cwd !== '') {
        const cur = await readinessResult(sessionId, taskId);
        if (
          !(cur.ran && cur.deprecatedClean) &&
          isComplete(await readPhaseState(sessionId), taskId)
        ) {
          await recordReadiness(sessionId, taskId, await gatherReadiness(cwd));
        }
      }
    } catch (err) {
      process.stderr.write(`[v2-supply] readiness record failed (ignored): ${String(err)}\n`);
    }
  }
  // GFR.4 / E2 LIVE WIRING — record an external CONSULTATION when the just-run tool is an external-source tool
  // (WebSearch / WebFetch / an MCP web-fetcher, `isExternalConsultTool`). The WINDOW is derived from the 7-phase
  // ledger: once the `code` phase is logged the consult is a POST-code AUDIT (`after`, E2a); before that it is a
  // pre-code read (`before`, E2c/E2d). This is what makes the audit a genuine SECOND research run — a consult
  // can only land in `after` after coding. Cheap (a state read + write) + FAIL-OPEN (observe-never-breaks).
  if (event.kind === 'post_tool_call' && 'tool' in event && isExternalConsultTool(event.tool)) {
    try {
      const taskId = await readActiveTaskId(sessionId);
      if (taskId !== null) {
        const st = await readPhaseState(sessionId);
        const window = st?.task_id === taskId && st.phases.includes('code') ? 'after' : 'before';
        await recordExternalConsult(sessionId, taskId, window);
      }
    } catch (err) {
      process.stderr.write(
        `[v2-supply] external-consult record failed (ignored): ${String(err)}\n`,
      );
    }
  }
  // DBL.1b + scope-1/scope-2 — record the DETERMINISTIC deploy verification records: when the agent runs EXACTLY
  // the project's configured `verifyCommand` (DBL.1b, additive smoke/e2e) OR its declared `verifySuite` (scope-1,
  // the MANDATORY FLOOR = the whole pre-push suite), capture the REAL exit code (never a self-report). The deploy
  // procedure dictates the exact commands, so the verbatim match is reliable. scope-2 (§5.3): a RED suite re-run
  // BUMPS the bug-fix round count — so the DEPLOY-local fix loop is bounded (it hits the cap → bugfix_exhausted →
  // human) even though it never leaves DEPLOY. FAIL-OPEN on any read/record error (observe-never-breaks).
  if (event.kind === 'post_tool_call' && 'tool' in event && event.tool === 'Bash') {
    try {
      const cwd = 'cwd' in event ? (event as { cwd?: unknown }).cwd : undefined;
      const command = 'args' in event ? (event.args as { command?: unknown }).command : undefined;
      if (typeof cwd === 'string' && cwd !== '' && typeof command === 'string') {
        const scopeRoot = await resolveProjectScopeRoot(cwd);
        const verifyCmd = await readActiveVerifyCommand(scopeRoot);
        const suiteCmd = await readActiveVerifySuite(scopeRoot);
        const archCmd = await readActiveArchDetector(scopeRoot);
        const taskId = await readActiveTaskId(sessionId);
        const cmd = command.trim();
        const passed = (event as { exit_code?: number }).exit_code === 0;
        if (taskId !== null) {
          if (verifyCmd !== null && cmd === verifyCmd.trim()) {
            await recordVerification(sessionId, taskId, passed);
          }
          if (suiteCmd !== null && cmd === suiteCmd.trim()) {
            await recordSuite(sessionId, taskId, passed);
            // scope-2 §5.3 — DEPLOY-local round accounting: a red suite re-run is one fix round. Counting the
            // suite re-run (not only a verify→author transition) bounds the in-place loop, so an unfixable
            // mechanical failure escalates at the cap instead of looping forever inside `deploy_fix`.
            if (!passed) await bumpBugfixRounds(sessionId, taskId);
          }
          // AQG.4 (T-arch-quality-gate) — record the arch-detector exit code ONLY on a verbatim match of the
          // declared command (a sibling of the suiteCmd branch); `code.arch_clean` reads this record.
          if (archCmd !== null && cmd === archCmd.trim()) {
            await recordArch(sessionId, taskId, passed);
          }
        }
      }
    } catch (err) {
      process.stderr.write(`[v2-supply] verify/suite record failed (ignored): ${String(err)}\n`);
    }
  }
  let exitCode: 0 | 2 = 0;
  const messages: string[] = [];
  const injections: string[] = [];
  const boundSkills: string[] = [];
  // LAYER-1 #37 (project-only-operation.md:139-147) — resolve the CURRENT task's classified DOMAIN once, used to
  // serves-gate each FSM cartridge below. Two sources, mirroring dispatch.ts's Layer-3 lens gate so pack
  // governance (Layer 1) and lens firing (Layer 3) select consistently: (a) the turn's classified facets,
  // persisted at prompt_submit (writeClassifiedFacets); (b) when none carry a domain yet — first tool_call /
  // read error — the project's DECLARED domain (orchestrator_settings). `null` (neither known) → the gate below
  // FAILS OPEN (every cartridge runs, today's behavior). Read ONCE, outside the cartridge loop.
  let turnDomain: string | null = null;
  try {
    const facets = await readClassifiedFacets(sessionId);
    if (facets?.domain !== undefined) {
      turnDomain = facets.domain;
    } else {
      const projectDir = (await readSessionCwd(sessionId)) ?? process.cwd();
      const { domain } = await readSettings(projectDir);
      if (domain !== undefined) turnDomain = domain;
    }
  } catch (err) {
    // FAIL-OPEN: a settings/facets read error must never break the hook → turnDomain stays null (every pack runs).
    process.stderr.write(`[v2-supply] task-domain resolve failed (ignored): ${String(err)}\n`);
  }
  for (const loaded of cartridges) {
    try {
      if (loaded.compiled.fsm === undefined) continue; // foundation cartridge → not an observed actor
      const name = loaded.pack.name;
      // LAYER-1 #37 — serves-gate the FSM cartridge to the current task's DOMAIN. A serves-bearing FSM pack
      // (fullstack-flow: `serves.domain = coding`) governs ONLY when the task's classified domain is at-or-below
      // its served domain (hierarchical `contains`); a task OUTSIDE that domain selects it NOT — no FSM, no gate,
      // no enforcement (the doc's Layer-1 correction: "a task that matches no pack's serves selects nothing").
      // DOMAIN-ONLY (intent-agnostic, like the Layer-3 lens gate) so governance holds across a coding task's
      // mixed-intent turns (produce/inform/decide), not just the produce turn that ACTIVATED the pack. A
      // serves-LESS FSM pack is the always-on governance spine (never gated). `turnDomain` null → FAIL OPEN
      // (runs — today's behavior). This SUBSUMES #34: a non-coding task now selects NEITHER fullstack-flow NOR
      // its frontend lenses (the lens half is the same containment gate one layer down, dispatch.ts).
      if (
        loaded.pack.serves !== undefined &&
        turnDomain !== null &&
        !skillServesDomainMatches(loaded.pack.serves, turnDomain)
      ) {
        continue;
      }
      const actor = new V2ObservedActor(`pack:${name}`, loaded);
      // T2.2 (principle 9) — key the FSM PER-TASK. `taskId` is null until a task is active, so SCOPE/PLAN
      // share the session-level key `fsm-<pack>`; once a task is active, AUTHOR/CODE run on the isolated
      // key `fsm-<pack>-<taskId>` that STARTS at the FSM initial state — activating task B never rewinds
      // task A's FSM ([[coding-flow-task-start-reset-trap]]). The persist below uses the SAME taskId.
      const taskId = await readActiveTaskId(sessionId);
      const seededState = await resolveSeededActorState(sessionId, actor, name, taskId);
      actor.state.current = seededState;
      const auditEntries = await Promise.all(
        Object.entries(loaded.pack.audits ?? {}).map(async ([channel, binding]) => {
          const policy =
            binding.subject === 'approved_artifact'
              ? await readAuditPolicy(name, loaded.skills ?? [], binding)
              : undefined;
          return [channel, { binding, ...(policy === undefined ? {} : { policy }) }] as const;
        }),
      );
      const audits = Object.fromEntries(auditEntries);
      const approvedBindings = Object.values(loaded.pack.audits ?? {}).filter(
        (binding) => binding.subject === 'approved_artifact',
      );
      const approvedArtifactWrites =
        approvedBindings.length === 1 ? approvedBindings[0]?.writes : undefined;
      const baseContext = await buildBaseGuardContext(
        event,
        sessionId,
        actor.state.current,
        approvedArtifactWrites,
        audits,
      );
      const ctx = await extendFullstackGuardContext(baseContext, event, sessionId);
      // `enforceOnly` never changes trigger timing. The pack's declared trigger is authoritative: lanes are
      // checked below for every pre-tool mutation, but a post-tool completeness gate must not be promoted into
      // a pre-tool prohibition that prevents the stage's work from producing its own evidence.
      const curMeta = loaded.compiled.meta[actor.state.current];
      // LANE MODEL enforcement (the #33 successor to advance-action detection). Under enforceOnly (PreToolUse
      // + automation), a MUTATING file-write whose target falls OUTSIDE the CURRENT stage's declared `writes:`
      // lane is BLOCKED — "stay in your stage's lane." This is SEPARATE from the completeness gate below (the
      // gate decides WHEN the FSM advances; the lane decides WHERE a stage may write, per tool call). Reads
      // never block (evaluateLane → checked:false), and a laneless stage is inert. Actor identity does not
      // exempt an executor from the selected pack's lane. A blocked lane write short-circuits gate evaluation.
      if (enforceOnly && exitCode !== 2) {
        const evTool = 'tool' in event && typeof event.tool === 'string' ? event.tool : '';
        const evArgs: Record<string, unknown> = 'args' in event ? event.args : {};
        const lane = evaluateLane(curMeta?.writes, evTool, evArgs);
        if (lane.checked && lane.outOfLane && lane.path !== null) {
          exitCode = 2;
          messages.push(laneBlockMessage(actor.state.current, lane.path, curMeta?.writes ?? []));
          continue; // out-of-lane write denied — skip this cartridge's gate eval (the tool won't run)
        }
      }
      const env: Envelope = {
        seq: 0,
        from: `pack:${name}`,
        to: `pack:${name}`,
        kind: event.kind,
        // R-AUDIT-CTX: phase = the cartridge's current FSM state (pre-receive); verdicts read fail-open.
        payload: { ctx },
        ts: Date.parse(now),
      };
      // SKILL.1 (R-SKILLS-PER-STATE): one runtime per cartridge; `onStateLeave` on each transition, then bind
      // the CURRENT (post-receive) state on EVERY event — the state IS the router (not only on transitions).
      const skillRuntime = new InMemorySkillRuntime();
      let expectedPersistedState = seededState;
      let transitionAccepted = true;
      for (const e of await actor.receive(env)) {
        if (!transitionAccepted) continue;
        if (e.kind === 'write_state') {
          // enforceOnly: NO state persistence (gate-check-only — PreToolUse; PostToolUse owns the advance).
          if (!enforceOnly) {
            transitionAccepted = await persistActorState(
              sessionId,
              name,
              e.state,
              now,
              taskId,
              expectedPersistedState,
            );
            if (!transitionAccepted) {
              actor.state.current = await readFsmState(sessionId, name, actor.fsm, taskId);
              continue;
            }
            expectedPersistedState = e.state;
            // Automated StageProcesses stop at a session-local gate receipt; the deterministic coordinator reads
            // that receipt after exit and alone advances the durable issue checkpoint. Interactive human work has
            // no outer loop process, so its accepted transition is projected here to establish the handoff.
            if (process.env.OPENSQUID_AUTOMATION !== '1') {
              try {
                const key = await resolveCheckpointKey(sessionId);
                if (key !== null) {
                  await upsertTaskStage(
                    key,
                    e.state,
                    Date.parse(now),
                    baseContext.approvedArtifactPath ?? (await readLatestArtifactPath(sessionId)),
                  );
                }
              } catch (err) {
                process.stderr.write(
                  `[v2-supply] interactive task-checkpoint write failed (ignored): ${String(err)}\n`,
                );
              }
            }
          }
        } else if (!enforceOnly && e.kind === 'emit' && e.messageKind === 'transition') {
          // INV2 in-process observability — the cited v1 durable equivalent of the bus transition.
          const p = e.payload as { from: string; to: string };
          // Live progress surfaces over the StageProcess stderr relay without creating model hierarchy.
          process.stderr.write(`[lap ${name}] ${p.from} → ${p.to}\n`);
          await appendTransition({
            session: sessionId,
            pack: name,
            from: p.from,
            to: p.to,
            on: event.kind,
            at: now,
            via: -1,
          });
          // T2.12 / CADENCE-IN-PACK — the LIVE per-stage report trigger. On each transition LEAVING a stage, emit
          // that stage's after-report (dated <project>/.opensquid/reports/ file + memory mirror + in-session injection +
          // best-effort chat) — but ONLY when the pack declares `report:` for the LEAVING state (`meta[p.from].report`).
          // The cadence (which stages report) is PACK DATA now, not the deleted core `STAGE` map. FAIL-OPEN: a report
          // failure must NEVER break the hook. T2.9 double-emit guard: in an autonomous lap (OPENSQUID_AUTOMATION=1)
          // loop_driver.onPhasesComplete owns the CODE report, so skip the CODE report HERE to avoid a duplicate;
          // interactively (no env) v2_supply remains the CODE emitter. Other reporting stages always emit here.
          let stage = loaded.compiled.meta[p.from]?.report;
          if (stage === 'CODE' && process.env.OPENSQUID_AUTOMATION === '1') stage = undefined;
          if (stage !== undefined) {
            try {
              const root = await readSessionCwd(sessionId);
              if (
                root !== null &&
                (stage !== 'CODE' ||
                  (await claimCodeReport(sessionId, taskId ?? 'no-active-task', now)))
              ) {
                // T2.10 — the SCOPE report's goal-alignment line (the live consumer of goalConsult). Only the
                // SCOPE stage carries it (the destination check belongs at scope-time); other stages leave it
                // undefined → no `## Goal alignment` line. ADVISORY (surfaced, never a block — the anti-drift
                // gate is checkAnchors). FAIL-OPEN is the surrounding try/catch.
                // STAGE-WORK (generic): the next state's pack-declared `does:` text (pack data, NOT a core map).
                const nextWork = loaded.compiled.meta[p.to]?.does;
                const r = {
                  stage,
                  taskId: taskId ?? 'no-active-task',
                  summary: `${p.from} complete`,
                  nextDirective: p.to,
                  // T2.12-evidence — GENERIC: the leaving gate's DECLARED `reads:` keys (pack data), rendered
                  // from the just-evaluated guard ctx (was a hardcoded per-stage switch, now deleted from core).
                  evidence: stageEvidence(ctx, loaded.compiled.meta[p.from]?.reads ?? []),
                  // `Next → <state>: <work>` — the next stage's `does:` (exactOptionalPropertyTypes: present only
                  // when defined, never an explicit `undefined`).
                  ...(nextWork !== undefined ? { nextWork } : {}),
                  ...(loaded.compiled.meta[p.from]?.reportPhases === true
                    ? {
                        phases: (loaded.compiled.meta[p.from]?.phases ?? []).map((name) => ({
                          name,
                          done: true,
                        })),
                      }
                    : {}),
                  ...(loaded.compiled.meta[p.from]?.goalAlignment === true
                    ? { goalAligned: (await goalConsult(sessionId, root)).aligned }
                    : {}),
                };
                const { body } = renderStageReport(r, now); // RD.1 — PURE render (no disk; emitStageReport is gone)
                displayReport(body); // RD.1 — SHOW the after-stage body LIVE on the loop terminal (stderr →
                // onStderrLine), REPLACING the old "report emitted" notice. The report is displayed, never filed.
                // T2.12-surface: SHOW the phase report in-session too (the injections the hooks emit as
                // additionalContext). LSF.4: the telegram push was removed — visibility is the status line / Monitor.
                injections.push(body);
                // The caller mirrors `body` into memory (session-scoped wedge buffer — the real in-runtime
                // memory write available here; no ToolContext/RagBackend at this layer). FAIL-OPEN.
                await capturePendingLesson(sessionId, {
                  id: `stage-report-${stage.toLowerCase()}-${r.taskId}-${now.replaceAll(':', '-')}`,
                  type: 'workflow',
                  content: body,
                  sourceContext: `v2 stage transition ${p.from} → ${p.to} (task ${r.taskId})`,
                  confidence: 1,
                  proposedAt: now,
                  author: 'agent',
                });
              }
            } catch (err) {
              process.stderr.write(
                `[v2-supply] stage report emit/mirror failed (ignored): ${String(err)}\n`,
              );
            }
          }
          // CADENCE-IN-PACK — the BEFORE-stage SUMMARY (§6.1's "tell me what you'll be working on"). On the
          // ENTRY-EDGE of a transition (entering `p.to`), when the pack declares `summary: true` for that state,
          // emit a lightweight "Starting <STAGE> · will: <what it does>" note. TRANSITION-PRECISE: this fires
          // exactly ONCE per stage ENTRY (it is inside the per-transition effect loop, keyed on `p.to`) — NOT on
          // every event like onStateEntry (which re-binds skills each hook). The label reuses the entered state's
          // `report:` (so `summary:true` with no `report` is inert). Lightweight orientation: injection + chat,
          // NOT a durable dated file (the after-report is the durable artifact). FAIL-OPEN in its own try/catch.
          const enteringLabel =
            loaded.compiled.meta[p.to]?.summary === true
              ? loaded.compiled.meta[p.to]?.report
              : undefined;
          if (enteringLabel !== undefined) {
            try {
              const root = await readSessionCwd(sessionId);
              if (root !== null) {
                // STAGE-WORK (generic): the entered state's pack-declared `does:` text (pack data, NOT a core map).
                const enteringWork = loaded.compiled.meta[p.to]?.does;
                const { body } = renderStageSummary(
                  enteringLabel,
                  enteringWork,
                  taskId ?? 'no-active-task',
                  now,
                );
                displayReport(body); // RD.2 — SHOW the before-stage "Starting <STAGE> · Will: …" half LIVE too
                // (the same stderr → onStderrLine channel as the after half); it was injection-only before.
                injections.push(body);
                // LSF.4 — telegram push removed; the summary surfaces in-session, visibility via the status line.
                // V2-ENF.2/7 — the FOLLOW-INSTRUCTIONS anti-drift nudge (reporting-model §5.4c): at the stage
                // boundary, re-assert "stay on the <stage> procedure" so the lap drives the injected procedure,
                // not freehand. SURFACED-only (ephemeral injection, never a saved file; never `🦑`). Gated on a
                // present `does:` so the nudge never renders the literal "undefined" (the pack declares the work).
                if (enteringWork !== undefined && enteringWork.trim().length > 0) {
                  injections.push(
                    renderFollowReminder({ stage: enteringLabel, procedure: enteringWork }),
                  );
                }
              }
            } catch (err) {
              process.stderr.write(
                `[v2-supply] stage summary emit failed (ignored): ${String(err)}\n`,
              );
            }
          }
          await runTransitionReactions(
            loaded.compiled.reactions,
            p,
            sessionId,
            taskId,
            now,
            baseContext.approvedArtifactPath,
          );
          onStateLeave(p.from, skillRuntime); // SKILL.1: unloaded on leave
        } else if (e.kind === 'emit' && e.messageKind === 'gate_action') {
          // PART B — route through the ONE kernel (gate/kernel.ts) instead of the duplicate inline table.
          // F1: bus is the NOOP_BUS stub (no live Bus in a hook subprocess); durable INV2 stays via appendTransition.
          const p = e.payload as { action: Action; failureType: string; message: string };
          const effect = applyAction(
            p.action,
            p.failureType,
            { [p.failureType]: p.message },
            { bus: NOOP_BUS, from: `pack:${name}` },
          );
          if (effect.exitCode === 2) {
            // In enforceOnly (PreToolUse) mode, a failing gate blocks mutating calls while reads remain
            // available to gather the evidence needed to satisfy the gate. Actor identity is not an exemption.
            // Non-enforceOnly (PostToolUse) enforcement is unchanged.
            const evTool = 'tool' in event && typeof event.tool === 'string' ? event.tool : '';
            const evArgs = 'args' in event ? event.args : {};
            if (!enforceOnly || isMutatingCall(evTool, evArgs)) {
              exitCode = 2; // block | halt → ENFORCE; the deny IS the observation (gate/kernel.ts:37-43)
              if (effect.message !== undefined) messages.push(effect.message);
              // V2-ENF.2/6 (§5.4b) — a gate that HOLDS is a FAILURE, and a silent hold is undiagnosable (the
              // wedge-with-no-cause pain the design cites). So render a `held_gate` FAILURE REPORT stating the
              // REASON (the held gate + the evidence that failed it + the resolving action), SAVE it under
              // <project>/.opensquid/reports/, and SURFACE it — the in-session injection + the live
              // subprocess→session channel (stderr) + best-effort chat. This is BOTH the saved record AND the
              // content that feeds the escalation interrupt (§5.5). FAIL-OPEN: a report failure must NEVER
              // change the block decision (the deny already stands via exitCode/messages above). The saved file
              // dedups by `failure-<taskId>-<date>.md`, so a parked gate overwrites one file per task per day.
              try {
                const root = await readSessionCwd(sessionId);
                if (root !== null) {
                  const { path, body } = renderFailureReport(
                    {
                      taskId: taskId ?? 'no-active-task',
                      kind: 'held_gate',
                      reason: effect.message ?? p.message,
                      criterion: `pack:${name} gate '${actor.state.current}' (${p.failureType})`,
                      evidence: p.message,
                      resolvingAction: `satisfy the ${actor.state.current} gate's requirement, then re-run`,
                    },
                    now,
                  );
                  await saveProjectReport(root, path, body);
                  process.stderr.write(
                    `[lap ${name}] ✗ gate held at ${actor.state.current} — failure report emitted\n`,
                  );
                  injections.push(body);
                  // LSF.4 — telegram push removed; the failure report surfaces in-session + saves to disk.
                }
              } catch (err) {
                process.stderr.write(
                  `[v2-supply] failure report emit failed (ignored): ${String(err)}\n`,
                );
              }
            }
          } else if (effect.message !== undefined && !enforceOnly) {
            // warn nudge (exitCode 0): in observational mode (PostToolUse) surface as additionalContext.
            // enforceOnly skips warn — PostToolUse owns the observational warn injection.
            injections.push(effect.message);
          }
        }
      }
      // actor.state.current is the final (post-event) state (v2_observed_actor.ts:97) → bind skills(S) every event.
      onStateEntry(actor.state.current, loaded.compiled.meta, skillRuntime);
      boundSkills.push(...skillRuntime.current().skills);
    } catch (err) {
      // FAIL-OPEN: a v2 cartridge bug must NEVER break the hook (observe-never-breaks discipline).
      process.stderr.write(`[v2-supply] cartridge error (ignored): ${String(err)}\n`);
    }
  }
  // Preserve the existing interactive completion-report fallback. Automated StageProcesses report on their
  // gate transition through the outer loop; this path exists only for an interactive log_phase completion.
  if (
    event.kind === 'post_tool_call' &&
    process.env.OPENSQUID_AUTOMATION !== '1' &&
    'tool' in event &&
    typeof event.tool === 'string' &&
    event.tool.includes('log_phase')
  ) {
    try {
      const trackId = await readActiveTaskId(sessionId);
      const active = await readActiveTask(sessionId);
      const root = await readSessionCwd(sessionId);
      if (
        trackId !== null &&
        active !== null &&
        root !== null &&
        isComplete(await readPhaseState(sessionId), active.id) &&
        (await claimCodeReport(sessionId, trackId, now))
      ) {
        const code = await codeEvidenceForSession(sessionId);
        const { body } = renderStageReport(
          {
            stage: 'CODE',
            taskId: trackId,
            summary: 'task complete — all 7 phases logged',
            nextDirective: 'deploy',
            nextWork: 'verify deploy capability, then the human-accept gate',
            evidence: [
              { label: 'phases_complete', ok: code.phasesComplete },
              { label: 'readiness_ran', ok: code.readinessRan },
              { label: 'deprecated_clean', ok: code.deprecatedClean },
              { label: 'suite_green', ok: code.suiteGreen },
            ],
            phases: CODE_PHASES.map((name) => ({ name, done: true })),
          },
          now,
        );
        displayReport(body);
        injections.push(body);
        await capturePendingLesson(sessionId, {
          id: `stage-report-code-${trackId}-${now.replaceAll(':', '-')}`,
          type: 'workflow',
          content: body,
          sourceContext: `v2 per-task completion (task ${trackId})`,
          confidence: 1,
          proposedAt: now,
          author: 'agent',
        });
      }
    } catch (err) {
      process.stderr.write(`[v2-supply] completion report failed (ignored): ${String(err)}\n`);
    }
  }
  return { exitCode, messages, injections, boundSkills };
}
