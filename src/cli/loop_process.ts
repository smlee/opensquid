import type { Command } from 'commander';

import {
  listExecutorProcesses,
  requestExecutorControl,
  type HumanProcessSignalAction,
} from '../runtime/subagents/process_control.js';
import { resumeExecutorProcess } from '../runtime/subagents/process_resume.js';

function assertInteractiveHuman(): void {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error(
      'process-control actions require an interactive human CLI; use the authenticated TUI/web API',
    );
  }
}

function cliAuthorizationIdentity(): string {
  const configured = process.env.USER?.trim() ?? process.env.USERNAME?.trim();
  const user = configured === undefined || configured === '' ? 'unknown' : configured;
  return `cli:${user}`;
}

async function request(action: HumanProcessSignalAction, executorId: string): Promise<void> {
  assertInteractiveHuman();
  const receipt = await requestExecutorControl({
    executorId,
    action,
    requestedBy: 'cli',
    authorizedBy: cliAuthorizationIdentity(),
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  if (receipt.result === 'failed') process.exitCode = 1;
}

/** Thin human CLI adapter over the shared process-control state/action contract used by TUI and web UI. */
export function registerLoopProcess(loop: Command): void {
  const processCommand = loop
    .command('process')
    .description('Human control plane for OpenSquid-owned loop and executor subprocesses');

  processCommand
    .command('list')
    .option('--active', 'show only processes that have not exited', false)
    .option('--json', 'emit the shared JSON process-state contract', false)
    .action(async (opts: { active?: boolean; json?: boolean }) => {
      const states = await listExecutorProcesses(opts.active === true);
      if (opts.json === true) {
        process.stdout.write(`${JSON.stringify(states, null, 2)}\n`);
        return;
      }
      if (states.length === 0) {
        process.stdout.write('no loop subprocesses recorded\n');
        return;
      }
      for (const state of states) {
        process.stdout.write(
          `${state.executorId} · ${state.role} · ${state.status} · pid ${String(state.pid)} · ` +
            `actions [${state.availableActions.join(', ')}]\n`,
        );
      }
    });

  processCommand
    .command('stop <executorId>')
    .description('request graceful RPC/stdin shutdown; sends no OS signal')
    .action((executorId: string) => request('graceful_stop', executorId));

  processCommand
    .command('terminate <executorId>')
    .description('human-authorized SIGTERM of the exact OpenSquid-owned process group')
    .action((executorId: string) => request('terminate', executorId));

  processCommand
    .command('resume <executorId>')
    .description('resume paused logical work from its WorkGraph checkpoint')
    .action(async (executorId: string) => {
      assertInteractiveHuman();
      const result = await resumeExecutorProcess({
        executorId,
        requestedBy: 'cli',
        authorizedBy: cliAuthorizationIdentity(),
      });
      process.stdout.write(
        `resumed ${result.executorId} (${result.wgId}) — ${result.loopStatus}\n`,
      );
    });

  processCommand
    .command('kill <executorId>')
    .description('human-authorized SIGKILL of the exact OpenSquid-owned process group')
    .requiredOption('--force', 'confirm force-kill; no model or automation may supply this action')
    .action((executorId: string) => request('force_kill', executorId));
}
