import type { Command } from 'commander';

import {
  listOwnedProcesses,
  requestProcessControl,
  type HumanProcessSignalAction,
} from '../runtime/processes/process_control.js';
import { resumeOwnedProcess } from '../runtime/processes/process_resume.js';

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

async function request(action: HumanProcessSignalAction, processId: string): Promise<void> {
  assertInteractiveHuman();
  const receipt = await requestProcessControl({
    processId,
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
    .description('Human control plane for OpenSquid-owned loop and owned subprocesses');

  processCommand
    .command('list')
    .option('--active', 'show only processes that have not exited', false)
    .option('--json', 'emit the shared JSON process-state contract', false)
    .action(async (opts: { active?: boolean; json?: boolean }) => {
      const states = await listOwnedProcesses(opts.active === true);
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
          `${state.processId} · ${state.role} · ${state.status} · pid ${String(state.pid)} · ` +
            `actions [${state.availableActions.join(', ')}]\n`,
        );
      }
    });

  processCommand
    .command('stop <processId>')
    .description('request graceful RPC/stdin shutdown; sends no OS signal')
    .action((processId: string) => request('graceful_stop', processId));

  processCommand
    .command('terminate <processId>')
    .description('human-authorized SIGTERM of the exact OpenSquid-owned process group')
    .action((processId: string) => request('terminate', processId));

  processCommand
    .command('resume <processId>')
    .description('resume paused logical work from its WorkGraph checkpoint')
    .action(async (processId: string) => {
      assertInteractiveHuman();
      const result = await resumeOwnedProcess({
        processId,
        requestedBy: 'cli',
        authorizedBy: cliAuthorizationIdentity(),
      });
      process.stdout.write(`resumed ${result.processId} (${result.wgId}) — ${result.loopStatus}\n`);
    });

  processCommand
    .command('kill <processId>')
    .description('human-authorized SIGKILL of the exact OpenSquid-owned process group')
    .requiredOption('--force', 'confirm force-kill; no model or automation may supply this action')
    .action((processId: string) => request('force_kill', processId));
}
