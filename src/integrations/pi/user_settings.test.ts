import { describe, expect, it, vi } from 'vitest';

import { updatePiModelSelection } from './user_settings.js';

describe('updatePiModelSelection', () => {
  it('validates and preserves unrelated Pi settings for an explicit update', async () => {
    const writes = new Map<string, string>();
    const result = await updatePiModelSelection(
      {
        selection: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
        cli: 'pi',
        cwd: '/repo',
        env: { PI_CODING_AGENT_DIR: '/pi-agent' },
      },
      {
        getAvailable: vi.fn(() =>
          Promise.resolve(new Map([['openai-codex', new Set(['gpt-5.6-sol'])]])),
        ),
        readText: vi.fn(() => Promise.resolve('{"theme":"light","defaultModel":"old"}\n')),
        ensureDir: vi.fn(() => Promise.resolve()),
        writeBackup: vi.fn((path: string, text: string) => {
          writes.set(path, text);
          return Promise.resolve();
        }),
        writeAtomic: vi.fn((path: string, text: string) => {
          writes.set(path, text);
          return Promise.resolve();
        }),
      },
    );
    expect(result).toMatchObject({ outcome: 'updated' });
    expect(JSON.parse(writes.get('/pi-agent/settings.json') ?? '{}')).toEqual({
      theme: 'light',
      defaultModel: 'gpt-5.6-sol',
      defaultProvider: 'openai-codex',
    });
    expect(writes.get('/pi-agent/settings.json.bak')).toContain('"theme":"light"');
  });

  it('refuses an unavailable selection before writing settings', async () => {
    const writeAtomic = vi.fn();
    await expect(
      updatePiModelSelection(
        {
          selection: { provider: 'missing', id: 'model' },
          cli: 'pi',
          cwd: '/repo',
        },
        {
          getAvailable: vi.fn(() => Promise.resolve(new Map())),
          readText: vi.fn(),
          ensureDir: vi.fn(),
          writeBackup: vi.fn(),
          writeAtomic,
        },
      ),
    ).rejects.toThrow(/unavailable/);
    expect(writeAtomic).not.toHaveBeenCalled();
  });
});
