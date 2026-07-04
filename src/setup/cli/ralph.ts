/**
 * GR.4 — the `opensquid loop` CLI: the user-invoked entry that ASSEMBLES the orchestrator's injected deps
 * and runs the gated-ralph loop. A thin wire — all logic lives in the unit-tested pieces it composes
 * (runRalphLoop, chatEscalator, parseLapOutcome, the GR.1–3 store ops). The loop is a CLI COMMAND, not a
 * daemon (opensquid stays an MCP server / tool provider; the agent loop runs inside the spawned harness).
 *
 * Commands:
 *   opensquid loop [--once] [--max-budget-usd <n>]      — run the loop (read ready → claim → lap → repeat)
 *   opensquid loop resolve <itemId> --misclassified     — the human-override residual-shrink path (GR.4)
 *
 * Imports from: commander, node:net, ../../runtime/paths.js, ../../runtime/spawn_lifecycle.js,
 * ../../runtime/ralph/*, ../../workgraph/*, ../wizard/ralph_writer.js.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import {
  OPENSQUID_HOME,
  resolveProjectMarker,
  resolveProjectUuidFromEnv,
} from '../../runtime/paths.js';
import { sendChat } from '../../chat_daemon/client.js';
import {
  loadChannelsConfig,
  resolveConfiguredChannel,
  resolveUmbrellaForCwd,
} from '../../channels/routing.js';
import type { LapEscalator } from '../../runtime/ralph/escalate_lap.js';
import { runOneShotCli } from '../../runtime/spawn_lifecycle.js';
import { resolveActorId } from '../../runtime/actor_id.js';
import { bindProject, workGraphStore } from '../../workgraph/store.js';
import { resolveWgNamespace } from '../../workgraph/project_scope.js';
import { claimAudience } from '../../workgraph/audience.js';
import type { Issue } from '../../workgraph/types.js';
import { runRalphLoop, resolveParked, type RalphConfig } from '../../runtime/ralph/orchestrator.js';
import { clearLoopStage, readLoopStage, scopeGate } from '../../runtime/ralph/loop_stage.js';
import { onPhasesComplete } from '../../runtime/loop/loop_driver.js';
import { activeDisciplinePack } from './gate.js';
import type { LapResult } from '../../runtime/ralph/supervisor.js';
import { parseLapOutcome } from '../../runtime/ralph/lap_outcome.js';
import { recordMisclassification } from '../../runtime/ralph/decision_classifier.js';
import { chatEscalator, type ChatSend } from '../../runtime/ralph/escalator.js';
import { readRalphConfig, type RalphConfigFile } from '../wizard/ralph_writer.js';

/**
 * T-WORKGRAPH-PROJECT-SCOPE (lap/loop agreement): resolve the loop's project from the cwd's
 * `.opensquid/project.json` marker (degrading marker-less → env-fallback → 'legacy-global' via the ONE
 * `resolveWgNamespace` coalesce the MCP server's `resolveWgProject` also runs) AND PUBLISH it into
 * `process.env.OPENSQUID_PROJECT_UUID`. `runOneShotCli` spawns each lap with `...process.env`, so a lap
 * whose OWN session→cwd marker is unresolvable inherits this env and resolves the SAME project as the loop —
 * instead of landing on the empty `legacy-global` board (BOARD_EMPTY). Returns the resolved uuid.
 */
export async function resolveAndPublishLoopProject(): Promise<string> {
  const cwd = process.cwd();
  const project = resolveWgNamespace(
    (await resolveProjectMarker(cwd))?.uuid ?? null,
    resolveProjectUuidFromEnv(),
  );
  process.env.OPENSQUID_PROJECT_UUID = project;
  return project;
}

/**
 * T-WORKGRAPH-PROJECT-SCOPE: the ralph loop drains THIS project's ready queue. Init the shared base store,
 * resolve+publish the cwd's namespace (so spawned laps inherit it), and return a per-project facade so
 * runRalphLoop/resolveParked operate on one project.
 */
