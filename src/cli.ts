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

import { Command } from 'commander';

import { registerEngineCli } from './engine/cli.js';
import { registerAgentBridge } from './runtime/agent_bridge/cli.js';
import { OpenSquidDaemon } from './runtime/daemon.js';
import { daemonPidPath } from './runtime/paths.js';
import { registerAudit } from './setup/cli/audit.js';
import { registerCache } from './setup/cli/cache.js';
import { registerSetup } from './setup/cli/chat.js';
import { registerCheckpoints } from './setup/cli/checkpoints.js';
import { registerSetupWizard } from './setup/cli/hooks.js';
import { registerCost } from './setup/cli/cost.js';
import { registerLimits } from './setup/cli/limits.js';
import { registerPermissions } from './setup/cli/permissions.js';
import { registerSchedule } from './setup/cli/schedule.js';
import { registerTraceCommand } from './setup/cli/trace.js';
import { registerTriggers } from './setup/cli/triggers.js';
import { registerWebhooks } from './setup/cli/webhooks.js';

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
registerSetupWizard(setupGroup);

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

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`opensquid: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
