/**
 * GR.4 — the `opensquid loop` CLI: the user-invoked entry that ASSEMBLES the orchestrator's injected deps
 * and runs the gated-ralph loop. A thin wire — all logic lives in the unit-tested pieces it composes
 * (runRalphLoop, chatEscalator, the harness adapter + outcomeFromEnvelope, the GR.1–3 store ops). The loop is a CLI COMMAND, not a
 * daemon (opensquid stays an MCP server / tool provider; the agent loop runs inside the spawned harness).
 *
 * Commands:
 *   opensquid loop [--max-budget-usd <n>]               — run the loop to exhaustion (ready → claim → lap → repeat)
 *   opensquid loop resolve <itemId> --misclassified     — the human-override residual-shrink path (GR.4)
 *
 * Imports from: commander, node:net, ../../runtime/paths.js, ../../runtime/spawn_lifecycle.js,
 * ../../runtime/ralph/*, ../../workgraph/*, ../wizard/ralph_writer.js.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Command } from 'commander';
import { OPENSQUID_HOME, resolveLocalStoreDir } from '../../runtime/paths.js';
import { sendChat } from '../../chat_daemon/client.js';
import {
  loadChannelsConfig,
  resolveConfiguredChannel,
  resolveUmbrellaForCwd,
} from '../../channels/routing.js';
import type { LapEscalator } from '../../runtime/ralph/escalate_lap.js';
import {
  isOwnedProcessCleanupError,
  realProcControl,
  runOneShotCli,
} from '../../runtime/spawn_lifecycle.js';
import { runStreamingCli } from '../../runtime/streaming_cli.js';
import { resolveActorId } from '../../runtime/actor_id.js';
import { loadActiveV2Cartridges } from '../../runtime/bootstrap.js';
import { readFsmState } from '../../runtime/fsm_state.js';
import { workGraphStore } from '../../workgraph/store.js';
import { harnessMapStore } from '../../workgraph/harness_map.js';
import { reconcileHarnessWorkgraph } from '../../workgraph/harness_sync.js';
import { ccNudgeWriter } from '../../runtime/hooks/harness_writer.js';
import { resolveWgProject } from '../../runtime/loop/plan_evidence.js';
import { claimAudience } from '../../workgraph/audience.js';
import type { Issue } from '../../workgraph/types.js';
import { runRalphLoop, resolveParked, type RalphConfig } from '../../runtime/ralph/orchestrator.js';
import { makeRalphGitSeam } from '../../runtime/ralph/consistency_gate.js'; // CG.1 — the consistency-gate git seam
import { resolveEnvironments } from '../../packs/discovery.js'; // GF.1 — the config-driven git-flow environments reader
import { reconcileBase } from '../../runtime/ralph/auto_pull.js'; // GF.6 — the base-refresh reconcile
import { routeOnShipped } from '../../runtime/ralph/route_on_shipped.js'; // GF.3 — the config-driven onShipped route
import { integrateBranchToStage } from './release.js'; // GF.3/GF.7 — the config-driven integrate SSOT
import { ensureProductionPr } from '../../runtime/release/stage_pr.js'; // GF.7 — the idempotent auto-PR
import { recordStageMetric } from '../../runtime/loop/loop_metrics.js';
import { emitMonitorEvent } from '../../runtime/loop/monitor_emit.js';
import {
  automationAdmission,
  clearLoopStage,
  readLoopStage,
  upsertTaskStage,
} from '../../runtime/ralph/loop_stage.js';
import { LOOP_LAP_ENV, isLoopLap } from '../../runtime/hooks/subagent_guard.js';
import { displayReport } from '../../runtime/loop/report_display.js'; // RD.2/RD.3 — the live-display primitive
import type { LapResult } from '../../runtime/ralph/supervisor.js';
import { outcomeFromEnvelope } from '../../runtime/ralph/lap_outcome.js';
import {
  resolveLapHarness,
  type HarnessConfig,
  type HarnessRuntimeAssets,
} from '../../runtime/ralph/lap_harness.js';
import { defaultHarnessRuntimeAssets } from '../../integrations/pi/runtime.js';
import { recordMisclassification } from '../../runtime/ralph/decision_classifier.js';
import { chatEscalator, type ChatSend } from '../../runtime/ralph/escalator.js';
import { readRalphConfig, type RalphConfigFile } from '../wizard/ralph_writer.js';
import { registerLoopProcess } from '../../cli/loop_process.js';
import { completeInteractiveScope, ScopeHandoffError } from '../../runtime/ralph/scope_done.js';
import { publishLoopReadiness, resolveLoopProject } from '../../runtime/ralph/loop_autospawn.js';
import { acquireLoopOwner } from '../../runtime/ralph/loop_owner.js';
import {
  controlledOwnedProcess,
  isProcessPausedError,
  listOwnedProcesses,
  type OwnedProcessState,
} from '../../runtime/processes/process_control.js';

const PROCESS_DRAIN_TIMEOUT_MS = 2_000;

export function previousOwnedProcessDrainError(
  states: readonly OwnedProcessState[],
): string | null {
  return states.length === 0
    ? null
    : `previous loop still owns ${String(states.length)} active process(es)`;
}

export async function reconcilePreviousOwnedProcesses(
  load: () => Promise<OwnedProcessState[]> = () => listOwnedProcesses(true),
  timeoutMs = PROCESS_DRAIN_TIMEOUT_MS,
): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const states = await Promise.race([
      load(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`process reconciliation timed out after ${String(timeoutMs)}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return previousOwnedProcessDrainError(states);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * T-project-local-state PLS.2: the ralph loop drains THIS project's ready queue from the PROJECT-LOCAL
 * `<root>/.opensquid/workgraph.db`, discovered by walking up from cwd (like `git` finds `.git`). No project
 * UUID is resolved or published — the loop, its spawned laps, and the MCP all resolve the SAME local store
 * from their shared cwd, so they cannot diverge (the namespace flip is structurally impossible). Returns the
 * store directly (a {@link WorkGraphStore} IS a {@link WorkGraphFacade}); no `bindProject` binding step.
 */
