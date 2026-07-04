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
import { atomicWriteFile } from '../../storage/atomic_file.js';
import { appendAsk, freezeAsk, resetAsk } from '../coverage/captured_ask.js';
import { persistActorState, readFsmState } from '../fsm_state.js';
import { withTaskCheckpointStore } from '../ralph/loop_stage.js';
import { resolveCheckpointKey } from './checkpoint_key.js';
import { appendTransition } from '../observe/transition_log.js';
import { resolveProjectScopeRoot, sessionStateFile } from '../paths.js';
import { readActiveVerifyCommand } from '../../packs/discovery.js';
import {
  bumpBugfixRounds,
  readBugfixRounds,
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
import { CODE_PHASES, emitStageReport, renderStageSummary } from './stage_report.js';
import type { EvidenceRef } from '../../packs/schemas/pack_v2.js';
import { sendChat } from '../../chat_daemon/client.js';
import {
  loadChannelsConfig,
  resolveConfiguredChannel,
  resolveUmbrellaForCwd,
} from '../../channels/routing.js';

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
    const expect = typeof r === 'string' ? true : r.expect ?? true;
    const dot = key.indexOf('.');
    const shortLabel = dot >= 0 ? key.slice(dot + 1) : key; // key minus its `<state>.` prefix
    const label = typeof r === 'string' ? shortLabel : r.label ?? shortLabel;
    return { label, ok: ctx.get(key) === expect };
  });
}

export async function surfaceReportToChat(cwd: string, body: string): Promise<void> {
  try {
    const cfg = await loadChannelsConfig().catch(() => null);
    if (cfg === null) return;
    const umbrellaId = resolveUmbrellaForCwd(cfg, cwd);
    if (umbrellaId === null || umbrellaId === '') return;
    // Resolve cwd → the daemon's LITERAL wire channel (`<platform>:<native_id>` + string threadId) BEFORE
    // sending. The old `project:telegram` shorthand is REJECTED by the daemon's gateway.parseChannel
    // (platform `project` is not a wire platform), so every push silently failed (swallowed by the catch).
    // Platform-agnostic: the `<platform>` prefix comes from the configured pointer in channels.json
    // (`cfg.platform`, default telegram) — NOT hardcoded here, so another chat app is a config edit.
    const resolved = resolveConfiguredChannel(cfg, umbrellaId);
    if (resolved === null) return;
    await sendChat({
      channel: resolved.channel,
      text: body,
      ...(resolved.threadId !== undefined ? { threadId: resolved.threadId } : {}),
    });
  } catch {
    /* fail-open: chat is optional — never break the hook over it */
  }
}
import { authorEvidenceForSession, type AuthorInputs } from './author_evidence.js';
import { codeEvidenceForSession, type CodeEvidenceDeps } from './code_evidence.js';
import { frontendEvidenceForEvent, type FrontendEvidenceDeps } from './frontend_evidence.js';
import { deployEvidenceForSession, type DeployEvidenceDeps } from './deploy_evidence.js';
import { planEvidence, openWg } from './plan_evidence.js';
import { autoDecompose } from './auto_decompose.js';
import { buildCoveredBy } from './plan_audit.js';
import { extractScope } from './scope_extract.js';
import { gatherReadiness, recordReadiness, readinessResult } from './readiness.js';
import { externalNeededForSession } from './external_dependency_evidence.js';
import {
  externalConsultResult,
  isExternalConsultTool,
  recordExternalConsult,
  type ExternalConsult,
} from './external_consult.js';
import { appendAcceptance, readAcceptance } from './acceptance.js';
import { scopeEvidence } from './scope_evidence.js';
import { isComplete, readPhaseState } from '../workflow_phases.js';
import { V2ObservedActor } from './v2_observed_actor.js';

import { applyAction } from '../gate/kernel.js';
import type { Action } from '../gate/kernel.js';
import type { Bus } from '../bus/bus.js';
import type { Envelope, MessageKind } from '../bus/types.js';
import type { Event } from '../event.js';
import { isMutatingCall } from '../guard/orchestrator_guard.js';
import { evaluateLane, laneBlockMessage, matchesLane } from './write_lane.js';

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

/**
 * F1 (fork decision): NO-OP Bus stub for kernel.applyAction gate decisions.
 * There is no live Bus in a hook subprocess (`host.ts:131`).
 * `bus.publish` is a no-op until a real Bus is reachable; durable INV2 observability stays via `appendTransition`.
 */
const NOOP_BUS = { publish: () => undefined } as unknown as Bus;

// T2.12 / CADENCE-IN-PACK — the reporting cadence (WHICH stages report, entry-summary vs leave-report) is now
// PACK DATA, not a hardcoded core map. Each gate state declares `report:` (the after-stage report label emitted
// on LEAVE) and `summary: true` (a before-stage summary emitted on ENTRY-edge) in pack.yaml. This module keeps
// only the transition-precise EXECUTOR + the emit FUNCTIONS (emitStageReport / renderStageSummary /
// surfaceReportToChat) — opensquid provides the functions; the pack owns the cadence. The former hardcoded
// `STAGE` map was deleted; `meta[state].report` is its per-state, in-pack replacement.
// CODE double-emit: under an autonomous lap (OPENSQUID_AUTOMATION=1) loop_driver.onPhasesComplete owns the CODE
// after-report, so the emit site below still skips the CODE report (not the summary) under that env (T2.9 wiring).

// T2.5 — the session-state key holding the CAPTURED pre-research artifact path. Stamped on the SCOPE advance
// (a Write/Edit of a `docs/research/*-pre-research-*` file) so the later PLAN gate can `extractScope` the SAME
// artifact (the INDEPENDENT design-element universe) without a live advance event in hand.
const PRE_RESEARCH_PATH_KEY = 'fullstack-flow-pre-research-path';

