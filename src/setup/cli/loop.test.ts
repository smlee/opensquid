import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerLoopSetup } from './loop.js';

function fixture() {
  const root = new Command().exitOverride();
  const setup = root.command('setup');
  const run = vi.fn(() =>
    Promise.resolve({
      harness: 'pi' as const,
      ralph: {
        home: '/home/.opensquid',
        ralphMd: { path: '/home/.opensquid/RALPH.md', outcome: 'created' as const },
        config: { path: '/home/.opensquid/ralph.config.json', outcome: 'created' as const },
      },
      pi: {
        piVersion: '0.80.6',
        mcpAdapterVersion: '2.11.0',
        providers: new Map([['openai-codex', new Set(['gpt-5.6-sol'])]]),
        resolvedModel: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
        registeredTools: new Set(['read']),
        activeTools: new Set(['read']),
        genericProxyAbsent: true,
        effectiveShell: {},
      },
    }),
  );
  const output: string[] = [];
  registerLoopSetup(setup, { setup: run, cwd: () => '/repo', out: (text) => output.push(text) });
  return { root, run, output };
}

describe('setup loop CLI', () => {
  it('inherits Pi settings when provider/model options are absent', async () => {
    const f = fixture();
    await f.root.parseAsync(['node', 'opensquid', 'setup', 'loop', '--harness', 'pi']);
    expect(f.run).toHaveBeenCalledWith({ harness: 'pi', cwd: '/repo' });
    expect(f.output.join('')).toContain('openai-codex/gpt-5.6-sol');
  });

  it('forwards only an explicit complete provider/model selection', async () => {
    const f = fixture();
    await f.root.parseAsync([
      'node',
      'opensquid',
      'setup',
      'loop',
      '--harness',
      'pi',
      '--provider',
      'openai-codex',
      '--model',
      'gpt-5.6-sol',
    ]);
    expect(f.run).toHaveBeenCalledWith({
      harness: 'pi',
      cwd: '/repo',
      piModel: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
    });
  });

  it('rejects a partial selection', async () => {
    const f = fixture();
    await expect(
      f.root.parseAsync([
        'node',
        'opensquid',
        'setup',
        'loop',
        '--harness',
        'pi',
        '--provider',
        'openai-codex',
      ]),
    ).rejects.toThrow(/supplied together/);
  });
});
