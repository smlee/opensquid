import type { Command } from 'commander';

import { setupLoop } from '../wizard/loop_setup.js';
import type { HarnessKind } from '../../runtime/ralph/lap_harness.js';
import { LAP_HARNESS_KINDS } from '../../runtime/ralph/lap_harness.js';

export interface LoopSetupCliDeps {
  setup: typeof setupLoop;
  cwd(): string;
  out(text: string): void;
}

const DEFAULT_DEPS: LoopSetupCliDeps = {
  setup: setupLoop,
  cwd: () => process.cwd(),
  out: (text) => process.stdout.write(text),
};

export function registerLoopSetup(setup: Command, deps: LoopSetupCliDeps = DEFAULT_DEPS): Command {
  return setup
    .command('loop')
    .description('Configure the loop; inherit model settings unless explicitly updated')
    .requiredOption('--harness <kind>', 'claude, codex, or pi')
    .option('--cli <path>', 'harness executable (defaults to the harness name)')
    .option('--provider <name>', 'explicitly update Pi default provider (requires --model)')
    .option('--model <id>', 'explicitly update Pi default model (requires --provider)')
    .action(
      async (options: { harness: string; cli?: string; provider?: string; model?: string }) => {
        if (!LAP_HARNESS_KINDS.has(options.harness as HarnessKind)) {
          throw new Error(`unsupported loop harness: ${options.harness}`);
        }
        if ((options.provider === undefined) !== (options.model === undefined)) {
          throw new Error('--provider and --model must be supplied together');
        }
        if (options.harness !== 'pi' && options.provider !== undefined) {
          throw new Error('--provider/--model are Pi settings and require --harness pi');
        }
        const result = await deps.setup({
          harness: options.harness as HarnessKind,
          cwd: deps.cwd(),
          ...(options.cli === undefined ? {} : { cli: options.cli }),
          ...(options.provider === undefined || options.model === undefined
            ? {}
            : { piModel: { provider: options.provider, id: options.model } }),
        });
        deps.out(`loop harness: ${result.harness}\n`);
        deps.out(`ralph config: ${result.ralph.config.outcome} ${result.ralph.config.path}\n`);
        if (result.pi !== undefined) {
          deps.out(
            `Pi resolved model: ${result.pi.resolvedModel.provider}/${result.pi.resolvedModel.id}\n`,
          );
          deps.out(`Pi readiness: ready\n`);
        }
      },
    );
}