async function openRalphWorkGraph() {
  const base = workGraphStore({
    dbUrl: `file:${join(OPENSQUID_HOME(), 'workgraph.db')}`,
    sourceDir: join(OPENSQUID_HOME(), 'store', 'issues'),
    actorId: await resolveActorId(), // WGD.1 — stamp the per-HOME replica id on ops
  });
  await base.init();
  const project = await resolveAndPublishLoopProject();
  return bindProject(base, project);
}

/** Hydrate the persisted scalar config into the orchestrator's runtime `RalphConfig` (closures rebuilt). */
export function buildRalphConfig(
  file: RalphConfigFile,
  opts: { once: boolean; maxBudgetUsd?: number },
): RalphConfig {
  return {
    authMode: file.authMode,
    maxBudgetUsd: opts.maxBudgetUsd ?? file.maxBudgetUsd,
    claimTtlSec: file.claimTtlSec,
    once: opts.once,
    supervise: {
      maxRetries: file.maxRetries,
      backoffMs: (attempt: number) => file.backoffBaseMs * 2 ** attempt, // exponential from the base
      heartbeat: () => undefined, // a future lease-refresh; liveness tick is a no-op for the CLI run
    },
  };
}

/** Build the per-lap runner: spawn `claude -p RALPH.md --item <id>`, parse the typed exit. A deadline
 * overrun (group-SIGKILL) becomes the typed TIMEOUT, NOT a CRASH; a genuine spawn failure rethrows → CRASH. */
export function makeSpawnLap(
  cfg: RalphConfig,
  file: RalphConfigFile,
  runCli: typeof runOneShotCli = runOneShotCli,
): (item: Issue, stagePrompt?: string) => Promise<LapResult> {
  return async (item: Issue, stagePrompt?: string) => {
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
      // PSL.3 — the per-stage directive (when the orchestrator drives this item per-stage). Appended LAST so it
      // is the most-specific instruction (it narrows RALPH.md's "do the whole item" to "do ONLY this stage").
      // The lap's OWN stage_inject hook supplies the stage's checkpoint/procedure/rubric/work-context (its own
      // session) — the directive only constrains scope + asks for the resulting-stage report.
      (stagePrompt === undefined ? '' : `\n---\n${stagePrompt}\n`);
    let stdout: string;
    try {
      stdout = await runCli({
        cli: file.harness.cli, // Inv 10 — harness is a parameter
        // NO `--item` (not a claude flag → crash) and no `-p <path>` (that passes the path string as the
        // prompt). `-p` + prompt-via-stdin; `--max-budget-usd` is valid ("only works with --print").
        args: [
          '-p',
          '--output-format',
          'json',
          '--max-budget-usd',
          String(cfg.maxBudgetUsd),
          '--dangerously-skip-permissions',
        ],
        prompt,
        timeoutMs: file.wallClockMs,
        markSubagent: true,
        // T-active-task-mirror — publish the lap's item id so the lap's FSM hook (v2_supply) can WRITE THROUGH to
        // the item-keyed loop-stage projection. claude inherits this env → its hook bins inherit it (mirrors how
        // OPENSQUID_AUTOMATION reaches the hooks). This is the ONLY channel that tells the lap process its item id.
        env: { OPENSQUID_ITEM_ID: item.id },
        timeoutError: () => Object.assign(new Error('lap timeout'), { __timeout: true }),
      });
    } catch (e) {
      if ((e as { __timeout?: boolean }).__timeout === true) return { kind: 'TIMEOUT', costUsd: 0 };
      throw e; // genuine spawn/IO failure → superviseLap maps it to CRASH
    }
    const { outcome, costUsd } = parseLapOutcome(stdout);
    return { ...outcome, costUsd };
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
    return async () => ({ escalated: false, reason: `no chat binding for cwd ${cwd}` });
  }
  return chatEscalator({
    send: daemonChatSend,
    channel: resolved.channel,
    ...(resolved.threadId !== undefined ? { threadId: resolved.threadId } : {}),
  });
}

/** PSL.3 — the fullstack-flow stages the per-stage loop drives as its own laps (the human boundary is past these).
 *  GS1: `scope` is removed (interactive / human-paced; the agent confirms with the user and emits RALPH-EXIT with
 *  stage:'scope_write'); `scope_write` is added (automated: writes the pre-research artifact + triggers decompose). */
const AUTOMATED_STAGES = new Set<string>(['scope_write', 'plan', 'author', 'code']);

