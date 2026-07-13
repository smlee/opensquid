import { fileURLToPath } from 'node:url';

import { ensurePiMcpReady, type PiMcpReadyInput } from '../../integrations/pi/bootstrap.js';
import {
  defaultPiExpectedConfig,
  writePiMcpConfig,
  type PiExpectedMcpConfig,
  type PiMcpWriteResult,
} from '../../integrations/pi/mcp_config.js';

const OPENSQUID_PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export type WritePiMcpOptions = PiMcpReadyInput;

export interface WritePiMcpDeps {
  expectedConfig(input: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    opensquidRoot?: string;
    enabledOptional?: ReadonlySet<string>;
  }): PiExpectedMcpConfig;
  writeConfig(path: string, expected: PiExpectedMcpConfig): Promise<PiMcpWriteResult>;
  ensureReady(input: PiMcpReadyInput): Promise<unknown>;
}

export async function writePiMcp(
  options: WritePiMcpOptions,
  deps: WritePiMcpDeps = {
    expectedConfig: defaultPiExpectedConfig,
    writeConfig: writePiMcpConfig,
    ensureReady: ensurePiMcpReady,
  },
): Promise<PiMcpWriteResult> {
  const opensquidRoot = options.opensquidRoot ?? OPENSQUID_PACKAGE_ROOT;
  const expected = deps.expectedConfig({
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    opensquidRoot,
    ...(options.enabledOptional === undefined ? {} : { enabledOptional: options.enabledOptional }),
  });
  const result = await deps.writeConfig(expected.path, expected);
  await deps.ensureReady({
    cli: options.cli,
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    opensquidRoot,
    ...(options.enabledOptional === undefined ? {} : { enabledOptional: options.enabledOptional }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return result;
}
