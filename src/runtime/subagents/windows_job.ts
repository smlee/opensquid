import { createHash, randomUUID } from 'node:crypto';
import {
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ProcControl } from '../spawn_lifecycle.js';

const BROKER_PATH = fileURLToPath(new URL('./windows_job_broker.ps1', import.meta.url));
const CONTROL_PATH = fileURLToPath(new URL('./windows_job_control.ps1', import.meta.url));

export interface WindowsJobIdentity {
  readonly jobName: string;
  readonly metadataPath: string;
}

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/** Windows CreateProcess command-line quoting compatible with CommandLineToArgvW. */
export function quoteWindowsArg(value: string): string {
  if (value !== '' && !/[\s"]/u.test(value)) return value;
  let quoted = '"';
  let slashes = 0;
  for (const char of value) {
    if (char === '\\') {
      slashes += 1;
      continue;
    }
    if (char === '"') {
      quoted += '\\'.repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    quoted += '\\'.repeat(slashes) + char;
    slashes = 0;
  }
  return `${quoted}${'\\'.repeat(slashes * 2)}"`;
}

function resolveWindowsApplication(cli: string, env: NodeJS.ProcessEnv): string {
  if (isAbsolute(cli)) return cli;
  const found = spawnSync('where.exe', [cli], {
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  const first = found.status === 0 ? found.stdout.split(/\r?\n/u).find(Boolean) : undefined;
  if (first === undefined) throw new Error(`Windows could not resolve harness executable: ${cli}`);
  return first;
}

function targetInvocation(
  cli: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { application: string; commandLine: string } {
  const resolved = resolveWindowsApplication(cli, env);
  const extension = extname(resolved).toLowerCase();
  if (extension === '.cmd' || extension === '.bat') {
    const command = [resolved, ...args].map(quoteWindowsArg).join(' ');
    const application = env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
    return {
      application,
      commandLine: [application, '/d', '/s', '/c', `"${command}"`].map(quoteWindowsArg).join(' '),
    };
  }
  return {
    application: resolved,
    commandLine: [resolved, ...args].map(quoteWindowsArg).join(' '),
  };
}

export function createWindowsJobIdentity(executorId: string): WindowsJobIdentity {
  const digest = createHash('sha256')
    .update(`${executorId}\0${randomUUID()}`)
    .digest('hex')
    .slice(0, 32);
  return {
    jobName: `Local\\OpenSquid-${digest}`,
    metadataPath: join(tmpdir(), `opensquid-job-${digest}.json`),
  };
}

/** Spawn the harness suspended inside an exact named Job Object, with the PowerShell broker proxying stdio. */
export function spawnInWindowsJob(
  base: ProcControl,
  identity: WindowsJobIdentity,
  cli: string,
  args: string[],
  options: SpawnOptions,
): ChildProcessWithoutNullStreams {
  const env = { ...process.env, ...(options.env ?? {}) };
  const invocation = targetInvocation(cli, args, env);
  const cwd = typeof options.cwd === 'string' ? options.cwd : process.cwd();
  return base.spawn(
    env.ComSpec === undefined && env.COMSPEC === undefined ? 'powershell.exe' : 'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', BROKER_PATH],
    {
      ...options,
      detached: false,
      env: {
        ...env,
        OPENSQUID_WINDOWS_APPLICATION_B64: b64(invocation.application),
        OPENSQUID_WINDOWS_COMMAND_LINE_B64: b64(invocation.commandLine),
        OPENSQUID_WINDOWS_CWD_B64: b64(cwd),
        OPENSQUID_WINDOWS_JOB_NAME: identity.jobName,
        OPENSQUID_WINDOWS_JOB_METADATA: identity.metadataPath,
      },
    },
  );
}

export async function controlWindowsJob(
  base: ProcControl,
  identity: WindowsJobIdentity,
  action: 'terminate' | 'force_kill',
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = base.spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        CONTROL_PATH,
        '-JobName',
        identity.jobName,
        '-Action',
        action,
        '-MetadataPath',
        identity.metadataPath,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Windows Job Object ${action} failed: ${stderr.trim()}`));
    });
    child.stdin.end();
  });
}
