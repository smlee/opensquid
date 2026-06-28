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
import { appendTransition } from '../observe/transition_log.js';
import { sessionStateFile } from '../paths.js';
import { readActiveTaskId, readSessionCwd } from '../session_state.js';
import { InMemorySkillRuntime, onStateEntry, onStateLeave } from '../skill/state_skills.js';
import { capturePendingLesson } from '../wedge/capture.js';
import { goalConsult } from './goal_consult.js';
import { CODE_PHASES, emitStageReport, type Stage } from './stage_report.js';
import { sendChat } from '../../chat_daemon/client.js';
import { loadChannelsConfig, resolveUmbrellaForCwd } from '../../channels/routing.js';

/**
 * T2.12-surface — best-effort push of a phase report to the project's chat. FAIL-OPEN in every branch: no
 * channels config / no umbrella for this cwd / no daemon running → silently skip (a report must never break
 * the hook, and chat is optional). The daemon resolves `project:telegram` to the cwd-umbrella's channel.
 */
/**
 * T2.12-evidence — the deterministic gate predicates that backed a stage, read from the just-evaluated guard
 * ctx (flat dotted keys). Rendered as the report's `Evidence:` line so a phase report is a readable proof.
 * The phase already passed (the transition fired), so these are the checks that made it pass.
 */
function stageEvidence(ctx: Map<string, unknown>, from: string): { label: string; ok: boolean }[] {
  const isTrue = (k: string): boolean => ctx.get(k) === true;
  switch (from) {
    case 'scope': {
      const depth = Number(ctx.get('scope.depth') ?? 0);
      return [
        { label: 'anchors_ok', ok: isTrue('scope.anchors_ok') },
        { label: `depth ${depth}≥3`, ok: depth >= 3 },
        { label: 'no open question', ok: ctx.get('scope.open_question') === false },
      ];
    }
    case 'plan':
      return [
        { label: 'acyclic', ok: isTrue('plan.acyclic') },
        { label: 'complete', ok: isTrue('plan.complete') },
      ];
    case 'author':
      return [
        { label: 'coverage_complete', ok: isTrue('author.coverage_complete') },
        { label: 'real_code', ok: isTrue('author.real_code') },
      ];
    case 'code':
      return [
        { label: 'phases_complete', ok: isTrue('code.phases_complete') },
        { label: 'readiness_ran', ok: isTrue('code.readiness_ran') },
        { label: 'deprecated_clean', ok: isTrue('code.deprecated_clean') },
      ];
    case 'deploy':
      return [{ label: 'capability_ok', ok: isTrue('deploy.capability_ok') }];
    default:
      return [];
  }
}

async function surfaceReportToChat(cwd: string, body: string): Promise<void> {
  try {
    const cfg = await loadChannelsConfig().catch(() => null);
    if (cfg === null) return;
    const umbrellaId = resolveUmbrellaForCwd(cfg, cwd);
    if (umbrellaId === null || umbrellaId === '') return;
    await sendChat({ channel: 'project:telegram', text: body });
  } catch {
    /* fail-open: chat is optional — never break the hook over it */
  }
}
import { authorEvidenceForSession, type AuthorInputs } from './author_evidence.js';
import { codeEvidenceForSession, type CodeEvidenceDeps } from './code_evidence.js';
import { frontendEvidenceForEvent, type FrontendEvidenceDeps } from './frontend_evidence.js';
import { deployEvidenceForSession, type DeployEvidenceDeps } from './deploy_evidence.js';
import { planEvidence } from './plan_evidence.js';
import { scopeEvidence } from './scope_evidence.js';
import { V2ObservedActor } from './v2_observed_actor.js';

import type { Envelope } from '../bus/types.js';
import type { Event } from '../event.js';

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

// T2.12 — the live trigger map: the FSM stages whose report is emitted on the LEAVING transition. ALL FIVE
// fire here, on the `code → deploy` transition for CODE included. (The T2.9 "loop_driver" subsystem the spec
// earmarked for the CODE report was dead code — zero live callers — and was REMOVED 2026-06-27; this is the
// single, consistent live emitter for every phase.)
const STAGE: Record<string, Stage> = {
  scope: 'SCOPE',
  plan: 'PLAN',
  author: 'AUTHOR',
  code: 'CODE',
  deploy: 'DEPLOY',
};

