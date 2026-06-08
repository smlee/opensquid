#!/usr/bin/env node
/**
 * `opensquid` CLI entry. SCHED.1 adds the `daemon` verb tree:
 *
 *   opensquid daemon status     — read pid file, report running PID + uptime
 *
 * `start` / `stop` / `restart` are stubbed (deferred to the UI track) — but
 * `status` lands here because the acceptance criteria for SCHED.1 require
 * the verb to return cleanly with exit 0 when no daemon is running, so the
 * caller in tests + downstream UI work has a stable boundary.
 *
 * `start` / `stop` are deliberately NOT implemented as one-liners here
 * because spawning the daemon as a real long-lived process requires the
 * launchd / systemd integration (UI track) — running it inline would block
 * the CLI invocation forever, which is a foot-gun for first-time users.
 */

import { join } from 'node:path';

import { Command } from 'commander';

import { registerChatDaemon, runChatDaemonWorkerEntry } from './channels/daemon/cli.js';
import { registerEngineCli } from './engine/cli.js';
import { registerAgentBridge } from './runtime/agent_bridge/cli.js';
import { registerPackCli } from './cli/pack.js';
import { registerChatWatch } from './runtime/chat/watch_cli.js';
import { resolveBackendConfig } from './rag/config.js';
import { fastembedEmbedder } from './rag/embedders/fastembed.js';
import { migrateMemories } from './rag/migrate_memories.js';
import { migrateWedgeLessons } from './rag/wedge/migrate.js';
import { wedgeLessonsDbUrl, wedgeLessonsDir } from './rag/wedge/paths.js';
import { OpenSquidDaemon } from './runtime/daemon.js';
import { daemonPidPath, OPENSQUID_HOME } from './runtime/paths.js';
import { registerAudit } from './setup/cli/audit.js';
import { registerAutomation } from './setup/cli/automation.js';
import { registerCache } from './setup/cli/cache.js';
import { registerSetup } from './setup/cli/chat.js';
import { registerCheckpoints } from './setup/cli/checkpoints.js';
import { registerDoctor } from './setup/cli/doctor.js';
import { registerGate } from './setup/cli/gate.js';
import { registerSetupWizard } from './setup/cli/hooks.js';
import { registerCost } from './setup/cli/cost.js';
import { registerLimits } from './setup/cli/limits.js';
import { registerSetupWizardMcp } from './setup/cli/mcp.js';
import { registerMemory } from './setup/cli/memory.js';
import { registerPermissions } from './setup/cli/permissions.js';
import { registerSchedule } from './setup/cli/schedule.js';
import { registerTraceCommand } from './setup/cli/trace.js';
import { registerTriggers } from './setup/cli/triggers.js';
import { registerWebhooks } from './setup/cli/webhooks.js';

// CAT.1d — internal worker entrypoint short-circuit. `chat-daemon-worker` is
// the argv token `src/channels/daemon/lifecycle.startDaemon` re-invokes this
// binary (`dist/cli.js`) with to spawn the long-running daemon. It must be
// handled BEFORE commander parses, because the worker never returns (it parks
// the event loop), and commander would otherwise reject the unknown command.
if (process.argv[2] === 'chat-daemon-worker') {
  void runChatDaemonWorkerEntry();
} else {
  runCli();
}

