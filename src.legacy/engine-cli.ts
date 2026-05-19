/**
 * `opensquid engine <subcommand>` — engine binary management.
 *
 * Subcommands:
 *   doctor             — show the resolved engine binary + how it was
 *                        discovered (env / config / search / PATH)
 *   set-path <path>    — persist an explicit engine binary path in
 *                        ~/.opensquid/config.json
 *   forget             — clear the persisted path; force re-discovery
 *                        on next start
 */
import { forgetEngineBin, loadConfig, resolveEngineBin, setEngineBin } from "./config.js";

export class EngineCliError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "EngineCliError";
  }
}

async function cmdDoctor(): Promise<void> {
  console.log(`[opensquid engine doctor]`);
  const env = process.env.OPENSQUID_ENGINE_BIN?.trim();
  console.log(`  env OPENSQUID_ENGINE_BIN: ${env ?? "(unset)"}`);
  const config = await loadConfig();
  console.log(`  config.engine_bin:        ${config.engine_bin ?? "(unset)"}`);
  if (config.engine_bin_resolved_at) {
    console.log(`  resolved at:              ${config.engine_bin_resolved_at}`);
  }
  const resolved = await resolveEngineBin();
  console.log(`  resolved binary:          ${resolved ?? "(none — not found)"}`);
  if (!resolved) {
    console.log(`  hint: run \`opensquid engine set-path <path>\` to fix.`);
  }
}

async function cmdSetPath(args: string[]): Promise<void> {
  const target = args[0];
  if (!target) {
    throw new EngineCliError(
      "usage: opensquid engine set-path <path>",
      "pass the path to a loop-engine release binary",
    );
  }
  const res = await setEngineBin(target);
  console.log(`[opensquid engine set-path] persisted: ${res.resolved}`);
}

async function cmdForget(): Promise<void> {
  await forgetEngineBin();
  console.log(`[opensquid engine forget] cleared persisted engine_bin`);
}

export type EngineCliCmd = "doctor" | "set-path" | "forget";

export async function runEngineCli(cmd: EngineCliCmd, argv: string[]): Promise<void> {
  switch (cmd) {
    case "doctor":
      await cmdDoctor();
      return;
    case "set-path":
      await cmdSetPath(argv);
      return;
    case "forget":
      await cmdForget();
      return;
  }
}