async function openRalphWorkGraph() {
  const dir = await resolveLocalStoreDir(process.cwd());
  const store = workGraphStore({
    dbUrl: `file:${join(dir, 'workgraph.db')}`,
    sourceDir: join(dir, 'store', 'issues'),
    actorId: await resolveActorId(), // WGD.1 — stamp the per-replica id on ops
    // F1a — the loop's own store pushes a close event from the ONE boundary (replacing the orchestrator's
    // per-caller manual emits): the SHIPPED close + every rolled-up parent close now reach the feed from here.
    onIssueTerminal: (id) =>
      void emitMonitorEvent({ wgId: id, kind: 'item_closed', atMs: Date.now() }),
  });
  await store.init();
  return store;
}

/** Hydrate the persisted scalar config into the orchestrator's runtime `RalphConfig` (closures rebuilt).
 *  LSF.5: `harness` = the configured CLI; `runId` identifies THIS loop invocation (injectable for deterministic
 *  tests, else stamped from the wall clock — one id shared by every per-stage loop_metrics row of the run). */
export function buildRalphConfig(
  file: RalphConfigFile,
  opts: { maxBudgetUsd?: number; runId?: string },
): RalphConfig {
  return {
    authMode: file.authMode,
    maxBudgetUsd: opts.maxBudgetUsd ?? file.maxBudgetUsd,
    claimTtlSec: file.claimTtlSec,
    supervise: {
      maxRetries: file.maxRetries,
      backoffMs: (attempt: number) => file.backoffBaseMs * 2 ** attempt, // exponential from the base
      heartbeat: () => undefined, // a future lease-refresh; liveness tick is a no-op for the CLI run
    },
    harness: file.harness.cli,
    runId: opts.runId ?? `run-${new Date().toISOString()}`,
  };
}

/** Build the per-lap runner: resolve the harness adapter from the config `kind`, spawn the RALPH.md lap
 * through it, and fold its envelope into the typed exit. The transport bounds inactivity—not productive elapsed
 * work—and still owns bounded tree cleanup; a genuine spawn failure remains eligible for bounded recovery. */
