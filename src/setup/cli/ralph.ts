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
import { connect } from 'node:net';
import { join } from 'node:path';
import type { Command } from 'commander';
import {
  OPENSQUID_HOME,
  chatDaemonSockPath,
  resolveProjectMarker,
  resolveProjectUuidFromEnv,
} from '../../runtime/paths.js';
import { runOneShotCli } from '../../runtime/spawn_lifecycle.js';
import { bindProject, workGraphStore } from '../../workgraph/store.js';
import { claimAudience } from '../../workgraph/audience.js';
import type { Issue } from '../../workgraph/types.js';
import { runRalphLoop, resolveParked, type RalphConfig } from '../../runtime/ralph/orchestrator.js';
import type { LapResult } from '../../runtime/ralph/supervisor.js';
import { parseLapOutcome } from '../../runtime/ralph/lap_outcome.js';
import { recordMisclassification } from '../../runtime/ralph/decision_classifier.js';
import { chatEscalator, type ChatSend } from '../../runtime/ralph/escalator.js';
import { readRalphConfig, type RalphConfigFile } from '../wizard/ralph_writer.js';

/**
 * T-WORKGRAPH-PROJECT-SCOPE: the ralph loop drains THIS project's ready queue. Init the shared base store,
 * resolve the cwd's namespace (degrade marker-less → 'legacy-global', mirroring the server's resolveWgProject),
 * and return a per-project facade so runRalphLoop/resolveParked operate on one project.
 */
async function openRalphWorkGraph() {
  const base = workGraphStore({
    dbUrl: `file:${join(OPENSQUID_HOME(), 'workgraph.db')}`,
    sourceDir: join(OPENSQUID_HOME(), 'store', 'issues'),
  });
  await base.init();
  const cwd = process.cwd();
  const project =
    (await resolveProjectMarker(cwd))?.uuid ?? resolveProjectUuidFromEnv() ?? 'legacy-global';
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
): (item: Issue) => Promise<LapResult> {
  return async (item: Issue) => {
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
      `\n\n---\nYour assigned work-item id: ${item.id}\n(Read it with workgraph_get("${item.id}").)\n`;
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

/** The real chat transport: a one-shot UDS JSON-RPC `send` to the chat-daemon (the live Telegram path
 * `chat_send` uses). `ok:false` on any unreachable/error so the escalator stays undroppable. */
export const daemonChatSend: ChatSend = (params) =>
  new Promise((resolve) => {
    const sock = connect(chatDaemonSockPath());
    let buf = '';
    const done = (r: { ok: boolean; reason?: string }): void => {
      try {
        sock.end();
      } catch {
        /* already closed */
      }
      resolve(r);
    };
    const timer = setTimeout(
      () => done({ ok: false, reason: 'chat-daemon RPC timeout (5s)' }),
      5000,
    );
    sock.on('error', (e) => {
      clearTimeout(timer);
      done({ ok: false, reason: `chat-daemon unreachable: ${e.message}` });
    });
    sock.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      try {
        const res = JSON.parse(buf.slice(0, nl)) as { error?: { message?: string } };
        done(res.error ? { ok: false, reason: res.error.message ?? 'send error' } : { ok: true });
      } catch (e) {
        done({ ok: false, reason: e instanceof Error ? e.message : 'bad RPC response' });
      }
    });
    sock.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: `ralph-${String(Date.now())}`,
        method: 'send',
        params: { channel: params.channel, text: params.text },
      }) + '\n',
    );
  });

export function registerRalph(program: Command): Command {
  const loop = program
    .command('loop')
    .description(
      'Run the gated-ralph autonomous loop (composes the work-graph + the coding-flow gate)',
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
      const cfg = buildRalphConfig(file, {
        once: opts.once === true,
        ...(opts.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: Number(opts.maxBudgetUsd) }),
      });
      const wg = await openRalphWorkGraph();
      const result = await runRalphLoop(cfg, {
        wg,
        claimAudience,
        runLap: makeSpawnLap(cfg, file),
        escalate: chatEscalator({ send: daemonChatSend, channel: 'project:telegram' }),
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