/** DBL.2 — the bug-fix loop's round cap: after this many deploy→author cycles without reaching clean, the VERIFY
 *  decision escalates to the human (ACCEPT) instead of looping again. Bounds a genuinely-unfixable bug. */
const MAX_BUGFIX_ROUNDS = 3;

/** FAIL-OPEN read of a coding-flow audit-cache verdict (mirrors handoff/collect.ts readJsonState+auditHead):
 *  the flat `{ verdict: string }` shape; ANY error → undefined (observe-never-breaks). */
async function readVerdict(sessionId: string, key: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(sessionStateFile(sessionId, key), 'utf8')) as {
      verdict?: unknown;
    };
    return typeof parsed.verdict === 'string' ? parsed.verdict : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Guard ctx for a v2 cartridge event (R-AUDIT-CTX) — binds the THREE pieces a discipline guard reads: the
 * `event`/`tool`, the guess/spec audit verdicts (FAIL-OPEN), and the `phase` (the cartridge's current FSM
 * state). Literal `.set` keys so the coverage binding-extractor sees them (coverage/index_build.ts).
 */
export async function buildGuardCtx(
  event: Event,
  sessionId: string,
  phase: string,
  authorInputs?: AuthorInputs,
  codeDeps?: CodeEvidenceDeps,
  deployDeps?: DeployEvidenceDeps,
  frontendDeps?: FrontendEvidenceDeps,
  // LANE MODEL — the SCOPE stage's declared write-lane (`writes:` globs). `scope.is_advance` is now
  // "the write targets the scope lane" (data-driven), REPLACING the hard-coded PRE_RESEARCH_REGEX. Absent
  // (a pack with no scope lane) → the scope-advance facets never fire (is_advance false), same as no advance.
  scopeWrites?: readonly string[],
): Promise<Map<string, unknown>> {
  const m = new Map<string, unknown>();
  m.set('event', event.kind);
  if ('tool' in event) m.set('tool', event.tool);
  const verdictGuess = await readVerdict(sessionId, 'coding-flow-guess-audit-cache');
  const verdictSpec = await readVerdict(sessionId, 'coding-flow-spec-audit-cache');
  m.set('verdict.guess', verdictGuess); // R-AUDIT-CTX: keep the flat key (ARCHITECTURE.md:290) — stays MET
  m.set('verdict.spec', verdictSpec);
  m.set('verdict', { guess: verdictGuess, spec: verdictSpec }); // T2.3 — nested, so `verdict.guess` path-resolves too
  // GFR.1 — the guess-free CONTENT-AUDIT verdict per stage (scope|plan|author|code). The `content-audit` skill
  // (packs/builtin/fullstack-flow/skills/content-audit) runs read_rubric → cached_audit on each stage's
  // advancing artifact and persists the verdict to `fullstack-flow-<stage>-audit-cache` (the SAME flat
  // `{verdict}` shape readVerdict reads). FAIL-OPEN read (readVerdict → undefined on any error;
  // observe-never-breaks) — the GATE (GFR.2) is what fails CLOSED on a non-GUESS_FREE verdict, not this read.
  // The stored verdict is the RAW audit output (contains "VERDICT: GUESS_FREE") — mirrors v1 cached_audit, so
  // the GFR.2 guards key on `contains(audit.<stage>, "VERDICT: GUESS_FREE")` (NOT `== "GUESS_FREE"`).
  // DUAL-SHAPE like the gate evidence below: a nested `audit` object (the path the guards `audit.scope ...`
  // resolve) PLUS flat `audit.*` Map keys (the coverage binding-extractor sees the literal `.set` keys).
  const auditScope = await readVerdict(sessionId, 'fullstack-flow-scope-audit-cache');
  const auditPlan = await readVerdict(sessionId, 'fullstack-flow-plan-audit-cache');
  const auditAuthor = await readVerdict(sessionId, 'fullstack-flow-author-audit-cache');
  const auditCode = await readVerdict(sessionId, 'fullstack-flow-code-audit-cache');
  m.set('audit.scope', auditScope);
  m.set('audit.plan', auditPlan);
  m.set('audit.author', auditAuthor);
  m.set('audit.code', auditCode);
  m.set('audit', { scope: auditScope, plan: auditPlan, author: auditAuthor, code: auditCode });
  m.set('phase', phase);
  // T2.4 — SCOPE gate evidence. The advance event is a Write/Edit whose target is IN the SCOPE stage's declared
  // write-lane (`scopeWrites`); only then is the SCOPE gate "advancing" (the short-circuit `!scope.is_advance`
  // passes every other event, so a gate never blocks mid-scoping). LANE MODEL: this replaces the hard-coded
  // PRE_RESEARCH_REGEX — `is_advance` is now "the write targets the scope lane" (behavior-as-data, per pack).
  // The artifact path comes from the LIVE event (no read-after-write).
  const filePath = 'args' in event ? event.args?.file_path : undefined;
  const fp =
    'tool' in event && /(?:Write|Edit)/.test(event.tool) && typeof filePath === 'string'
      ? filePath
      : '';
  const isAdvance = fp !== '' && matchesLane(fp, scopeWrites ?? []); // lane-membership, not a hard-coded regex
  // DIVERGENCE FROM THE SPEC'S FLAT-KEY SHAPE (noted): the guard grammar lexes `scope.is_advance` as a PATH
  // (target `scope`, prop `is_advance`), so it resolves against a NESTED `scope` object — a flat `scope.x` Map
  // key is invisible to the expression (it path-resolves `scope`→undefined→`!undefined`→true, defeating the
  // gate). So `scope` is bound as a nested object (the path the guard reads). The flat `scope.*` keys are ALSO
  // set so `ctx.get('scope.is_advance')` unit-asserts hold AND the coverage binding-extractor sees literal
  // `.set` keys (index_build.ts) — this is exactly T2.3's dual-shape (flat + nested), additive.
  const sc: { is_advance: boolean; anchors_ok?: boolean; depth?: number; open_question?: boolean } =
    {
      is_advance: isAdvance,
    };
  m.set('scope.is_advance', isAdvance);
  if (isAdvance) {
    const ev = await scopeEvidence(sessionId, fp);
    sc.anchors_ok = ev.anchorsOk;
    sc.depth = ev.depth;
    sc.open_question = ev.openQuestion;
    m.set('scope.anchors_ok', ev.anchorsOk);
    m.set('scope.depth', ev.depth);
    m.set('scope.open_question', ev.openQuestion);
    // T2.5 — stamp the captured pre-research path so the PLAN gate can extractScope the SAME artifact later
    // (when the live event is no longer the artifact write). Fail-open: a write failure must not break scoping.
    try {
      await atomicWriteFile(sessionStateFile(sessionId, PRE_RESEARCH_PATH_KEY), JSON.stringify(fp));
    } catch (err) {
      process.stderr.write(
        `[v2-supply] pre-research path stamp failed (ignored): ${String(err)}\n`,
      );
    }
  }
  m.set('scope', sc); // nested object — the shape the guard expression path-resolves

  // T2.5 — PLAN gate evidence. The facets come from the work-graph (issues + edges) joined against the
  // INDEPENDENT design-element universe (`extractScope` of the captured pre-research artifact). DUAL-SHAPE like
  // T2.4's `scope`: a nested `plan` object (the path the guard `plan.acyclic && plan.complete` resolves) PLUS
  // flat `plan.*` Map keys (the coverage binding-extractor sees the literal `.set` keys; unit asserts hold).
  // FAIL-CLOSED when no artifact was captured yet (planEvidence → {false,false}) — a PLAN with no scope blocks.
  const pl: { acyclic: boolean; complete: boolean } = { acyclic: false, complete: false };
  try {
    const captured = await readPreResearchPath(sessionId);
    if (captured !== null) {
      const ev = await planEvidence(sessionId, captured);
      pl.acyclic = ev.acyclic;
      pl.complete = ev.complete;
    }
  } catch (err) {
    // FAIL-CLOSED stays {false,false}; observe-never-breaks — never let a work-graph read break the hook.
    process.stderr.write(`[v2-supply] plan evidence failed (ignored): ${String(err)}\n`);
  }
  m.set('plan.acyclic', pl.acyclic);
  m.set('plan.complete', pl.complete);
  m.set('plan', pl); // nested object — the shape the guard expression path-resolves

  // T2.6 — AUTHOR gate evidence. The two facets come from the SHIPPED coverage checker (`checkCoverage`) over
  // the in-repo requirement manifest + the gated-tree CodeIndex: `manifest_complete` (no orphaned gated export)
  // ∧ `real_code` (every requirement MET — where met for reachable/binding REQUIRES its proof-test to pass,
  // check.ts:54-73, so a stub with no passing proof fails). DUAL-SHAPE like T2.4/T2.5: a nested `author` object
  // (the path the guard `author.manifest_complete && author.real_code` resolves) PLUS flat `author.*` Map keys
  // (the coverage binding-extractor sees the literal `.set` keys; unit asserts hold). `authorInputs` is
  // injectable (tests pass pure {reqs,opts}); the default builds the index from the session repo root.
  // FAIL-CLOSED on any resolve/build error → {false,false}: an unprovable AUTHOR blocks (never auto-"real").
  // GFR.4 / E2 — the CONDITIONAL external-consultation rung. `externalNeeded` (DIFF-DERIVED: a new third-party
  // import or a dependency-manifest change — external_dependency.ts) decides WHETHER a consultation is REQUIRED;
  // the `consult` buckets are the deterministic "did it happen" signal, windowed before/after the CODE phase
  // (external_consult.ts). Shared by AUTHOR (`searched_existing` = a pre-code consult, E2d) and CODE
  // (`consulted_before` = E2c · `audited` = the post-code AUDIT run, E2a). FAIL-OPEN `externalNeeded` (a git /
  // infra error → not-needed, never a false block — the rung is a SUPPLEMENT); FAIL-CLOSED `consult` (an
  // unproven consultation reads false → the guard blocks WHEN `externalNeeded`). Computed ONCE (one diff read)
  // and reused across the AUTHOR + CODE facets below. The GUARDS carry the conditionality
  // (`!external_needed || <facet>`) so the exemption is visible in the pack, not baked into a boolean here.
  let externalNeeded = false;
  let consult: ExternalConsult = { before: false, after: false };
  try {
    externalNeeded = await externalNeededForSession(sessionId);
    const ecTaskId = await readActiveTaskId(sessionId);
    if (ecTaskId !== null) consult = await externalConsultResult(sessionId, ecTaskId);
  } catch (err) {
    process.stderr.write(
      `[v2-supply] external-consult evidence failed (ignored): ${String(err)}\n`,
    );
  }

  const au = await authorEvidenceForSession(sessionId, authorInputs);
  m.set('author.manifest_complete', au.manifestComplete);
  m.set('author.real_code', au.realCode);
  // E2d — `searched_existing` = a pre-code external/existing-solution consult (the `before` bucket). Required
  // only when `external_needed` (the guard: `!author.external_needed || author.searched_existing`).
  m.set('author.searched_existing', consult.before);
  m.set('author.external_needed', externalNeeded);
  m.set('author', {
    manifest_complete: au.manifestComplete,
    real_code: au.realCode,
    searched_existing: consult.before,
    external_needed: externalNeeded,
  });

  // T2.7 — CODE gate evidence. THREE facets: `phases_complete` (the shipped 7-phase ledger `isComplete` for the
  // active task) ∧ `readiness_ran` (the three readiness surfacers ran + recorded) ∧ `deprecated_clean` (the
  // recorded readiness found NO deprecated call — the BLOCKING result, gates on the RESULT not merely "ran").
  // DUAL-SHAPE like T2.4/T2.5/T2.6: a nested `code` object (the path the guard
  // `code.phases_complete && code.readiness_ran && code.deprecated_clean` resolves) PLUS flat `code.*` Map keys
  // (the coverage binding-extractor sees the literal `.set` keys; unit asserts hold). `codeDeps` is injectable
  // (tests pass pure readers); the default binds the shipped runtime readers. FAIL-CLOSED on no active task /
  // any throw → {false,false,false}: an unprovable CODE blocks (never auto-"ready").
  const co = await codeEvidenceForSession(sessionId, codeDeps);
  m.set('code.phases_complete', co.phasesComplete);
  m.set('code.readiness_ran', co.readinessRan);
  m.set('code.deprecated_clean', co.deprecatedClean);
  // E2c/E2a — the external half of the CODE gate, CONDITIONAL on `external_needed` (same diff-derived predicate
  // as AUTHOR). `consulted_before` (E2c: read the task's APIs in the official docs BEFORE coding — the `before`
  // bucket) ∧ `audited` (E2a: the CODE·after AUDIT is a SECOND research run reaching EXTERNAL — the `after`
  // bucket, recorded only once the `code` phase is logged). Guards: `!code.external_needed || code.consulted_before`
  // ∧ `!code.external_needed || code.audited`. Exempt (docs-only / no-new-dep) → both pass with no consult.
  m.set('code.consulted_before', consult.before);
  m.set('code.audited', consult.after);
  m.set('code.external_needed', externalNeeded);
  m.set('code', {
    phases_complete: co.phasesComplete,
    readiness_ran: co.readinessRan,
    deprecated_clean: co.deprecatedClean,
    consulted_before: consult.before,
    audited: consult.after,
    external_needed: externalNeeded,
  });

  // T2.8 — DEPLOY gate evidence. TWO facets: `capability_ok` (the shipped CapabilityGate ALLOWS the deploy
  // capability — SKIPPED→true when no deploy env, so a flow with nothing to deploy is not blocked by the gate)
  // ∧ `accepted` (the ACTIVE task's DURABLE acceptance item, acceptance.ts, is `accepted` — the 2nd/last human
  // touchpoint, design §6.2). DUAL-SHAPE like T2.4–T2.7: a nested `deploy` object (the path the guards
  // `deploy.capability_ok` / `deploy.accepted` resolve) PLUS flat `deploy.*` Map keys (the coverage
  // binding-extractor sees the literal `.set` keys; unit asserts hold). `deployDeps` is injectable (tests pass
  // pure readers); the default skips the capability gate (no deploy env wired) + reads the durable acceptance
  // jsonl. FAIL-CLOSED on `accepted`: no active task / unaccepted item → false → the `accept` decision loops to
  // PLAN (NEVER auto-ship).
  const dep = await deployEvidenceForSession(sessionId, deployDeps);
  // DBL.2 — bug-fix loop bound: exhausted once the recorded round count hits the cap (the VERIFY decision then
  // escalates to ACCEPT instead of looping to AUTHOR). Cheap (a small state-file read), FAIL-OPEN to NOT-exhausted.
  let bugfixExhausted = false;
  try {
    const dTaskId = await readActiveTaskId(sessionId);
    bugfixExhausted =
      dTaskId !== null && (await readBugfixRounds(sessionId, dTaskId)) >= MAX_BUGFIX_ROUNDS;
  } catch {
    bugfixExhausted = false; // fail-open: a read error keeps the loop going (the lap budget still backstops)
  }
  m.set('deploy.capability_ok', dep.capabilityOk);
  m.set('deploy.accepted', dep.accepted);
  m.set('deploy.clean', dep.deployClean); // DBL.1 — the VERIFY decision's facet (skip→clean when no verifyCommand)
  m.set('deploy.bugfix_exhausted', bugfixExhausted); // DBL.2
  m.set('deploy.reversible', dep.reversible); // REVERSIBLE-DEPLOY: true → auto-advance accept; false → human gate
  m.set('deploy', {
    capability_ok: dep.capabilityOk,
    accepted: dep.accepted,
    clean: dep.deployClean,
    bugfix_exhausted: bugfixExhausted,
    reversible: dep.reversible,
  });

  // FD5/FD6 — FRONTEND pre-delivery gate evidence (the OUTPUT enforcement). `frontend.clean` = the staged
  // frontend files carry NO CRITICAL accessibility defect (frontend_audit). DUAL-SHAPE like T2.4–T2.8: a nested
  // `frontend` object (the path the guard `frontend.clean` resolves) PLUS flat `frontend.*` Map keys. FAIL-OPEN
  // (frontend_evidence.ts): a non-frontend / non-repo / unanalyzable commit → clean:true (never bricked); only a
  // PROVEN staged critical defect blocks. `frontendDeps` injectable; default reads the staged blobs via git.
  const fe = await frontendEvidenceForEvent(event, frontendDeps);
  m.set('frontend.clean', fe.clean);
  m.set('frontend.critical', fe.critical);
  m.set('frontend.high', fe.high);
  m.set('frontend', { clean: fe.clean, critical: fe.critical, high: fe.high });
  return m;
}