export function makeSpawnLap(
  cfg: RalphConfig,
  file: RalphConfigFile,
  runCli: typeof runOneShotCli = runOneShotCli,
  runtime: {
    runStreaming?: typeof runStreamingCli;
    assets?: HarnessRuntimeAssets;
    attemptId?: () => string;
    cwd?: string;
  } = {},
): (item: Issue, stagePrompt?: string, checkpointStage?: string) => Promise<LapResult> {
  // One composed runtime per loop process. Behavioral readiness is memoized only after success, so fresh laps
  // share verified evidence while a failed preflight remains retryable without re-probing on every stage.
  const harnessAssets = runtime.assets ?? defaultHarnessRuntimeAssets();
  return async (item: Issue, stagePrompt?: string, checkpointStage?: string) => {
    // wg-5729c7afafad: deliver the RALPH.md CONTENT (not its path) as the stdin prompt, with the item id
    // appended — `claude -p` reads the prompt from stdin (empirically verified). Fail loud if the directive
    // is missing (a setup problem, not a retryable lap CRASH).
    let ralphMd: string;
    try {
      ralphMd = await readFile(file.harness.ralphMdPath, 'utf8');
    } catch {
      throw new Error(
        `RALPH.md not found at ${file.harness.ralphMdPath} — run \`opensquid loop\` (installRalph) to create it`,
      );
    }
    const prompt =
      ralphMd +
      `\n\n---\nYour assigned work-item id: ${item.id}\n(Read it with workgraph_get("${item.id}").)\n` +
      `Captured work-item ask (verbatim):\n${item.title}\n${item.body}\n` +
      // PSL.3 — the per-stage directive (when the orchestrator drives this item per-stage). Appended LAST so it
      // is the most-specific instruction (it narrows RALPH.md's "do the whole item" to "do ONLY this stage").
      // The lap's OWN stage_inject hook supplies the stage's checkpoint/procedure/rubric/work-context (its own
      // session) — the directive only constrains this disposable attempt's scope.
      (stagePrompt === undefined ? '' : `\n---\n${stagePrompt}\n`);
    // Per-lap log — capture the subprocess's stderr/stdout + outcome so a WEDGED or CRASHED lap is diagnosable
    // afterward (best-effort: logging never breaks a lap). One file per lap under ~/.opensquid/lap-logs/.
    const logDir = join(OPENSQUID_HOME(), 'lap-logs');
    const logPath = join(
      logDir,
      `${item.id}__${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
    );
    const appendLog = (body: string): void => {
      void mkdir(logDir, { recursive: true })
        .then(() => appendFile(logPath, body, 'utf8'))
        .catch(() => undefined); // logging is best-effort — swallow any fs error
    };
    // MHL.6 — resolve the harness adapter from the config's `kind` (throws on an unresolved kind, reinforcing
    // the load-time fail-loud). ALL harness-specifics (flags, prompt delivery, envelope parse, auth preflight)
    // come from the adapter; this core stays neutral (audit-grep-empty, MHL.8).
    const adapter = resolveLapHarness(file.harness.kind);
    const lapConfig: HarnessConfig = { ...file.harness, maxBudgetUsd: cfg.maxBudgetUsd };
    const attemptId = (runtime.attemptId ?? randomUUID)();
    const lapCwd = runtime.cwd ?? process.cwd();
    const request = {
      prompt,
      cwd: lapCwd,
      timeoutMs: file.idleTimeoutMs,
      env: {
        OPENSQUID_ITEM_ID: item.id,
        OPENSQUID_SESSION_ID: attemptId,
        OPENSQUID_AUTOMATION: '1',
        OPENSQUID_RUN_ID: cfg.runId,
        ...(checkpointStage === undefined ? {} : { OPENSQUID_CHECKPOINT_STAGE: checkpointStage }),
        [LOOP_LAP_ENV]: '1',
        ...(file.harness.kind === 'pi' ? { OPENSQUID_PI_CLI: file.harness.cli } : {}),
      },
      attemptId,
      onStderrLine: (line: string) =>
        process.stdout.write(`    │ ${item.id.slice(3, 11)} ${line}\n`),
      onStreams: ({
        stdout: out,
        stderr,
        code,
      }: {
        stdout: string;
        stderr: string;
        code: number | null;
      }) => {
        appendLog(
          `# lap ${item.id} · attempt=${attemptId} · exit=${code} · ${new Date().toISOString()}\n` +
            `=== STDERR ===\n${stderr.trim() || '(empty)'}\n\n=== STDOUT (tail) ===\n${out.slice(-6000)}\n`,
        );
      },
    };
    const oneShotControl =
      file.harness.kind === 'pi'
        ? null
        : controlledOwnedProcess({
            processId: `${file.harness.kind}-stage-${attemptId}`,
            wgId: item.id,
            runId: cfg.runId,
            ...(checkpointStage === undefined ? {} : { checkpointStage }),
            lap: 1,
            role: 'stage-process',
            ownership: 'control_root',
            base: realProcControl,
          });
    const controlledRunCli: typeof runOneShotCli = (options) =>
      runCli({
        ...options,
        ...(oneShotControl === null
          ? {}
          : {
              procControl: oneShotControl.procControl,
              onShutdownRequested: () => oneShotControl.markAutomaticShutdown(),
            }),
      });
    const deps = {
      runOneShot: controlledRunCli,
      runStreaming: runtime.runStreaming ?? runStreamingCli,
      assets: harnessAssets,
    };
    let env;
    try {
      await adapter.preflight?.(lapConfig, deps, request);
      env = await adapter.run(request, lapConfig, deps);
    } catch (e) {
      appendLog(`\n=== LAP ERROR ===\n${e instanceof Error ? e.message : String(e)}\n`);
      if (isProcessPausedError(e)) {
        return {
          kind: 'HUMAN_REQUIRED',
          reason: e.cause.action === 'graceful_stop' ? 'PROCESS_PAUSED' : 'CANCELLED_BY_HUMAN',
          payload: {
            processId: e.processId,
            action: e.cause.action,
            actionId: e.cause.actionId,
          },
          costUsd: 0,
        };
      }
      const oneShotCause = oneShotControl?.shutdownCause() ?? null;
      if (oneShotCause?.kind === 'human') {
        return {
          kind: 'HUMAN_REQUIRED',
          reason: oneShotCause.action === 'graceful_stop' ? 'PROCESS_PAUSED' : 'CANCELLED_BY_HUMAN',
          payload: { action: oneShotCause.action, actionId: oneShotCause.actionId },
          costUsd: 0,
        };
      }
      if (isOwnedProcessCleanupError(e)) {
        return {
          kind: 'HUMAN_REQUIRED',
          reason: 'UNRECOVERABLE_WEDGE',
          payload: { error: e.message, cause: e.cause.message },
          costUsd: 0,
        };
      }
      if ((e as { __timeout?: boolean }).__timeout === true) {
        return { kind: 'TIMEOUT', costUsd: 0 };
      }
      throw e;
    }
    const { outcome, costUsd, inputTokens, outputTokens } = outcomeFromEnvelope(env);
    appendLog(
      `\n=== PARSED OUTCOME === ${JSON.stringify(outcome)} · cost=$${costUsd} · ` +
        `${String(inputTokens)}in/${String(outputTokens)}out\n`,
    );
    // LSF.5 — carry the lap's token usage up so the orchestrator can fold it into the per-stage loop_metrics row.
    return { ...outcome, costUsd, inputTokens, outputTokens, attemptId };
  };
}

