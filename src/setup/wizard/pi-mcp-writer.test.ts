import { describe, expect, it, vi } from 'vitest';
import { writePiMcp } from './pi-mcp-writer.js';
import { buildExpectedPiMcpConfig } from '../../integrations/pi/mcp_config.js';

describe('writePiMcp', () => {
  it('writes the Pi mcp.json projection before proving readiness via prevalidation/bootstrap/probe', async () => {
    const ensureReady = vi.fn(
      (_input: { cli: string; cwd: string; env?: NodeJS.ProcessEnv; opensquidRoot?: string }) =>
        Promise.resolve({ adapterEntry: '/adapter/index.ts' }),
    );
    const writeConfig = vi.fn(() =>
      Promise.resolve({
        added: ['opensquid', 'opensquid-chat'],
        replaced: [],
        preserved: 0,
        backupPath: '/tmp/mcp.json.bak',
      }),
    );
    const expectedConfig = vi.fn((input: { env?: NodeJS.ProcessEnv }) =>
      buildExpectedPiMcpConfig({ path: `${input.env?.PI_CODING_AGENT_DIR}/mcp.json` }),
    );
    const result = await writePiMcp(
      {
        cli: 'pi',
        cwd: '/repo',
        env: { PI_CODING_AGENT_DIR: '/tmp/pi-agent' },
      },
      { expectedConfig, writeConfig, ensureReady },
    );
    expect(writeConfig.mock.invocationCallOrder[0]).toBeLessThan(
      ensureReady.mock.invocationCallOrder[0]!,
    );
    expect(writeConfig).toHaveBeenCalledWith(
      '/tmp/pi-agent/mcp.json',
      expect.objectContaining({ path: '/tmp/pi-agent/mcp.json' }),
    );
    const readinessInput = ensureReady.mock.calls[0]?.[0];
    expect(readinessInput).toMatchObject({
      cli: 'pi',
      cwd: '/repo',
      env: { PI_CODING_AGENT_DIR: '/tmp/pi-agent' },
    });
    expect(typeof readinessInput?.opensquidRoot).toBe('string');
    expect(result.added).toEqual(['opensquid', 'opensquid-chat']);
  });
});
