#!/usr/bin/env node
/**
 * Claude Code `PreToolUse` hook binary.
 *
 * Wired in `~/.claude/settings.json` (or per-project `.claude/settings.json`):
 *
 *   { "hooks": { "PreToolUse": [{ "matcher": "Bash",
 *     "hooks": [{ "type": "command",
 *       "command": "opensquid-hook-pretooluse" }] }] } }
 *
 * stdin = Claude Code's tool-call JSON. stdout = empty. stderr = drift
 * messages (shown to the user/agent). exit code 0 = allow, 2 = block.
 *
 * Payload normalization: Claude Code may use snake_case (`tool_name`,
 * `tool_input`, `session_id`); the runtime Event schema uses camelCase. We
 * normalize in `parsePayload` BEFORE handing to Zod so the schema stays pure.
 *
 * Fail-open: any internal crash exits 0 with a stderr message. NEVER block
 * the parent agent because of an opensquid bug. The `main().catch()` at the
 * bottom is the last line of defense.
 */
import {
  buildRegistry,
  loadActivePacksForDispatch,
  loadActiveV2Cartridges,
  projectDeclaresOrchestratorOnly,
} from '../bootstrap.js';
import { runV2SkillHost } from '../loop/v2_skill_host.js';
import { runV2Cartridges, type V2Decision } from '../loop/v2_supply.js';
import { exitIfSubagent } from './subagent_guard.js';
import { parseApplyPatch } from './apply_patch.js';
import { appendTool, recordSessionCwd } from '../session_state.js';
import { Event } from '../types.js';

import { mirrorActiveTask } from './active_task_mirror.js';
import { runHarnessGraphSync } from './harness_graph_sync.js';
import { dispatchEvent } from './dispatch.js';
import {
  buildPreToolUseContext,
  buildPreToolUseDeny,
  emitDriftStderrAndExit,
} from './hook_output.js';
import { extractSessionId } from './session_id.js';
import { checkSafety } from '../guard/safety_floor.js';
import { loadSafetyPolicy } from '../guard/safety_policy.js';
import { isYoloMode } from '../guard/yolo.js';
import { checkOrchestratorGuard } from '../guard/orchestrator_guard.js';
import { appendProjectDriftEvent } from '../drift_catalog.js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveProjectScopeRoot } from '../paths.js';
import { readSettings } from '../orchestrator_settings.js';

interface PreToolUsePayload {
  tool?: string;
  tool_name?: string;
  args?: Record<string, unknown>;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  transcript_path?: string;
  transcriptPath?: string;
  /** GS1: present ONLY inside a Task/Agent subagent (per Claude Code hook docs). */
  agent_id?: string;
}

/** ATM.1: the session transcript path (where THIS CC version stores the task list). */
function extractTranscriptPath(raw: string): string | undefined {
  try {
    const obj = JSON.parse(raw) as PreToolUsePayload;
    const p = obj.transcript_path ?? obj.transcriptPath;
    return typeof p === 'string' && p.length > 0 ? p : undefined;
  } catch {
    return undefined;
  }
}

/**
 * GS1: extract the optional `agent_id` from the raw hook payload. Claude Code populates this
 * field in the PreToolUse stdin JSON ONLY when the hook runs inside a Task/Agent subagent, so
 * its presence marks the caller as an executor (exempt from the orchestrator guard).
 */
function extractAgentId(raw: string): string | undefined {
  try {
    const obj = JSON.parse(raw) as PreToolUsePayload;
    return typeof obj.agent_id === 'string' && obj.agent_id.length > 0 ? obj.agent_id : undefined;
  } catch {
    return undefined;
  }
}

function parsePayload(raw: string): unknown {
  const obj = JSON.parse(raw) as PreToolUsePayload;
  // Claude Code uses snake_case (tool_name / tool_input). Normalize to the
  // runtime Event shape (tool / args). Either form accepted.
  return {
    kind: 'tool_call',
    tool: obj.tool ?? obj.tool_name ?? '',
    args: obj.args ?? obj.tool_input ?? {},
    ...(obj.cwd !== undefined ? { cwd: obj.cwd } : {}),
  };
}

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk as string;
  return data;
}