// T2.5 — the session-state key holding the CAPTURED pre-research artifact path. Stamped on the SCOPE advance
// (a Write/Edit of a `docs/research/*-pre-research-*` file) so the later PLAN gate can `extractScope` the SAME
// artifact (the INDEPENDENT design-element universe) without a live advance event in hand.
const PRE_RESEARCH_PATH_KEY = 'fullstack-flow-pre-research-path';

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
): Promise<Map<string, unknown>> {
  const m = new Map<string, unknown>();
  m.set('event', event.kind);
  if ('tool' in event) m.set('tool', event.tool);
  const verdictGuess = await readVerdict(sessionId, 'coding-flow-guess-audit-cache');
  const verdictSpec = await readVerdict(sessionId, 'coding-flow-spec-audit-cache');
  m.set('verdict.guess', verdictGuess); // R-AUDIT-CTX: keep the flat key (ARCHITECTURE.md:290) — stays MET
  m.set('verdict.spec', verdictSpec);
  m.set('verdict', { guess: verdictGuess, spec: verdictSpec }); // T2.3 — nested, so `verdict.guess` path-resolves too
  m.set('phase', phase);
  // T2.4 — SCOPE gate evidence. The advance event is a Write/Edit whose target is a pre-research artifact; only
  // then is the SCOPE gate "advancing" (the short-circuit `!scope.is_advance` passes every other event, so a
  // gate never blocks mid-scoping). The artifact path comes from the LIVE event (no read-after-write).
  const filePath = 'args' in event ? event.args?.file_path : undefined;
  const fp =
    'tool' in event && /(?:Write|Edit)/.test(event.tool) && typeof filePath === 'string'
      ? filePath
      : '';
  const isAdvance = /docs\/research\/.*-pre-research-/.test(fp);
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
  // the in-repo requirement manifest + the gated-tree CodeIndex: `coverage_complete` (no orphaned gated export)
  // ∧ `real_code` (every requirement MET — where met for reachable/binding REQUIRES its proof-test to pass,
  // check.ts:54-73, so a stub with no passing proof fails). DUAL-SHAPE like T2.4/T2.5: a nested `author` object
  // (the path the guard `author.coverage_complete && author.real_code` resolves) PLUS flat `author.*` Map keys
  // (the coverage binding-extractor sees the literal `.set` keys; unit asserts hold). `authorInputs` is
  // injectable (tests pass pure {reqs,opts}); the default builds the index from the session repo root.
  // FAIL-CLOSED on any resolve/build error → {false,false}: an unprovable AUTHOR blocks (never auto-"real").
  const au = await authorEvidenceForSession(sessionId, authorInputs);
  m.set('author.coverage_complete', au.coverageComplete);
  m.set('author.real_code', au.realCode);
  m.set('author', { coverage_complete: au.coverageComplete, real_code: au.realCode });

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
  m.set('code', {
    phases_complete: co.phasesComplete,
    readiness_ran: co.readinessRan,
    deprecated_clean: co.deprecatedClean,
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
  m.set('deploy.capability_ok', dep.capabilityOk);
  m.set('deploy.accepted', dep.accepted);
  m.set('deploy', { capability_ok: dep.capabilityOk, accepted: dep.accepted });

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
export async function runV2Cartridges(
  sessionId: string,
  event: Event,
  now: string,
): Promise<V2Decision> {
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
  let exitCode: 0 | 2 = 0;
  const messages: string[] = [];
  const injections: string[] = [];
  const boundSkills: string[] = [];
  for (const loaded of cartridges) {
    try {
      if (loaded.compiled.fsm === undefined) continue; // foundation cartridge → not an observed actor
      const name = loaded.pack.name;
      const actor = new V2ObservedActor(`pack:${name}`, loaded);
      // T2.2 (principle 9) — key the FSM PER-TASK. `taskId` is null until a task is active, so SCOPE/PLAN
      // share the session-level key `fsm-<pack>`; once a task is active, AUTHOR/CODE run on the isolated
      // key `fsm-<pack>-<taskId>` that STARTS at the FSM initial state — activating task B never rewinds
      // task A's FSM ([[coding-flow-task-start-reset-trap]]). The persist below uses the SAME taskId.
      const taskId = await readActiveTaskId(sessionId);
      actor.state.current = await readFsmState(sessionId, name, actor.fsm, taskId);
      const ctx = await buildGuardCtx(event, sessionId, actor.state.current);
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
      for (const e of await actor.receive(env)) {
        if (e.kind === 'write_state') {
          await persistActorState(sessionId, name, e.state, now, taskId); // T2.2 — same per-task key as the read
        } else if (e.kind === 'emit' && e.messageKind === 'transition') {
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
          // T2.12 — the LIVE per-stage report trigger. On each transition LEAVING a stage (SCOPE/PLAN/AUTHOR/
          // CODE/DEPLOY — see STAGE), emit that stage's report (dated docs/reports/ file + memory mirror +
          // in-session injection + best-effort chat). FAIL-OPEN: a report failure must NEVER break the hook.
          const stage = STAGE[p.from];
          if (stage !== undefined) {
            try {
              const root = await readSessionCwd(sessionId);
              if (root !== null) {
                // T2.10 — the SCOPE report's goal-alignment line (the live consumer of goalConsult). Only the
                // SCOPE stage carries it (the destination check belongs at scope-time); other stages leave it
                // undefined → no `## Goal alignment` line. ADVISORY (surfaced, never a block — the anti-drift
                // gate is checkAnchors). FAIL-OPEN is the surrounding try/catch.
                const r = {
                  stage,
                  taskId: taskId ?? 'no-active-task',
                  summary: `${p.from} complete`,
                  nextDirective: p.to,
                  // T2.12-evidence — the deterministic gate predicates that backed this phase.
                  evidence: stageEvidence(ctx, p.from),
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
          // AD.1 capture lifecycle (fail-open): LEAVING `scope` (SCOPE complete) → FREEZE the captured ask so a
          // frozen scope cannot be silently widened — it stays available for PLAN/AUTHOR's anti-drift checks.
          // ENTERING `scope` (a new task's re-arm) → RESET to a fresh ask (else the next task inherits the prior
          // frozen ask). Reset on ENTRY, NOT leave — so the ask survives the rest of the flow.
          try {
            if (p.from === 'scope') await freezeAsk(sessionId);
            if (p.to === 'scope') await resetAsk(sessionId);
          } catch (err) {
            process.stderr.write(
              `[v2-supply] captured-ask freeze/reset failed (ignored): ${String(err)}\n`,
            );
          }
          onStateLeave(p.from, skillRuntime); // SKILL.1: unloaded on leave
        } else if (e.kind === 'emit' && e.messageKind === 'gate_action') {
          const p = e.payload as { action: 'warn' | 'block' | 'halt'; message: string };
          if (p.action === 'warn') injections.push(p.message);
          else {
            exitCode = 2; // block | halt → ENFORCE (gate/kernel.ts:37-38); the deny IS the observation
            messages.push(p.message);
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
  return { exitCode, messages, injections, boundSkills };
}
