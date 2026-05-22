/**
 * `opensquid engine <subcommand>` — engine binary management.
 *
 * Subcommands:
 *   doctor             — show the resolved engine binary + how it was
 *                        discovered (env / config / search / PATH).
 *                        Warns when `OPENSQUID_ENGINE_BIN` is set,
 *                        since the env-var bypass would pin a stale
 *                        path forever (re-resolution can't override
 *                        an explicit env override).
 *   set-path <path>    — persist an explicit engine binary path in
 *                        ~/.opensquid/engine-config.json
 *   forget             — clear the persisted path; force re-discovery
 *                        on next start
 *   kill               — read `~/.opensquid/loop-engine.pid` (written
 *                        by `singleton.acquireOrSpawnEngine`), send
 *                        SIGTERM, wait 2s for graceful shutdown, then
 *                        best-effort unlink the socket + pidfile.
 *                        Idempotent — no pidfile + no socket prints a
 *                        friendly "no engine daemon running" + exit 0.
 *
 * Registered into the root `opensquid` Command via `registerEngineCli`
 * — call from `src/cli.ts`.
 */
import { existsSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';

import type { Command } from 'commander';

import { forgetEngineBin, loadEngineConfig, resolveEngineBin, setEngineBin } from './config.js';
import { enginePidPath, engineSocketPath } from './singleton.js';

export class EngineCliError extends Error {
  public readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'EngineCliError';
    if (hint !== undefined) this.hint = hint;
  }
}

async function cmdDoctor(): Promise<void> {
  process.stdout.write('[opensquid engine doctor]\n');
  const env = process.env.OPENSQUID_ENGINE_BIN?.trim();
  process.stdout.write(`  env OPENSQUID_ENGINE_BIN: ${env ?? '(unset)'}\n`);
  const config = await loadEngineConfig();
  process.stdout.write(`  config.engine_bin:        ${config.engine_bin ?? '(unset)'}\n`);
  if (config.engine_bin_resolved_at) {
    process.stdout.write(`  resolved at:              ${config.engine_bin_resolved_at}\n`);
  }
  const resolved = await resolveEngineBin();
  process.stdout.write(`  resolved binary:          ${resolved ?? '(none — not found)'}\n`);
  // T.7: the env-var bypass short-circuits stale-path re-resolution,
  // so a stale `OPENSQUID_ENGINE_BIN` would pin a dead path forever.
  // Surface the override + remind the user re-resolution is disabled.
  if (env) {
    process.stdout.write(
      '  note: env var OPENSQUID_ENGINE_BIN is set — stale-path re-resolution is disabled.\n' +
        '        unset it to let opensquid recover automatically.\n',
    );
  }
  if (!resolved) {
    process.stdout.write('  hint: run `opensquid engine set-path <path>` to fix.\n');
  }
}

async function cmdSetPath(target: string): Promise<void> {
  if (!target) {
    throw new EngineCliError(
      'usage: opensquid engine set-path <path>',
      'pass the path to a loop-engine release binary',
    );
  }
  const res = await setEngineBin(target);
  process.stdout.write(`[opensquid engine set-path] persisted: ${res.resolved}\n`);
}

async function cmdForget(): Promise<void> {
  await forgetEngineBin();
  process.stdout.write('[opensquid engine forget] cleared persisted engine_bin\n');
}

/**
 * Grace period after `SIGTERM` before we clean up the socket + pidfile.
 * The engine's own shutdown handler should unlink both as it exits;
 * cleanup here is defense-in-depth for SIGKILL fallbacks / crashes.
 * 2s is comfortably above engine clean-shutdown time (<200ms typical)
 * without making `engine kill` feel slow on a healthy daemon.
 */
const KILL_GRACE_MS = 2_000;

async function cmdKill(): Promise<void> {
  const sockPath = engineSocketPath();
  const pidPath = enginePidPath();
  const sockExists = existsSync(sockPath);
  const pidExists = existsSync(pidPath);

  // Idempotent no-op when nothing is running. Avoids scaring a user
  // who runs `engine kill` defensively before tearing down a project.
  if (!sockExists && !pidExists) {
    process.stdout.write('[opensquid engine kill] no engine daemon running.\n');
    return;
  }

  // Pidfile is the only authoritative pid source — the socket file
  // alone tells us nothing about who's listening. If the pidfile is
  // missing or malformed, skip the signal and fall through to cleanup.
  let pid: number | null = null;
  if (pidExists) {
    try {
      const raw = (await readFile(pidPath, 'utf8')).trim();
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        pid = parsed;
      } else {
        process.stdout.write(
          `[opensquid engine kill] warning: pidfile contents not a valid pid (${raw}); skipping SIGTERM.\n`,
        );
      }
    } catch (e) {
      process.stdout.write(
        `[opensquid engine kill] warning: could not read pidfile: ${String(e)}; skipping SIGTERM.\n`,
      );
    }
  }

  if (pid !== null) {
    try {
      process.kill(pid, 'SIGTERM');
      process.stdout.write(`[opensquid engine kill] sent SIGTERM to pid=${String(pid)}.\n`);
      // Give the engine its graceful-shutdown window before we step
      // in for cleanup. The engine SHOULD unlink the socket + pidfile
      // itself; our unlink calls below are best-effort fallbacks.
      await new Promise<void>((resolve) => setTimeout(resolve, KILL_GRACE_MS));
    } catch (e) {
      // ESRCH (no such pid) is the common case — pidfile is stale
      // because the engine crashed without cleanup. Log + continue
      // to the unlink step so we don't leave junk behind.
      const msg = e instanceof Error ? e.message : String(e);
      process.stdout.write(
        `[opensquid engine kill] kill(${String(pid)}, SIGTERM) failed: ${msg}; continuing to cleanup.\n`,
      );
    }
  }

  // Defense-in-depth cleanup. Either the engine already unlinked
  // these (cleanly handled SIGTERM) or it didn't (crash / SIGKILL).
  // Swallow errors — best-effort.
  if (existsSync(sockPath)) {
    await unlink(sockPath).catch(() => undefined);
  }
  if (existsSync(pidPath)) {
    await unlink(pidPath).catch(() => undefined);
  }
  process.stdout.write('[opensquid engine kill] engine daemon stopped.\n');
}

/**
 * Register the `engine` verb group on a commander program/sub-program.
 *
 * Errors thrown by subcommand handlers surface via the root program's
 * `parseAsync().catch` — registered handlers don't call `process.exit`
 * directly. `EngineCliError.hint` is rendered when present.
 */
export function registerEngineCli(program: Command): void {
  const engine = program.command('engine').description('loop-engine binary management');

  engine
    .command('doctor')
    .description('Show resolved engine binary + discovery chain.')
    .action(async () => {
      await cmdDoctor();
    });

  engine
    .command('set-path <path>')
    .description('Persist an explicit engine binary path.')
    .action(async (target: string) => {
      await cmdSetPath(target);
    });

  engine
    .command('forget')
    .description('Clear the persisted engine binary path; force re-discovery.')
    .action(async () => {
      await cmdForget();
    });

  engine
    .command('kill')
    .description('Stop the loop-engine singleton daemon (SIGTERM via pidfile + cleanup).')
    .action(async () => {
      await cmdKill();
    });
}
