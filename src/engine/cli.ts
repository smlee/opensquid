/**
 * `opensquid engine <subcommand>` — engine binary management.
 *
 * Subcommands:
 *   doctor             — show the resolved engine binary + how it was
 *                        discovered (env / config / search / PATH)
 *   set-path <path>    — persist an explicit engine binary path in
 *                        ~/.opensquid/engine-config.json
 *   forget             — clear the persisted path; force re-discovery
 *                        on next start
 *   kill               — close any in-process EngineClient (no-op for
 *                        the CLI process; placeholder for future daemon
 *                        UDS shutdown signal)
 *
 * Registered into the root `opensquid` Command via `registerEngineCli`
 * — call from `src/cli.ts`.
 */
import type { Command } from 'commander';

import { forgetEngineBin, loadEngineConfig, resolveEngineBin, setEngineBin } from './config.js';

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

function cmdKill(): void {
  // T.2 ships stdio-only — there's no long-lived engine to signal yet.
  // T.4 lands UDS singleton; this command will then send a graceful
  // SIGTERM to the singleton. For now: explain + exit 0 (idempotent).
  process.stdout.write(
    '[opensquid engine kill] no long-lived engine to stop (UDS singleton lands in T.4).\n',
  );
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
    .description('Stop the loop-engine singleton (placeholder until T.4 UDS lands).')
    .action(() => {
      cmdKill();
    });
}