function runCli(): void {
  const program = new Command()
    .name('opensquid')
    .description('Tracks for your AI agent — destination-first.')
    .version('0.5.85');

  const daemon = program.command('daemon').description('Background daemon lifecycle');

  daemon
    .command('status')
    .description('Report daemon status (running PID + uptime, or "not running").')
    .action(async () => {
      // Use a transient daemon instance solely for its `status()` reader —
      // the constructor allocates no resources until `start()` runs.
      const instance = new OpenSquidDaemon({
        packs: [],
        subscriptions: [],
        dispatch: async () => {
          /* status check never dispatches */
        },
      });
      const status = await instance.status();
      if (status.running) {
        process.stdout.write(
          `daemon: running (pid ${String(status.pid ?? '?')}, schedules ${String(
            status.scheduleCount ?? '?',
          )}, webhook port ${String(status.webhookPort ?? '?')})\n`,
        );
      } else {
        process.stdout.write(`daemon: not running (no pid file at ${daemonPidPath()})\n`);
      }
    });

  daemon
    .command('start')
    .description('Start the background daemon (deferred to UI track — see daemon status).')
    .action(() => {
      process.stderr.write(
        'opensquid daemon start: not yet wired — launchd/systemd integration ships in the UI track\n',
      );
      process.exitCode = 1;
    });

  daemon
    .command('stop')
    .description('Stop the background daemon (deferred to UI track).')
    .action(() => {
      process.stderr.write(
        'opensquid daemon stop: not yet wired — launchd/systemd integration ships in the UI track\n',
      );
      process.exitCode = 1;
    });

  daemon
    .command('restart')
    .description('Restart the background daemon (deferred to UI track).')
    .action(() => {
      process.stderr.write(
        'opensquid daemon restart: not yet wired — launchd/systemd integration ships in the UI track\n',
      );
      process.exitCode = 1;
    });

  // CLI.2 — `opensquid schedule list|next|history|add|remove|pause|resume|run`.
  // Replaces SCHED.3's inline `schedule add` with the full 8-verb group.
  // `add <description>` still routes NL → cron via SCHED.3 (`fast_classifier`)
  // unless `--cron <expr>` is provided. Persistence at `~/.opensquid/
  // schedules.yaml` for user-added schedules (pack-declared schedules remain
  // declared in pack manifests). No dispatcher wired here yet — `run` records
  // a force-fire entry and the daemon picks it up via subsequent integration.
  registerSchedule(program);

  // OBSERVE.2 — `opensquid trace <runId> | tail | export <runId>`.
  // Registered via a sibling module to keep the verb tree's commander wiring
  // + libsql client lifecycle ownership out of `cli.ts`.
  registerTraceCommand(program);

  // CLI.1 — `opensquid triggers list|show|fire|enable|disable`. Unified view
  // of skill `triggers:` blocks across all installed packs + user-side
  // enable/disable persistence (`~/.opensquid/trigger_state.yaml`). No
  // dispatcher wired here yet — `fire` errors cleanly until the daemon
  // surfaces an injectable dispatch handle (deferred to a later CLI task).
  registerTriggers(program);

  // CLI.3 — `opensquid webhooks list|subscribe|unsubscribe|test|rotate`.
  // CLI-managed webhook subscription store at `~/.opensquid/webhooks.yaml`
  // (same schema as the SCHED.1 runtime loader). Secrets stored inline as
  // `literal:<64-hex>` URIs so rotate stays atomic with a single yaml
  // rewrite. Daemon picks up changes on next reload; runtime resolver
  // needs `literalBackend()` registered (wired in setup phase).
  registerWebhooks(program);

  // CLI.4 — `opensquid permissions list|audit|grant|revoke`. Surfaces the
  // AUTO.3 capability gate's pack-declared permissions block + user-side
  // override file at `~/.opensquid/permission_overrides.yaml`. The CLI
  // blocks grants that match the sealed built-in denylist unless
  // `OPENSQUID_TRUST_BUILTIN_DENY=0` (which the gate also honors).
  // `audit` reads `~/.opensquid/permission_audit.jsonl` (file-based);
  // CLI.5 ships the libsql `audit_log` table that supersedes this sink.
  registerPermissions(program);

  // CLI.5 — `opensquid audit list|shell|channels|pending|tail|approve|reject`.
  // Unified libsql `audit_log` table that consolidates capability_gate +
  // webhook + schedule + resume + channel_send + pending_shell producers.
  // `approve` / `reject` close the SEC.6 queued-shell-exec approval loop
  // via an atomic `prompted → approved|rejected` UPDATE.
  registerAudit(program);

  // CLI.6 — `opensquid checkpoints list|show|resume|clean`. Queries the
  // DURABLE.1 checkpoint store (run_manifests + checkpoints + terminal_markers)
  // and exposes the DURABLE.4 manual-resume path. `show` is the RAW JSONL
  // counterpart to `opensquid trace`'s rendered timeline — same data, no
  // formatting, suitable for jq pipelines. `resume` requires a daemon-wired
  // Resumer (factory deferred to the daemon track) — without it, the verb
  // surfaces a clear "not yet wired" stderr message rather than silently
  // failing. `clean --older-than 30d --yes` prunes old rows.
  registerCheckpoints(program);

  // CLI.7 — `opensquid cache stats|clear`. Surfaces the DURABLE.3 MemoCache.
  // `stats` reads per-primitive hit/size rows from the libsql tier (the in-
  // memory LRU tier is restart-volatile and deliberately excluded). `clear`
  // supports selective invalidation by `--primitive` and/or `--older-than`;
  // a zero-filter (full) clear requires `--yes` or TTY confirmation.
  registerCache(program);

  // CLI.8 — `opensquid cost (default)|cost routing|cost subscriptions` and
  // `opensquid limits (default)|limits reset <pack>`. Surfaces the AUTO.7
  // CostRouter routing decisions + AUTO.2 RateLimiter bucket state. The
  // CostRouter doesn't persist by default — the daemon wires its `audit:`
  // sink to `cost_routing_log` so the CLI can render `cost` / `cost routing`
  // summaries; in a fresh install both verbs print a clean placeholder.
  // `limits reset` requires --yes or TTY confirmation; non-TTY without
  // --yes refuses with exit 1 (mirrors `cache clear` / `checkpoints clean`).
  registerCost(program);
  registerLimits(program);

  // G.12 — `opensquid automation on|off|status`. Toggles the per-session
  // flag file at `~/.opensquid/sessions/<id>/automation.flag` that the
  // `is_automation_mode` primitive reads (OR'd with `OPENSQUID_AUTOMATION=1`)
  // to gate Stop-event skills like `d9-guard`. Session id resolves from
  // `--session-id` → `$OPENSQUID_SESSION_ID` → fresh uuid (stderr-advised).
  registerAutomation(program);

  // WIZ.5 — `opensquid setup chat`. Registers the `setup` parent verb group
  // + the `chat` subcommand (interactive chat-agent wizard). Bare `setup`
  // prints help — the wizard never auto-runs. Flags: --dry-run, --replace,
  // --skip-test. See `src/setup/cli/chat.ts` for the registration shape.
  const setupGroup = registerSetup(program);

  // G.1 — `opensquid setup wizard hooks`. Writes opensquid's 4 anti-drift
  // hook entries into `~/.claude/settings.json` (+ project-scope when a
  // `.opensquid/` ancestor is found from cwd). Preserves all third-party
  // hooks via the `@opensquid: true` marker contract. Replaces the broken
  // `node .../dist/index.js anti-drift <event>` legacy entries that
  // currently exist in the user's settings.json.
  const wizardGroup = registerSetupWizard(setupGroup);

  // G.8 — `opensquid setup wizard mcp`. Writes opensquid's two MCP server
  // entries (opensquid + opensquid-chat) into `~/.claude.json` at the USER
  // level, so the central brain is reachable from EVERY project without
  // per-project `.mcp.json` setup. Same `@opensquid` marker contract as G.1.
  // Replaces the broken legacy `node .../dist/index.js` user-level entry
  // with the correct `dist/mcp/server.js` path. Surfaces a non-destructive
  // advisory if a project-level `.mcp.json` still has opensquid entries.
  registerSetupWizardMcp(wizardGroup);

  // G.2 — `opensquid doctor hooks`. Health check for Claude Code hook wiring.
  // Reads `~/.claude/settings.json` + `<cwd>/.claude/settings.json`, spawns
  // each opensquid-managed hook command with a canonical event payload, and
  // asserts the `[opensquid-dispatch]` marker on stderr. Exit 0 = all green,
  // 1 = any red. NEVER spawns commands that don't match the opensquid regex
  // (security gate against running arbitrary user-configured commands).
  registerDoctor(program);

  // GF.2 — `opensquid gate commit|push|install`. The owned-boundary EXECUTE gate: the
  // installed git pre-commit/pre-push hooks `exec opensquid gate <boundary>`, which reads
  // the real staged/pushed diff + the live session FSM/phase state and blocks a code
  // commit/push that has not completed the SCOPE→AUTHOR→7-phase flow. Total: a non-gated
  // repo (no .opensquid/active.json opting into coding-flow) is never blocked.
  registerGate(program);

  // T.2 — `opensquid engine doctor|set-path|forget|kill`. Engine binary
  // discovery + persisted-path management. Revived from the pre-reset
  // surface; stdio-only in 0.5.108 (UDS singleton lands in T.4).
  registerEngineCli(program);

  // WAB.7 — `opensquid agent-bridge {start|stop|status|restart|run-foreground}`.
  // Long-running warm-pool chat-agent daemon that wires every WAB.2-WAB.6
  // component together. Co-exists with the `daemon` verb group above (which
  // owns scheduler / webhook / file-watcher lifecycle). Separate PID lock at
  // `~/.opensquid/agent-bridge.lock` so both daemons can run in parallel.
  registerAgentBridge(program);

  // TR.1 — `opensquid chat watch`. Stream-source for the harness Monitor tool:
  // tails the active project's inbox JSONL (`<home>/projects/<uuid>/inbox/
  // <platform>.jsonl`), emitting only NEW inbound messages so the agent gets
  // live, no-cron delivery. Distinct from `setup chat` (the wizard).
  registerChatWatch(program);

  // CAT.1d — `opensquid chat-daemon {start|stop|status|restart}`. Lifecycle for
  // the NEW chat-transport daemon (`src/channels/daemon/`), a standalone process
  // with its own `chat-daemon.{sock,pid,log}` side-files (deliberately separate
  // from the SCHED.1 `daemon` group — the two daemons run in parallel). `start`
  // spawns `dist/cli.js chat-daemon-worker` detached (handled by the early
  // short-circuit above). Replaces the retired legacy chat-daemon verbs.
  registerChatDaemon(program);

  // LP.4 — `opensquid pack install/list/export/remove`. CLI lifecycle for the
  // living-pack mechanic. v1 ships local-directory install + lessons-only/raw
  // export modes. Tarball/URL install + with-evidence export are v1.5.
  registerPackCli(program);

  // G.6 — `opensquid memory import-auto`. Bulk-imports Claude Code auto-memory
  // files (`~/.claude/projects/<encoded-path>/memory/*.md`) into the loop-engine
  // via direct `engine.memoryCreate` RPC, bypassing the MCP write overhead for
  // bulk ingest. Dedupe by frontmatter `name` round-tripped through `origin.host`.
  // All imports tagged `authored_by: 'user'` (eviction-immune).
  registerMemory(program);

  // T-MIGRATE-MEMORIES — `opensquid migrate-memories`. Copies engine mem-*.md into the libSQL
  // store (additive) so recall can later be cut off the engine (retire-Rust). libsql-fastembed only.
  program
    .command('migrate-memories')
    .description(
      'Copy engine mem-*.md memories into the libSQL store (additive; libsql-fastembed only).',
    )
    .action(async () => {
      const cfg = await resolveBackendConfig();
      if (cfg.kind !== 'libsql-fastembed' || cfg.sourceDir === undefined) {
        process.stderr.write(
          `migrate-memories requires the libsql-fastembed backend with a per-file source ` +
            `(got ${cfg.kind}); set OPENSQUID_RAG_BACKEND=libsql-fastembed.\n`,
        );
        process.exitCode = 1;
        return;
      }
      const { migrated } = await migrateMemories({
        memDir: join(OPENSQUID_HOME(), 'memories'),
        sourceDir: cfg.sourceDir,
        dbUrl: cfg.dbUrl,
        embedder: fastembedEmbedder(),
      });
      process.stdout.write(`migrated ${migrated} memories into ${cfg.sourceDir}\n`);
    });

  // RES-3d — `opensquid migrate-lessons`. Indexes the on-disk wedge lessons
  // (~/.opensquid/lessons/<status>/les-*.md, the per-file source) into the wg_lessons libSQL index.
  // No backend-kind gate: the wedge store resolves via pure path helpers + FTS (no embedder/vector).
  program
    .command('migrate-lessons')
    .description(
      'Index the on-disk wedge lessons (~/.opensquid/lessons/<status>/les-*.md) into wg_lessons.',
    )
    .action(async () => {
      const { migrated } = await migrateWedgeLessons({
        dbUrl: wedgeLessonsDbUrl(),
        sourceDir: wedgeLessonsDir(),
      });
      process.stdout.write(`migrated ${migrated} lessons into the wg_lessons index\n`);
    });

  program.parseAsync(process.argv).catch((err: unknown) => {
    process.stderr.write(`opensquid: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
