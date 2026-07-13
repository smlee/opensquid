import { describe, expect, it, vi } from 'vitest';

import { setupLoop } from './loop_setup.js';

const ralph = {
  home: '/home/user/.opensquid',
  ralphMd: { path: '/home/user/.opensquid/RALPH.md', outcome: 'created' as const },
  config: { path: '/home/user/.opensquid/ralph.config.json', outcome: 'created' as const },
};

describe('setupLoop', () => {
  it('configures Pi without provider/model fields and reports Pi-resolved settings', async () => {
    const installRalph = vi.fn(() => Promise.resolve(ralph));
    const writePiMcp = vi.fn(() =>
      Promise.resolve({ added: ['opensquid'], replaced: [], preserved: 0, backupPath: '' }),
    );
    const updatePiModelSelection = vi.fn();
    const writePiProjector = vi.fn(() =>
      Promise.resolve({
        path: '/pi/extensions/opensquid-projector.js',
        outcome: 'created' as const,
      }),
    );
    const piReadiness = vi.fn(() =>
      Promise.resolve({
        piVersion: '0.80.6',
        mcpAdapterVersion: '2.11.0',
        providers: new Map([['openai-codex', new Set(['gpt-5.6-sol'])]]),
        resolvedModel: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
        registeredTools: new Set(['read']),
        activeTools: new Set(['read']),
        genericProxyAbsent: true,
        effectiveShell: {},
        roleManifestPath: '/pi/roles.json',
        roleManifestHash: 'a'.repeat(64),
      }),
    );

    const result = await setupLoop(
      { harness: 'pi', cli: '/bin/pi', cwd: '/repo', home: '/home/user/.opensquid' },
      { installRalph, writePiMcp, piReadiness, updatePiModelSelection, writePiProjector },
    );

    expect(installRalph).toHaveBeenCalledWith({
      home: '/home/user/.opensquid',
      overrides: {
        harness: {
          kind: 'pi',
          cli: '/bin/pi',
          ralphMdPath: '/home/user/.opensquid/RALPH.md',
        },
      },
    });
    expect(JSON.stringify(installRalph.mock.calls[0])).not.toMatch(/provider|model/);
    expect(updatePiModelSelection).not.toHaveBeenCalled();
    expect(writePiProjector).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(writePiProjector.mock.calls)).toContain(
      'dist/integrations/pi/projector.js',
    );
    expect(writePiMcp).toHaveBeenCalledWith({ cli: '/bin/pi', cwd: '/repo' });
    expect(result.pi?.resolvedModel).toEqual({
      provider: 'openai-codex',
      id: 'gpt-5.6-sol',
    });
  });

  it('does not select Pi in Ralph config until Pi asset preparation and readiness pass', async () => {
    const installRalph = vi.fn(() => Promise.resolve(ralph));
    await expect(
      setupLoop(
        { harness: 'pi', cli: 'pi', cwd: '/repo' },
        {
          installRalph,
          writePiMcp: vi.fn(() =>
            Promise.resolve({ added: [], replaced: [], preserved: 0, backupPath: '' }),
          ),
          writePiProjector: vi.fn(() =>
            Promise.resolve({ path: '/pi/projector.ts', outcome: 'created' as const }),
          ),
          updatePiModelSelection: vi.fn(),
          piReadiness: vi.fn(() => Promise.reject(new Error('probe failed'))),
        },
      ),
    ).rejects.toThrow('probe failed');
    expect(installRalph).not.toHaveBeenCalled();
  });

  it('updates Pi settings only for an explicit user selection', async () => {
    const installRalph = vi.fn(() => Promise.resolve(ralph));
    const writePiMcp = vi.fn(() =>
      Promise.resolve({ added: [], replaced: [], preserved: 2, backupPath: '' }),
    );
    const writePiProjector = vi.fn(() =>
      Promise.resolve({
        path: '/pi/extensions/opensquid-projector.js',
        outcome: 'created' as const,
      }),
    );
    const updatePiModelSelection = vi.fn(() =>
      Promise.resolve({
        path: '/pi/settings.json',
        outcome: 'updated' as const,
        selection: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
      }),
    );
    const piReadiness = vi.fn(() =>
      Promise.resolve({
        piVersion: '0.80.6',
        mcpAdapterVersion: '2.11.0',
        providers: new Map([['openai-codex', new Set(['gpt-5.6-sol'])]]),
        resolvedModel: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
        registeredTools: new Set(['read']),
        activeTools: new Set(['read']),
        genericProxyAbsent: true,
        effectiveShell: {},
        roleManifestPath: '/pi/roles.json',
        roleManifestHash: 'a'.repeat(64),
      }),
    );
    await setupLoop(
      {
        harness: 'pi',
        cli: 'pi',
        cwd: '/repo',
        piModel: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
      },
      { installRalph, writePiMcp, piReadiness, updatePiModelSelection, writePiProjector },
    );
    expect(updatePiModelSelection).toHaveBeenCalledWith({
      selection: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
      cli: 'pi',
      cwd: '/repo',
    });
  });

  it('does not run Pi setup for another harness', async () => {
    const installRalph = vi.fn(() => Promise.resolve(ralph));
    const writePiMcp = vi.fn();
    const piReadiness = vi.fn();
    const updatePiModelSelection = vi.fn();
    const writePiProjector = vi.fn();
    await expect(
      setupLoop(
        { harness: 'codex', cwd: '/repo' },
        { installRalph, writePiMcp, piReadiness, updatePiModelSelection, writePiProjector },
      ),
    ).resolves.toMatchObject({ harness: 'codex' });
    expect(writePiMcp).not.toHaveBeenCalled();
    expect(piReadiness).not.toHaveBeenCalled();
  });
});