/** Read the captured pre-research artifact path (T2.5), or `null` when none was stamped/unreadable. */
async function readPreResearchPath(sessionId: string): Promise<string | null> {
  try {
    const v = JSON.parse(
      await readFile(sessionStateFile(sessionId, PRE_RESEARCH_PATH_KEY), 'utf8'),
    ) as unknown;
    return typeof v === 'string' && v !== '' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Run every ACTIVE v2 cartridge over `event` and return the merged decision (most-severe exit wins). ADDITIVE:
 * returns ZERO when there are no active v2 cartridges, so a caller merging this into the v1 decision is a no-op.
 */
/** #12 — claim the right to emit the CODE report ONCE per task (DURABLE marker, cross-event). Returns true on
 *  the FIRST call for `taskId` (writing `complete-reported-<taskId>`), false thereafter — so the transition
 *  path and the completion fallback never both emit a CODE report, regardless of which fires first or on which
 *  event. Best-effort write (a marker failure degrades emit-once → emit, never blocks the report). */
async function claimCodeReport(sessionId: string, taskId: string, now: string): Promise<boolean> {
  const path = sessionStateFile(sessionId, `complete-reported-${taskId}`);
  try {
    await readFile(path, 'utf8');
    return false; // already claimed → the other path emitted it
  } catch {
    /* not yet claimed */
  }
  try {
    await atomicWriteFile(path, now);
  } catch {
    /* best-effort */
  }
  return true;
}

export async function runV2Cartridges(
  sessionId: string,
  event: Event,
  now: string,
  options?: {
    /**
     * F2: when true, evaluate gates WITHOUT advancing state or logging transitions — enforcement-only mode.
     * Use from PreToolUse to block BEFORE the tool runs; PostToolUse still advances + records observability.
     * Bypasses the `post_tool_call` trigger filter (v2_observed_actor.ts:67) by overriding env.kind to the
     * gate's declared trigger, so guards evaluate on a PreToolUse `tool_call` event. SKIP `write_state` and
     * `transition`/`appendTransition` effects. block/halt → exitCode 2 + messages; warn → no-op (PostToolUse owns it).
     */
    enforceOnly?: boolean;
    /**
     * Hole 1 — executor exemption: when a `agent_id` is present in the PreToolUse payload, the caller is a
     * Task/Agent executor subagent (never the main orchestrator loop). Executor subagents must never be blocked
     * by the gate — they implement what the orchestrator planned. Pass `agentId` extracted from the hook stdin.
     */
    agentId?: string;
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
  // DBL.1b — record the DETERMINISTIC deploy verification: when the agent runs EXACTLY the project's configured
  // `verifyCommand` (the deploy procedure dictates the exact command, so the match is reliable), capture its REAL
  // exit code → `deployClean` (verification.ts). Never a self-report. FAIL-OPEN on any read error.
  if (event.kind === 'post_tool_call' && 'tool' in event && event.tool === 'Bash') {
    try {
      const cwd = 'cwd' in event ? (event as { cwd?: unknown }).cwd : undefined;
      const command = 'args' in event ? (event.args as { command?: unknown }).command : undefined;
      if (typeof cwd === 'string' && cwd !== '' && typeof command === 'string') {
        const verifyCmd = await readActiveVerifyCommand(await resolveProjectScopeRoot(cwd));
        const taskId = await readActiveTaskId(sessionId);
        if (verifyCmd !== null && command.trim() === verifyCmd.trim() && taskId !== null) {
          await recordVerification(
            sessionId,
            taskId,
            (event as { exit_code?: number }).exit_code === 0,
          );
        }
      }
    } catch (err) {
      process.stderr.write(`[v2-supply] verify record failed (ignored): ${String(err)}\n`);
    }
  }
  let exitCode: 0 | 2 = 0;
  const messages: string[] = [];
  const injections: string[] = [];
  const boundSkills: string[] = [];
  // GS1 — the CANONICAL task-checkpoint key (the wg issue id) for THIS event, resolved once + memoized. In a
  // lap it is `OPENSQUID_ITEM_ID` (no I/O); interactively it forward-maps the active harness task → its wg id
  // (null → skip the checkpoint write). Shared by the FSM scope_write seed (below) + the single-writer trigger.
  let cachedKey: string | null | undefined;
  const checkpointKey = async (): Promise<string | null> => {
    if (cachedKey === undefined) cachedKey = await resolveCheckpointKey(sessionId);
    return cachedKey;
  };
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
      let seededState = await readFsmState(sessionId, name, actor.fsm, taskId);
      // GS1 FSM #2 — in a LAP (OPENSQUID_AUTOMATION=1) the interactive `scope` stage was already completed
      // before the loop, so boot the pack FSM at `scope_write` (the first AUTOMATED stage) instead of the pack
      // initial. ONLY when a task checkpoint EXISTS (real scope proof) — with NO checkpoint the lap must NOT
      // fabricate a scoped state, so it stays at the pack initial and genuinely scopes (its first transition
      // then CREATES the checkpoint; the next lap boots at scope_write). Guarded to a pack that declares a
      // `scope_write` state + only when the resolved state is still the pack initial (a resumed lap keeps its
      // persisted, already-advanced state). Interactive sessions (no automation) always start at the initial.
      // FAIL-OPEN: a checkpoint-read error never breaks the hook (the seed stays at the pack initial).
      if (
        process.env.OPENSQUID_AUTOMATION === '1' &&
        seededState === actor.fsm.initial &&
        actor.fsm.states.includes('scope_write')
      ) {
        try {
          const key = await checkpointKey();
          const cp = key === null ? null : await withTaskCheckpointStore((s) => s.getTaskCheckpoint(key));
          if (cp !== null) seededState = 'scope_write';
        } catch (err) {
          process.stderr.write(`[v2-supply] scope_write seed check failed (ignored): ${String(err)}\n`);
        }
      }
      actor.state.current = seededState;
      // LANE MODEL — the SCOPE stage's write-lane feeds `scope.is_advance` (data-driven, replacing the
      // hard-coded PRE_RESEARCH_REGEX). `scope_write` shares the same artifact lane; either state's `writes`
      // resolves it (a pack that declares neither → undefined → no scope-advance facets, as before).
      const scopeWrites =
        loaded.compiled.meta.scope?.writes ?? loaded.compiled.meta.scope_write?.writes;
      const ctx = await buildGuardCtx(
        event,
        sessionId,
        actor.state.current,
        undefined,
        undefined,
        undefined,
        undefined,
        scopeWrites,
      );
      // F2 enforceOnly: bypass the trigger filter (v2_observed_actor.ts:67) by overriding env.kind to match
      // the gate's declared trigger, so the gate evaluates on a PreToolUse `tool_call` event. The guard ctx
      // already carries the real event's `tool` and `event` keys (set above by buildGuardCtx), so the guard
      // decision is accurate. In normal mode, env.kind == event.kind (unchanged behavior).
      const curMeta = loaded.compiled.meta[actor.state.current];
      // LANE MODEL enforcement (the #33 successor to advance-action detection). Under enforceOnly (PreToolUse
      // + automation), a MUTATING file-write whose target falls OUTSIDE the CURRENT stage's declared `writes:`
      // lane is BLOCKED — "stay in your stage's lane." This is SEPARATE from the completeness gate below (the
      // gate decides WHEN the FSM advances; the lane decides WHERE a stage may write, per tool call). The three
      // #33 holes hold: reads never block (evaluateLane → checked:false), a laneless stage is INERT, and an
      // executor subagent (agentId — Hole 1) is exempt. A blocked lane write short-circuits the gate eval below
      // (the tool never runs, so there is nothing to advance on).
      if (enforceOnly && options?.agentId === undefined && exitCode !== 2) {
        const evTool = 'tool' in event && typeof event.tool === 'string' ? event.tool : '';
        const evArgs: Record<string, unknown> = 'args' in event ? event.args : {};
        const lane = evaluateLane(curMeta?.writes, evTool, evArgs);
        if (lane.checked && lane.outOfLane && lane.path !== null) {
          exitCode = 2;
          messages.push(laneBlockMessage(actor.state.current, lane.path, curMeta?.writes ?? []));
          continue; // out-of-lane write denied — skip this cartridge's gate eval (the tool won't run)
        }
      }
      const envKind: MessageKind =
        enforceOnly && curMeta?.kind === 'gate' && (curMeta.trigger?.length ?? 0) > 0
          ? (curMeta.trigger![0] as MessageKind)
          : event.kind;
      const env: Envelope = {
        seq: 0,
        from: `pack:${name}`,
        to: `pack:${name}`,
        kind: envKind,
        // R-AUDIT-CTX: phase = the cartridge's current FSM state (pre-receive); verdicts read fail-open.
        payload: { ctx },
        ts: Date.parse(now),
      };
      // SKILL.1 (R-SKILLS-PER-STATE): one runtime per cartridge; `onStateLeave` on each transition, then bind
      // the CURRENT (post-receive) state on EVERY event — the state IS the router (not only on transitions).
      const skillRuntime = new InMemorySkillRuntime();
      for (const e of await actor.receive(env)) {
        if (e.kind === 'write_state') {
          // enforceOnly: NO state persistence (gate-check-only — PreToolUse; PostToolUse owns the advance).
          if (!enforceOnly) {
            await persistActorState(sessionId, name, e.state, now, taskId); // T2.2 — same per-task key as the read
            // GS1 — the deterministic stage fn is the SINGLE WRITER of the durable TASK CHECKPOINT, keyed by
            // the CANONICAL wg issue id (resolveCheckpointKey: a lap's OPENSQUID_ITEM_ID, else the active
            // harness task forward-mapped to its wg id). The orchestrator (a different process) reads it back
            // by `item.id` to gate the loop on real scope. UNIVERSAL: fires interactively AND in a lap (the old
            // OPENSQUID_ITEM_ID-only gate is GONE). Create-if-absent / else update the stage; and when a
            // pre-research artifact is stamped (PRE_RESEARCH_PATH_KEY) record it as the on-disk SCOPE PROOF
            // (set AFTER create so the row exists). NULL key → SKIP (never fabricate a checkpoint). FAIL-OPEN:
            // a checkpoint write must never break the hook — but a missing key is a skip, not a silent drive.
            try {
              const key = await checkpointKey();
              if (key !== null) {
                await withTaskCheckpointStore(async (store) => {
                  const nowMs = Date.parse(now);
                  const existing = await store.getTaskCheckpoint(key);
                  if (existing === null) await store.createTaskCheckpoint(key, e.state, nowMs);
                  else await store.updateTaskStage(key, e.state, nowMs);
                  const artifact = await readPreResearchPath(sessionId);
                  if (artifact !== null) await store.setTaskArtifacts(key, [artifact], nowMs);
                });
              }
            } catch (err) {
              process.stderr.write(
                `[v2-supply] task-checkpoint write failed (ignored): ${String(err)}\n`,
              );
            }
          }
        } else if (!enforceOnly && e.kind === 'emit' && e.messageKind === 'transition') {
          // INV2 in-process observability — the cited v1 durable equivalent of the bus transition.
          const p = e.payload as { from: string; to: string };
          await appendTransition({
            session: sessionId,
            pack: name,
            from: p.from,
            to: p.to,
            on: event.kind,
            at: now,
            via: -1,
          });
          // DBL.2 — bug-fix loop round accounting on the VERIFY decision's transitions: bugs_found (verify→author)
          // is one round (bump → the cap eventually flips deploy.bugfix_exhausted); a verify→accept (clean OR
          // exhausted) resets so a future re-open starts fresh. FAIL-OPEN (never break the hook).
          if (p.from === 'verify') {
            try {
              const bfTask = await readActiveTaskId(sessionId);
              if (bfTask !== null) {
                if (p.to === 'author') await bumpBugfixRounds(sessionId, bfTask);
                else if (p.to === 'accept') await resetBugfixRounds(sessionId, bfTask);
              }
            } catch (err) {
              process.stderr.write(
                `[v2-supply] bugfix-rounds accounting failed (ignored): ${String(err)}\n`,
              );
            }
          }
          // T2.12 / CADENCE-IN-PACK — the LIVE per-stage report trigger. On each transition LEAVING a stage, emit
          // that stage's after-report (dated docs/reports/ file + memory mirror + in-session injection +
          // best-effort chat) — but ONLY when the pack declares `report:` for the LEAVING state (`meta[p.from].report`).
          // The cadence (which stages report) is PACK DATA now, not the deleted core `STAGE` map. FAIL-OPEN: a report
          // failure must NEVER break the hook. T2.9 double-emit guard: in an autonomous lap (OPENSQUID_AUTOMATION=1)
          // loop_driver.onPhasesComplete owns the CODE report, so skip the CODE report HERE to avoid a duplicate;
          // interactively (no env) v2_supply remains the CODE emitter. Other reporting stages always emit here.
          let stage: string | undefined = loaded.compiled.meta[p.from]?.report;
          if (stage === 'CODE' && process.env.OPENSQUID_AUTOMATION === '1') stage = undefined;
          // #12 — the CODE report is emitted at most ONCE per task across BOTH paths (this transition + the
          // completion fallback after the loop) via the durable claim; non-CODE stages emit once per their own
          // transition (no claim). So a fallback emit on the completing log_phase suppresses a later
          // code→deploy transition emit, and vice-versa.
          if (stage !== undefined) {
            try {
              const root = await readSessionCwd(sessionId);
              // #12 — claim the CODE report only when we WILL emit (root available), so a null-cwd path never
              // burns the once-per-task claim and silently suppresses the completion fallback below.
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
                  // CODE is the long, stand-out report: the 7-phase chart (all logged — the gate passed).
                  ...(p.from === 'code'
                    ? { phases: CODE_PHASES.map((name) => ({ name, done: true })) }
                    : {}),
                  // T2.10 — only the SCOPE stage carries the goal-alignment line (`exactOptionalPropertyTypes`:
                  // the key is present ONLY when defined, never an explicit `undefined`).
                  ...(p.from === 'scope'
                    ? { goalAligned: (await goalConsult(sessionId, root)).aligned }
                    : {}),
                };
                const { body } = await emitStageReport(root, r, now); // dated file + the body
                // T2.12-surface: SHOW the phase report — in-session (the injections set the hooks emit as
                // additionalContext) + a best-effort chat push (fail-open). Was file+memory only → invisible.
                injections.push(body);
                await surfaceReportToChat(root, body);

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
                const { body } = renderStageSummary(
                  enteringLabel,
                  loaded.compiled.meta[p.to]?.does,
                  taskId ?? 'no-active-task',
                  now,
                );
                injections.push(body);
                await surfaceReportToChat(root, body);
              }
            } catch (err) {
              process.stderr.write(
                `[v2-supply] stage summary emit failed (ignored): ${String(err)}\n`,
              );
            }
          }
          // AD.1 capture lifecycle (fail-open): LEAVING `scope_write` (SCOPE_WRITE complete, GS1) → FREEZE the
          // captured ask so a frozen scope cannot be silently widened — it stays available for PLAN/AUTHOR's
          // anti-drift checks. ENTERING `scope` (a new task's re-arm) → RESET to a fresh ask (else the next task
          // inherits the prior frozen ask). Reset on ENTRY to scope, NOT on leave — so the ask survives the flow.
          // GS1: moved from `p.from === 'scope'` to `p.from === 'scope_write'` so the ask is frozen after the
          // automated artifact-write, not after the interactive confirmation lap.
          try {
            if (p.from === 'scope_write') await freezeAsk(sessionId);
            if (p.to === 'scope') await resetAsk(sessionId);
          } catch (err) {
            process.stderr.write(
              `[v2-supply] captured-ask freeze/reset failed (ignored): ${String(err)}\n`,
            );
          }
          // T2.5 LIVE WIRING (the fix for "FSM stalls at PLAN"): on SCOPE_WRITE→PLAN, POPULATE the work-graph from
          // the captured pre-research artifact so `plan.complete` can hold and the PLAN gate can advance. Without
          // this caller, autoDecompose never runs live → the work-graph is empty → plan_ready never passes → stall.
          // IDEMPOTENT: skip if any of the artifact's elements are already covered (don't duplicate issues on a
          // re-fire). FAIL-OPEN: a work-graph error must never break the hook.
          // GS1: moved from `p.from === 'scope'` to `p.from === 'scope_write'` — decompose fires on the automated
          // artifact-write stage leaving, not on the interactive scope confirmation lap leaving.
          if (p.from === 'scope_write') {
            try {
              const artifact = await readPreResearchPath(sessionId);
              const ext = artifact === null ? null : await extractScope(artifact);
              if (artifact !== null && ext !== null && ext.authoredElements.length > 0) {
                const wg = await openWg(sessionId);
                const ids = ext.authoredElements.map((el) => el.id);
                const covered = buildCoveredBy(ids, await wg.listIssues());
                const already = Object.values(covered).some((c) => c.length > 0);
                if (!already) await autoDecompose(artifact, wg); // first decomposition of this scope
              }
            } catch (err) {
              process.stderr.write(`[v2-supply] auto-decompose failed (ignored): ${String(err)}\n`);
            }
          }
          // T2.8 LIVE WIRING (the fix for "the FSM can't reach done"): on entering DEPLOY, create the durable
          // "waiting for your OK" acceptance item so the `accept` decision has something to accept. Without this
          // caller appendAcceptance never runs → deploy.accepted is always false → the accept decision loops to
          // PLAN forever. IDEMPOTENT (one item per task, keyed by taskId) + FAIL-OPEN. The human-accept input is
          // the `opensquid accept <taskId>` command (markAccepted); the start-up handoff surfaces waiting items.
          if (p.to === 'deploy' && taskId !== null) {
            try {
              const existing = await readAcceptance(sessionId);
              if (!existing.some((i) => i.id === taskId)) {
                await appendAcceptance(sessionId, {
                  id: taskId,
                  taskId,
                  status: 'waiting',
                  addedAt: now,
                });
              }
            } catch (err) {
              process.stderr.write(
                `[v2-supply] acceptance append failed (ignored): ${String(err)}\n`,
              );
            }
          }
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
            // Blanket-block-with-exemptions for enforceOnly (PreToolUse) mode:
            // block a MUTATING call at a failing gate EXCEPT when (a) it's read-only
            // (isMutatingCall → false, so reads always pass — #22 read-only bypass) or
            // (b) it's an executor subagent (agentId present — Hole 1, the lane model).
            // Non-enforceOnly (PostToolUse) is UNCHANGED — block always applies there.
            const evTool = 'tool' in event && typeof event.tool === 'string' ? event.tool : '';
            const evArgs = ('args' in event ? event.args : {}) as Record<string, unknown>;
            if (
              !enforceOnly ||
              (isMutatingCall(evTool, evArgs) && options?.agentId === undefined)
            ) {
              exitCode = 2; // block | halt → ENFORCE; the deny IS the observation (gate/kernel.ts:37-43)
              if (effect.message !== undefined) messages.push(effect.message);
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
  // #12 — the per-task COMPLETION report (the in-band fallback). The transition-based CODE report above fires
  // ONLY on the code→deploy FSM transition; when the session FSM is parked (in-band, no loop driving it) it
  // never fires, so reporting is invisible in Claude Code. So: on the POST_TOOL_CALL of a `log_phase` that has
  // COMPLETED the active task, emit the CODE report HERE (the PostToolUse hook re-execs fresh → shows without
  // an MCP-server restart; injected as additionalContext like the checkpoint). Gated on `post_tool_call` (the
  // tool already ran → the phase is written, isComplete can be true; mirrors the readiness block) +
  // non-automation (loop_driver owns CODE there) + the SAME durable claim the transition uses → emitted at
  // most ONCE per task across both paths and across events. FAIL-OPEN: a report failure never breaks the hook.
  if (
    event.kind === 'post_tool_call' &&
    process.env.OPENSQUID_AUTOMATION !== '1' &&
    'tool' in event &&
    typeof event.tool === 'string' &&
    /log_phase/.test(event.tool)
  ) {
    try {
      // isComplete + the phase ledger key on the harness `active.id` (log_phase: appendPhase(…, active.id)),
      // while the claim + report LABEL use the track id (`taskId ?? id` via readActiveTaskId) to match the
      // transition path. For an untracked task the two coincide; for a tracked one they must not be conflated.
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
        // The Evidence proof line must be MEASURED, not asserted — read the real code-gate facts (the same
        // reader buildGuardCtx/the gate use), so a deprecated/failed-readiness task never gets a false
        // guess-free certificate. phases_complete is already true here (the isComplete guard above).
        const code = await codeEvidenceForSession(sessionId);
        const { body } = await emitStageReport(
          root,
          {
            stage: 'CODE',
            taskId: trackId,
            summary: 'task complete — all 7 phases logged',
            nextDirective: 'deploy',
            // This is the CODE phase-ledger completion emitter (bound to log_phase/isComplete/CODE_PHASES, the
            // CORE 7-phase ledger — see stage_report.ts); its next-work text is carried inline to preserve the
            // report content that the deleted NEXT_STAGE_WORK map used to supply.
            nextWork: 'verify deploy capability, then the human-accept gate',
            evidence: [
              { label: 'phases_complete', ok: code.phasesComplete },
              { label: 'readiness_ran', ok: code.readinessRan },
              { label: 'deprecated_clean', ok: code.deprecatedClean },
            ],
            phases: CODE_PHASES.map((name) => ({ name, done: true })),
          },
          now,
        );
        // All FOUR standardized sinks (stage_report.ts:4-6), matching the transition path: file (emitStageReport)
        // + injection + chat + the memory mirror — so an in-band CODE completion reaches the wedge buffer too.
        injections.push(body);
        await surfaceReportToChat(root, body);
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