/** The per-stage directive appended to a lap's prompt: do ONLY this stage + report the resulting stage. The lap's
 *  own stage_inject hook supplies the stage's procedure/rubric/checkpoint/work-context (its own session). */
function perStageDirective(stage: string): string {
  return [
    `## Per-stage assignment (the orchestrator runs ONE stage per lap, for fresh context per stage)`,
    `You are assigned ONLY the **${stage}** stage of this item — NOT the whole flow.`,
    `Complete exactly that stage's gate (your in-session stage guidance supplies its procedure + rubric), then STOP.`,
    `Do NOT proceed into later stages — the orchestrator spawns the next stage's lap with fresh context.`,
    `Exit by reporting the stage the flow is AT after you finish, so the orchestrator can prime the next lap:`,
    `  RALPH-EXIT: {"kind":"SHIPPED","stage":"<your current FSM stage after completing ${stage} — verify with read_state>"}`,
    `If you genuinely cannot complete ${stage} (an irreversible boundary or a product fork the principles cannot`,
    `settle), escalate as usual: RALPH-EXIT: {"kind":"HUMAN_REQUIRED","reason":"IRREVERSIBLE_BOUNDARY|SCOPE_FORK"}.`,
  ].join('\n');
}

export function registerRalph(program: Command): Command {
  const loop = program
    .command('loop')
    .description(
      "Run the gated-ralph autonomous loop (composes the work-graph + the project's active discipline gates — v2 fullstack-flow or v1 coding-flow)",
    );

  loop
    .option('--once', 'process a single ready item then stop', false)
    .option('--max-budget-usd <n>', 'API-mode dollar budget for this run (overrides config)')
    .action(async (opts: { once?: boolean; maxBudgetUsd?: string }) => {
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
        once: opts.once === true,
        ...(opts.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: Number(opts.maxBudgetUsd) }),
      });
      const wg = await openRalphWorkGraph();
      const sid = process.env.CLAUDE_SESSION_ID ?? '<cli>';
      const root = process.cwd();
      // PSL.3 — drive a fullstack-flow item per-stage (one fresh-context lap per automated stage); any other
      // pack (v1 coding-flow) keeps the open-ended per-item lap. Detected from the project's active discipline.
      const pack = await activeDisciplinePack(root);
      const stageLoop =
        pack === 'fullstack-flow'
          ? {
              // GS1/T-active-task-mirror E — a fresh item starts at the AUTOMATED `scope_write` (writes the
              // pre-research artifact), NOT the human `scope` lap. SAFE because `scopeGate` (below, design D)
              // holds back any item that reaches PAST scope without a real, on-disk scope artifact.
              initialStage: 'scope_write',
              isAutomated: (s: string): boolean => AUTOMATED_STAGES.has(s),
              stagePrompt: async (_item: Issue, stage: string): Promise<string> =>
                perStageDirective(stage),
              readStage: readLoopStage,
              // No writeStage — the FSM transition (v2_supply write-through) is the SINGLE writer of the
              // durable task checkpoint; the orchestrator only READS it (+ scopeGate's corrective reset).
              clearStage: clearLoopStage,
              // D — the scope gate: verify real scope proof before an item is driven past scope.
              scopeGate: (item: Issue): Promise<'drive' | 'hold'> => scopeGate(item.id),
            }
          : undefined;
      const result = await runRalphLoop(cfg, {
        wg,
        claimAudience,
        runLap: makeSpawnLap(cfg, file),
        escalate: await resolveLoopEscalator(root),
        ...(stageLoop === undefined ? {} : { stageLoop }),
        // T2.9 loop-driver: on a SHIPPED task emit the CODE report + compute the next run-group (batchDecide).
        // The wg facade is adapted to the driver's minimal LoopWorkGraph (ids + edges).
        onShipped: async (taskId) => {
          const { next } = await onPhasesComplete(
            sid,
            root,
            taskId,
            {
              listReadyIds: async () => (await wg.listReady()).map((i) => i.id),
              listEdges: () => wg.listEdges(),
            },
            new Date().toISOString(),
          );
          process.stdout.write(`🦑 next run-group: ${JSON.stringify(next)}\n`);
        },
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