async function main(): Promise<void> {
  exitIfSubagent('pre-tool-use'); // SUB.1: before stdin read / any state write
  const raw = await readStdin();
  if (!raw.trim()) {
    process.stderr.write('opensquid: empty PreToolUse payload — proceeding\n');
    process.exit(0);
  }

  let normalized: unknown;
  try {
    normalized = parsePayload(raw);
  } catch (e) {
    process.stderr.write(`opensquid: invalid PreToolUse JSON — ${String(e)}\n`);
    process.exit(0);
  }

  const parsed = Event.safeParse(normalized);
  if (!parsed.success) {
    process.stderr.write('opensquid: invalid PreToolUse payload schema\n');
    process.exit(0);
  }

  const sessionId = extractSessionId(raw);
  // GS1: extracted once here so both the orchestrator guard block and the v2 gate call share
  // the same value. extractAgentId handles all parse errors internally (fail-open → undefined).
  const agentId = extractAgentId(raw);
  // #26 — the outbound work-graph→harness reconcile nudge (a bound wg issue closed ahead of its still-open
  // task). Captured at the mirror seam below, delivered via the non-deny `additionalContext` path further down.
  let harnessSyncInstruction: string | null = null;
  // G.5 — append this tool name to the session's per-turn ledger BEFORE
  // dispatching. Best-effort: a ledger-write failure must never block the
  // pending tool call (fail-open guarantee of the hook bin). The Stop-event
  // freshness rule reads this ledger via `session_tool_history`.
  if (parsed.data.kind === 'tool_call') {
    try {
      const cmd = (parsed.data.args as { command?: unknown }).command;
      await appendTool(sessionId, parsed.data.tool, typeof cmd === 'string' ? cmd : undefined);
    } catch (e) {
      process.stderr.write(`opensquid: tool-ledger append failed — ${String(e)}\n`);
    }
    // MAU.3 — record the session cwd so the SessionEnd memory reconcile can
    // resolve this project's auto-memory dir (SessionEnd carries no cwd).
    if (parsed.data.cwd !== undefined && parsed.data.cwd !== '') {
      try {
        await recordSessionCwd(sessionId, parsed.data.cwd);
      } catch (e) {
        process.stderr.write(`opensquid: session-cwd record failed — ${String(e)}\n`);
      }
    }
    // AP.1 — mirror the harness task store into active-task.json (the
    // tasks-loaded signal the gate-set keys off). Best-effort, like the writes
    // above: a mirror failure must never block the pending tool call.
    try {
      await mirrorActiveTask(
        sessionId,
        parsed.data.tool,
        parsed.data.args ?? {},
        undefined,
        extractTranscriptPath(raw),
      );
    } catch (e) {
      process.stderr.write(`opensquid: active-task mirror failed — ${String(e)}\n`);
    }
    // #26 — materialize the harness task list into the work-graph (the harness list is authoritative; the
    // work-graph is its view). Reuses the SAME (sessionId, tool, args, transcriptPath) seam as the mirror
    // above; internally gated to Task* ticks + fully fail-open (returns null on any error). The returned
    // one-line nudge (a wg issue closed ahead of its still-open task) is surfaced on the non-deny path below.
    try {
      harnessSyncInstruction = await runHarnessGraphSync(
        sessionId,
        parsed.data.tool,
        parsed.data.args ?? {},
        extractTranscriptPath(raw),
      );
    } catch (e) {
      process.stderr.write(`opensquid: harness→work-graph sync failed — ${String(e)}\n`);
    }
    // Workflow stage advancement is no longer hardcoded here — the opt-in
    // `coding-flow` pack's scope-lifecycle skill catches these same
    // milestone writes (research artifact / track spec / TaskCreate provenance)
    // through the dispatcher and advances its lifecycle FSM. See
    // T-FSM-UNIFY.
  }
  // #36 — cwd computed once, shared by the safety floor and the orchestrator guard below.
  // The kind check is part of the expression so it remains valid outside the tool_call branch.
  const cwd =
    parsed.data.kind === 'tool_call' && 'cwd' in parsed.data && typeof parsed.data.cwd === 'string'
      ? parsed.data.cwd
      : process.cwd();
  // T2 — the Safety FLOOR: an absolute, always-on forbidden-action policy checked BEFORE the tool runs
  // (a SECOND blocking check beside the coding-flow gate below — deny if EITHER blocks). Substrate, not
  // a pack: it fires under every agent regardless of pack. FAIL-OPEN: any error here must NEVER block.
  if (parsed.data.kind === 'tool_call') {
    try {
      // Resolve YOLO for THIS project (env → project config → global config). The event cwd selects the
      // project so a per-repo override applies; YOLO downgrades the DANGEROUS tier block→warn (hardline never).
      const verdict = checkSafety(
        { tool: parsed.data.tool, args: parsed.data.args },
        await loadSafetyPolicy(),
        { dangerousToWarn: await isYoloMode(cwd) },
      );
      if (verdict.action === 'block' || verdict.action === 'halt') {
        const msg = `🦑 [safety floor] ${verdict.message ?? 'forbidden action'}`;
        process.stdout.write(JSON.stringify(buildPreToolUseDeny(msg, '')));
        process.exit(0);
      }
      if (verdict.action === 'warn') {
        // YOLO: a dangerous-tier action was downgraded block→warn. Surface it LOUDLY (never silent) and
        // record it to the project drift counter, then let the tool run. hardline can never reach here.
        process.stderr.write(
          `🦑 [safety floor · YOLO] ${verdict.message ?? 'dangerous action'} — allowed (block→warn). ` +
            `hardline rules (rm -rf, substrate delete, .env) still enforced.\n`,
        );
        try {
          await appendProjectDriftEvent(cwd, {
            timestamp: new Date().toISOString(),
            pack: '<safety-floor>',
            ruleId: `safety:${verdict.ruleId ?? 'dangerous'}`,
            level: 'warn',
            message: verdict.message ?? '',
          });
        } catch {
          /* fail-open: recording a warn must never block the call */
        }
      }
    } catch {
      /* fail-open: a Safety-floor error never blocks the call (the hook's fail-open contract) */
    }
  }

  // GS1 — the Orchestrator guard: the main (orchestrator) loop is a PLANNER; it must not directly
  // implement — deny CODE-EDITING (Write/Edit/NotebookEdit, or a file-writing Bash: sed -i, `>`/`>>`,
  // tee, cp/mv) in the main loop and require an executor subagent instead. It sits AFTER the safety
  // floor and BEFORE pack dispatch, using the same FU.11 deny-envelope + exit(0) pattern.
  //
  // project-only-operation Step 1a — PACK-DECLARED DISCIPLINE GATE: the guard's MECHANISM lives in opensquid
  // (`checkOrchestratorGuard`); its ACTIVATION is a POLICY a project pack declares. The guard fires ONLY when
  // an activated PROJECT pack at `cwd` declares `discipline: { orchestrator_only: true }` (pack_v2.ts) — NOT on
  // the coarse "any active project pack" it replaced. A content/SEO project (packs without the declaration) does
  // NOT get the guard (the RaumPilates content-project misfire fix); a project running fullstack-flow (which
  // DOES declare it) keeps the guard. `projectDeclaresOrchestratorOnly` resolves the project from `cwd`
  // (walks up from cwd, rejecting the user/home scope root — the home-scope-leak fix), loads its project-scope
  // pack set (project-only: global enforces nothing), and checks the declaration. A pack-less cwd → no project
  // scope → false → no guard (the interactive-deadlock fix stays). fail-open: any error never blocks the call.
  //
  // NOTE the safety FLOOR above is UNCHANGED — it stays universal substrate and fires unconditionally regardless
  // of packs (machine-protection, not discipline). Only this DISCIPLINE guard became pack-declared.
  //
  // ALWAYS-ON, PROJECT-SCOPED (user spec 2026-07-05): the doc-only rule holds AT ALL TIMES in this project's cwd
  // + subdirectories — NOT stage-gated, NOT automation-gated. The prior `OPENSQUID_AUTOMATION=1` condition is
  // REMOVED: it left the INTERACTIVE orchestrator (the actual freehand risk — the agent at the keyboard, not the
  // human) completely unguarded, and it over-broadly blocked ALL writes. Now the guard fires whenever THIS
  // project declares `orchestrator_only`, and it blocks only CODING-FILE writes (documents always pass), so a
  // human's / orchestrator's `docs/**` or `*.md` write is never blocked.
  //
  // CRUCIAL — ONLY THIS PROJECT (user: "this is not global"): `projectDeclaresOrchestratorOnly(cwd)` resolves the
  // project from `cwd` upward, REJECTS the user/home scope root (the home-scope-leak fix), and checks the
  // declaration in THAT project's pack set. A cwd outside this project tree, or a project without the
  // declaration, gets NO guard. The permission flag is project-local too (`<projectRoot>/.opensquid/...`).
  //
  // THE "unless" — a STANDING human grant: the `allow_code_write` boolean in this project's orchestrator.json
  // (single owner: orchestrator_settings; flipped only by the `/code-write` CLI via a server-side write). True →
  // coding-file writes are permitted (holds until toggled off); false/absent → coding files are hard-blocked
  // while documents still pass. BACK-COMPAT (one release): the retired `.opensquid/allow-code-write` flag file
  // still grants when present, so an in-the-wild flag keeps working until it is migrated away.
  //
  // Executor exemption: a Task/Agent subagent's PreToolUse payload carries `agent_id` (per the CC hook docs) —
  // `checkOrchestratorGuard` passes those through untouched. `exitIfSubagent` (above) already terminated
  // OPENSQUID_SUBAGENT=1 laps/reviewers, so this guard only sees the main loop and CC-native Task/Agent children.
  // Reads + orchestration commands (git, pnpm, grep, cd, Read, Agent, mcp__*) are not coding-file mutations →
  // always allowed. FAIL-OPEN: any error here never blocks the call.
  if (parsed.data.kind === 'tool_call') {
    try {
      if (await projectDeclaresOrchestratorOnly(cwd)) {
        // resolveProjectScopeRoot returns the `.opensquid` scope dir itself; readSettings takes the project dir
        // (its parent). Grant when the config value is true OR (back-compat) the retired flag file still exists.
        const scopeRoot = await resolveProjectScopeRoot(cwd);
        const allowByConfig =
          scopeRoot !== null && (await readSettings(dirname(scopeRoot))).allow_code_write === true;
        const allowByLegacyFlag =
          scopeRoot !== null && existsSync(join(scopeRoot, 'allow-code-write'));
        const codeWritePermitted = allowByConfig || allowByLegacyFlag;
        const verdict = checkOrchestratorGuard(
          parsed.data.tool,
          parsed.data.args,
          agentId !== undefined ? { agent_id: agentId } : undefined,
          { codeWritePermitted },
        );
        if (verdict.deny) {
          process.stdout.write(JSON.stringify(buildPreToolUseDeny(verdict.message ?? '', '')));
          process.exit(0);
        }
      }
    } catch {
      /* fail-open: an orchestrator-guard error never blocks the call */
    }
  }

  const packs = await loadActivePacksForDispatch(sessionId);
  const registry = await buildRegistry();

  // CHS.2 — codex's file-edit tool is `apply_patch` (patch text in
  // args.command); no pack rule matches that name. Normalize: ONE
  // synthesized single-path Write per touched file (every PATH predicate
  // dialect sees a normal file_path; Add carries TRUE final content,
  // Update/Delete a labeled hunk diff — never silently-stale). First deny
  // wins (the FU.11 envelope); all-allow → clean exit. Zero parsed paths →
  // fall through untouched (fail-open for unknown envelope variants).
  if (parsed.data.kind === 'tool_call' && parsed.data.tool === 'apply_patch') {
    const cmd = (parsed.data.args as { command?: unknown }).command;
    const patched = typeof cmd === 'string' ? parseApplyPatch(cmd) : [];
    if (patched.length > 0) {
      for (const f of patched) {
        const synth = {
          ...parsed.data,
          // Deliberately Write for ALL kinds: effective_content must take
          // the args.content branch, never the stale-file Edit branch.
          tool: 'Write',
          args: { file_path: f.path, content: f.content, apply_patch_command: cmd },
        };
        const r = await dispatchEvent(synth, packs, registry, sessionId);
        if (r.exitCode === 2) {
          process.stdout.write(JSON.stringify(buildPreToolUseDeny(r.stderr, '')));
          process.exit(0);
        }
        if (r.stderr) process.stderr.write(r.stderr + '\n');
      }
      process.exit(0); // every touched path allowed
    }
  }

  const v1 = await dispatchEvent(parsed.data, packs, registry, sessionId);
  // VS.2 (T-v2-skill-host): v1 dispatch walks only v1 Pack[]; the active v2 cartridges' SKILLS
  // (pause-guard, lenses) run HERE through the same dispatch machinery, so they actually enforce —
  // pause-guard (load:preload) blocks AskUserQuestion past SCOPE. FAIL-OPEN inside runV2SkillHost.
  const skillHost = await runV2SkillHost(
    await loadActiveV2Cartridges(sessionId),
    parsed.data,
    registry,
    sessionId,
  );
  // PART A — v2 FSM gate enforcement (enforceOnly: true): evaluate gates BEFORE the tool runs without
  // advancing state. PostToolUse advances state + records observability; this is ONLY the blocking check.
  // Blast radius today = zero (no active v2 cartridges — runV2Cartridges returns ZERO immediately).
  // FAIL-OPEN: runV2Cartridges is already fail-open per-cartridge; a total crash here exits 0 (below).
  //
  // PART 1 — automation gate: only invoke enforceOnly enforcement under automation. In an interactive
  // session (no OPENSQUID_AUTOMATION=1 env), skip the enforce call entirely (return ZERO decision)
  // so the hook NEVER blocks legitimate interactive work. ENV-ONLY (Hole 2): the per-session flag
  // file is deliberately NOT checked here — a stale flag from a prior automation lap would bleed
  // into interactive sessions sharing the same session id, blocking human tool calls. Only the env
  // var (set by the orchestrator for its subprocess) is used. The PostToolUse (non-enforceOnly) path
  // is UNCHANGED — advances state + observes regardless.
  const isAutomation = process.env.OPENSQUID_AUTOMATION === '1';
  const v2Gate: V2Decision = isAutomation
    ? await runV2Cartridges(sessionId, parsed.data, new Date().toISOString(), {
        enforceOnly: true,
        ...(agentId !== undefined ? { agentId } : {}),
      })
    : { exitCode: 0, messages: [], injections: [], boundSkills: [] };
  const exitCode: 0 | 2 =
    v1.exitCode === 2 || skillHost.exitCode === 2 || v2Gate.exitCode === 2 ? 2 : 0;
  // v2Gate.messages are the block/halt instructions; only include them in the deny when v2Gate triggered.
  const gateMessages = v2Gate.exitCode === 2 ? v2Gate.messages : [];
  const stderr = [v1.stderr, skillHost.stderr, ...gateMessages]
    .filter((s) => s.length > 0)
    .join('\n');
  const contextInjections = [
    ...v1.contextInjections,
    ...skillHost.contextInjections,
    // #26 — the outbound harness-reconcile nudge rides the same non-blocking additionalContext channel.
    ...(harnessSyncInstruction !== null ? [harnessSyncInstruction] : []),
  ];
  // T-RJ-FOLLOWUPS FU.11: a block must be signalled as a PreToolUse
  // `permissionDecision: "deny"` JSON decision, NOT a bare `exit 2`. Proven live:
  // under `--dangerously-skip-permissions` (= bypassPermissions) Claude Code
  // IGNORES a hook's `exit 2` (the tool runs anyway), but it HONORS a
  // `permissionDecision: "deny"` envelope. Emitting the JSON (exit 0) makes drift
  // gates enforce in BOTH normal and bypass modes. Gated strictly on
  // `exitCode === 2` so a non-block never accidentally denies the tool.
  if (exitCode === 2) {
    // Forward guidance now comes from the blocking gate's own message + the
    // coding-flow pack's handoff directives (no global chain forward-map).
    const guidance = '';
    process.stdout.write(JSON.stringify(buildPreToolUseDeny(stderr, guidance)));
    process.exit(0);
  }
  // GI.5 channel (b): on the NON-deny path, surface any phase bundle the dispatch collected (the
  // coding-flow gate's `phase_inject` mid-turn catch) as a non-blocking PreToolUse `additionalContext`
  // envelope (`permissionDecision:"defer"` → the tool's permission outcome is untouched). Empty → null →
  // nothing emitted, so the common no-injection path is byte-for-byte unchanged. Stdout (the envelope)
  // and stderr (drift, via the tail below) are independent streams, so both can be delivered.
  const ctxOut = buildPreToolUseContext(contextInjections.join('\n\n'));
  if (ctxOut !== null) process.stdout.write(JSON.stringify(ctxOut));
  emitDriftStderrAndExit(exitCode, stderr);
}

main().catch((e: unknown) => {
  // Fail-open: never crash the parent agent on opensquid's own bug.
  process.stderr.write(`opensquid hook crash (pre-tool-use): ${String(e)}\n`);
  process.exit(0);
});