/** The real chat transport: the SHARED one-shot daemon `send` client (`chat_daemon/client.ts` — the SAME
 * path `chat_send` + the runtime report→chat surface use, incl. its win32 named-pipe branch + `threadId`
 * forwarding). `ok:false` on any unreachable/error so the escalator stays honest (the caller decides
 * fatal-vs-fail-open). Forwards `threadId` so an escalation lands in the resolved forum TOPIC, not the group root. */
export const daemonChatSend: ChatSend = async (params) => {
  try {
    await sendChat({
      channel: params.channel,
      text: params.text,
      ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
};

/**
 * Resolve THIS loop's project cwd → its escalation `LapEscalator`, reusing the shared platform-agnostic
 * resolver (`resolveConfiguredChannel`, the SAME cwd→umbrella→`<platform>:<native_id>`+topic resolution the
 * runtime report→chat surface uses — `v2_supply.surfaceReportToChat`; the `<platform>` follows the
 * configured pointer in channels.json, not a literal). The old `project:telegram` shorthand was
 * REJECTED by the daemon gateway (`parseChannel`: platform `project` is not a wire platform) → every
 * escalation failed with "unknown platform 'project'" and crashed the loop. When the cwd has NO chat binding
 * (no `channels.json` / no umbrella owns the cwd) we cannot build a channel: return an HONEST no-delivery
 * escalator (`escalated:false`). A resource-pause notice then fails open (non-fatal) in `parkAndEscalate`,
 * while a residual wedge still throws loudly (Inv 6). Fail-open on load: a broken config must not crash the loop.
 */
export async function resolveLoopEscalator(cwd: string): Promise<LapEscalator> {
  const cfg = await loadChannelsConfig().catch(() => null);
  const umbrella = cfg === null ? null : resolveUmbrellaForCwd(cfg, cwd);
  const resolved =
    cfg !== null && umbrella !== null && umbrella !== ''
      ? resolveConfiguredChannel(cfg, umbrella)
      : null;
  if (resolved === null) {
    return () => Promise.resolve({ escalated: false, reason: `no chat binding for cwd ${cwd}` });
  }
  return chatEscalator({
    send: daemonChatSend,
    channel: resolved.channel,
    ...(resolved.threadId !== undefined ? { threadId: resolved.threadId } : {}),
  });
}

/** The generic StageProcess directive. The opaque state id and all authority come from the active pack. */
export function perStageDirective(stage: string): string {
  return [
    `## StageProcess assignment (the coordinator runs one fresh process per pack stage)`,
    `You are assigned ONLY the opaque pack stage **${stage}** — not the whole flow.`,
    `Follow that stage's pack-provided procedure, rubric, tools, and authority; complete its gate, then STOP.`,
    `Do not start another workflow loop or another stage process. The coordinator alone owns progression and retry.`,
    `Do NOT proceed into later stages — the coordinator starts the next peer with fresh context.`,
    `Exit with exactly one RALPH-EXIT SHIPPED tag after the assigned gate passes.`,
    `The coordinator reads the gate-accepted session receipt and alone persists the next durable stage.`,
    `If you genuinely cannot complete ${stage} (an irreversible boundary or a product fork the principles cannot`,
    `settle), escalate as usual with EXACTLY ONE valid reason, for example:`,
    `  RALPH-EXIT: {"kind":"HUMAN_REQUIRED","reason":"IRREVERSIBLE_BOUNDARY"}`,
    `  RALPH-EXIT: {"kind":"HUMAN_REQUIRED","reason":"SCOPE_FORK"}`,
  ].join('\n');
}

export function registerRalph(program: Command): Command {
  const loop = program
    .command('loop')
    .description("Run the deterministic outer loop using the project's active pack declarations");

  loop
    .option('--max-budget-usd <n>', 'API-mode dollar budget for this run (overrides config)')
    .action(async (opts: { maxBudgetUsd?: string }) => {
      // scope-1 (T-in-lap-gating) — RECURSION GUARD: a lap already owns this process tree (it publishes
      // OPENSQUID_LOOP_LAP=1). Refuse to start a NESTED loop — the genuine recursion protection the retired
      // The loop-lap marker prevents recursion: a StageProcess must not start another workflow loop.
      if (isLoopLap()) {
        process.stderr.write(
          '🦑 loop OFF: refusing to start a nested loop inside a lap (OPENSQUID_LOOP_LAP set).\n',
        );
        process.exitCode = 1;
        return;
      }
      const file = await readRalphConfig();
      if (file === null) {
        process.stderr.write(
          '🦑 loop OFF: no ~/.opensquid/ralph.config.json. Run the wizard first.\n',
        );
        process.exitCode = 1;
        return;
      }
      // F6 (T-v2-audit): mark THIS process as a true autonomous run. runOneShotCli spawns each lap with
      // `...process.env`, so the lap's claude + its hook bins inherit OPENSQUID_AUTOMATION=1 — the per-process
      // signal the run-to-done Stop gate keys off. (The persistent automation.flag bleeds across an interactive
      // session and must NOT drive a turn-end BLOCK; only a genuine lap process carries this env.)
      process.env.OPENSQUID_AUTOMATION = '1';
      const cfg = buildRalphConfig(file, {
        ...(opts.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: Number(opts.maxBudgetUsd) }),
      });
      const sid = process.env.CLAUDE_SESSION_ID ?? '<cli>';
      const root = process.cwd();
      const project = await resolveLoopProject(root);
      const admission = await acquireLoopOwner(
        project,
        (error) => {
          process.stderr.write(`🦑 loop owner lost: ${error.message}\n`);
          process.kill(process.pid, 'SIGTERM');
        },
        async () => {
          const drainError = await reconcilePreviousOwnedProcesses();
          if (drainError !== null) throw new Error(drainError);
        },
      );
      if (admission.status === 'occupied') {
        if (admission.owner === undefined) {
          publishLoopReadiness({
            status: 'error',
            error: admission.error ?? 'loop-owner endpoint is occupied but has no valid owner',
          });
        } else {
          publishLoopReadiness({ status: 'occupied', pid: admission.owner.pid });
        }
        process.stdout.write(
          `${JSON.stringify({
            kind: 'loop_owner',
            status: admission.owner === undefined ? 'error' : 'already_running',
            ...(admission.owner === undefined ? {} : { pid: admission.owner.pid }),
            ...(admission.error === undefined ? {} : { error: admission.error }),
          })}\n`,
        );
        if (admission.owner === undefined) process.exitCode = 1;
        return;
      }
      const ownerLease = admission.lease;
      // Push readiness only after lifetime admission + owned-process drain + endpoint listen all succeeded.
      publishLoopReadiness({ status: 'acquired', pid: ownerLease.owner.pid });
      const storeDir = project.storeRoot;
      let signalExitStarted = false;
      const closeAndExit = (code: number): void => {
        if (signalExitStarted) return;
        signalExitStarted = true;
        void ownerLease.close().finally(() => process.exit(code));
      };
      const onSigint = (): void => closeAndExit(130);
      const onSigterm = (): void => closeAndExit(143);
      process.once('SIGINT', onSigint);
      process.once('SIGTERM', onSigterm);
      // Admission is held before the WorkGraph ready queue is opened, the pid projection is published, or any
      // claim can be entered. A losing candidate returned above without touching any of those surfaces.
      const rawWg = await openRalphWorkGraph();
      const wg = {
        ...rawWg,
        claimIssue: (...args: Parameters<typeof rawWg.claimIssue>) => {
          if (!ownerLease.isActive()) {
            throw new Error('loop owner lease was lost before WorkGraph claim');
          }
          return rawWg.claimIssue(args[0], args[1], args[2], () => ownerLease.isActive());
        },
      };
      // Select the one active pack that declares process-driven states. Names and state meanings remain in the
      // cartridge; the coordinator consumes only the generic compiled declaration.
      const automationCartridges = (await loadActiveV2Cartridges(sid, root)).filter(
        (loaded) => loaded.compiled.automation !== undefined,
      );
      if (automationCartridges.length > 1) {
        throw new Error(
          `multiple active packs declare automation: ${automationCartridges.map((loaded) => loaded.pack.name).join(', ')}`,
        );
      }
      const automationCartridge = automationCartridges[0];
      const automation = automationCartridge?.compiled.automation;
      const isAutomated = (stageId: string): boolean =>
        automationCartridge?.compiled.meta[stageId]?.automated === true;
      const stageLoop =
        automationCartridge === undefined || automation === undefined
          ? undefined
          : {
              initialStage: automation.entry,
              isAutomated,
              isTerminal: (stageId: string): boolean =>
                automationCartridge.compiled.meta[stageId]?.kind === 'terminal',
              stagePrompt: (_item: Issue, stageId: string): Promise<string> =>
                Promise.resolve(perStageDirective(stageId)),
              readStage: readLoopStage,
              readAttemptStage: (attemptId: string, itemId: string): Promise<string> =>
                readFsmState(
                  attemptId,
                  automationCartridge.pack.name,
                  automationCartridge.compiled.fsm!,
                  itemId,
                ),
              reconcileStage: (id: string, stageId: string): Promise<void> =>
                upsertTaskStage(id, stageId, Date.now(), null),
              clearStage: clearLoopStage,
              admissionGate: (item: Issue): Promise<'drive' | 'hold'> =>
                automationAdmission(item.id, isAutomated),
            };
      // GF.1/GF.2 — resolve the config-driven git-flow environments ONCE for the run (the consistency gate's
      // target + the base-refresh production branch). null ⇒ unconfigured ⇒ the gate is HEAD-based + no refresh.
      const environments = await resolveEnvironments(root);
      try {
        const result = await runRalphLoop(cfg, {
          wg,
          claimAudience,
          runLap: makeSpawnLap(cfg, file),
          escalate: await resolveLoopEscalator(root),
          // Live play-by-play: one timestamped line per step (claim / stage lap / advance / ship / park / drain)
          // so a detached `opensquid loop > loop.log` is watchable via `tail -f loop.log`.
          narrate: (msg: string) =>
            process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`),
          // The coordinator's live report channel is stdout; stage-process stderr uses its separate relay.
          display: (body: string) => displayReport(body, process.stdout),
          // CG.1 — the CONSISTENCY GATE: PRODUCTION always enforces it. The seam reads the loop repo root's live
          // git state at the SHIPPED-close boundary, so an item that ships without a durable commit for its work
          // is re-driven then parked `no-durable-commit` (never silently closed). Bound to `root` once (a factory).
          git: makeRalphGitSeam(root),
          // GF.2 — the config-target-aware consistency gate: the gate verifies the durable commit landed on the
          // configured integration target (staging ?? local), not merely HEAD. null ⇒ omit ⇒ HEAD-based (unchanged).
          ...(environments === null ? {} : { environments }),
          // GF.6 — the LIVE per-pass base-refresh: reconcile the base (environments.production) preserving
          // whoever's ahead (a trunk hot patch is never lost). null ⇒ omit ⇒ no base-refresh (unconfigured project).
          ...(environments === null
            ? {}
            : { baseRefresh: () => reconcileBase(root, environments.production) }),
          ...(stageLoop === undefined ? {} : { stageLoop }),
          // Generic application completion hook. Release routing reads only project configuration.
          onShipped: async (taskId) => {
            // GF.3 (T-gitflow-integration-fix) — the CONFIG-DRIVEN, FAIL-VISIBLE integration route. Resolve the
            // `version-control.environments` (GF.1); when unconfigured (null) do nothing further (a non-automated
            // project ships as today). When configured, `routeOnShipped` is a TOTAL function over the environments:
            // has-stage → integrate into `staging` (GF.4's FIXED context via the `integrateBranchToStage` SSOT) +
            // the staging→production PR (GF.7); no-stage → the loop-branch→production PR directly (GF.7). A failed
            // integration is SURFACED (logged live below) — it leaves NO durable target commit, so CG.1/GF.2's gate
            // blocks the SHIPPED close (never a swallowed phantom ship). Fail-open on the ROUTE call itself only so
            // an infra fault (no gh auth) never breaks the drain — the consistency gate still blocks the close.
            try {
              const env = await resolveEnvironments(root);
              if (env !== null) {
                const routed = await routeOnShipped(env, {
                  taskId,
                  root,
                  integrateToStaging: async (e, r) => {
                    const res = await integrateBranchToStage(e.local, r, { environments: e });
                    return res.url !== undefined
                      ? { integrated: res.integrated, prUrl: res.url }
                      : { integrated: res.integrated };
                  },
                  ensureProductionPr: (e, r) => ensureProductionPr(e, r),
                });
                process.stdout.write(`🦑 git-flow route: ${JSON.stringify(routed)}\n`);
              }
            } catch (e) {
              // FAIL-VISIBLE but non-fatal to the drain: log the fault; the missing durable target commit still
              // blocks the SHIPPED close via the consistency gate (GF.2). NEVER a silent swallow of the outcome.
              process.stdout.write(
                `🦑 git-flow route error (surfaced): ${e instanceof Error ? e.message : String(e)}\n`,
              );
            }
          },
          // LSF.5 (§3a) — fold each completed stage's cost/tokens/timing into the project-local loop_metrics
          // history. Injected so the orchestrator stays db-free/testable; the orchestrator wraps it fail-open.
          recordMetric: recordStageMetric,
          // #26 HWS.5(b) — the loop-pass harness↔workgraph reconcile: once per drained pass, observe
          // out-of-session wg changes off the shared op-log cursor (empty task list ⇒ wg→harness only) and
          // return the outbound nudge. Reuses the loop's project-local `wg` + a project-local harness map
          // (same `storeDir` the pidfile uses), so the tick and the loop-pass share ONE monotonic cursor.
          loopPassReconcile: async (): Promise<string | null> => {
            const project = await resolveWgProject(sid);
            const map = harnessMapStore(`file:${join(storeDir, 'harness_map.db')}`);
            await map.init();
            const cursor = await wg.readHighWater();
            const wgOps = await wg.listOpsSince(cursor);
            if (wgOps.length === 0) return null; // nothing new since the last reconcile
            const { outbound } = await reconcileHarnessWorkgraph(project, [], wgOps, wg, map);
            const nudge = await ccNudgeWriter.apply(outbound);
            await wg.advanceHighWater(Math.max(...wgOps.map((o) => o.lamport)));
            return nudge;
          },
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } finally {
        process.removeListener('SIGINT', onSigint);
        process.removeListener('SIGTERM', onSigterm);
        await ownerLease.close();
      }
    });

  registerLoopProcess(loop);

  loop
    .command('scope-done <itemId> <artifact>')
    .description('human scope-exit: persist scope proof and start/resume the loop')
    .action(async (itemId: string, artifact: string) => {
      try {
        const result = await completeInteractiveScope({
          wgId: itemId,
          artifact,
          cwd: process.cwd(),
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        if (result.loop.status === 'error') process.exitCode = 1;
      } catch (error) {
        const failure =
          error instanceof ScopeHandoffError
            ? error
            : new ScopeHandoffError(
                'persistence',
                itemId,
                error instanceof Error ? error.message : String(error),
              );
        process.stderr.write(
          `${JSON.stringify({
            kind: 'scope_handoff_error',
            code: failure.code,
            wgId: failure.wgId,
            error: failure.message,
          })}\n`,
        );
        process.exitCode = failure.code === 'persistence' ? 1 : 2;
      }
    });

  loop
    .command('resolve <itemId>')
    .description('Resolve a parked HUMAN_REQUIRED item (the human-override residual-shrink path)')
    .option(
      '--misclassified',
      'the escalation was principle-settleable — record + un-wedge for another lap',
      false,
    )
    .action(async (itemId: string, opts: { misclassified?: boolean }) => {
      if (opts.misclassified !== true) {
        process.stderr.write(
          'Nothing to do: pass --misclassified to record + un-wedge the item.\n',
        );
        return;
      }
      const wg = await openRalphWorkGraph();
      await resolveParked(itemId, {
        wg,
        recordMisclassification,
        sessionId: process.env.CLAUDE_SESSION_ID ?? '<cli>',
        nowIso: new Date().toISOString(),
      });
      process.stdout.write(
        `resolved ${itemId}: misclassification recorded, item un-wedged → back in ready.\n`,
      );
    });

  return loop;
}
