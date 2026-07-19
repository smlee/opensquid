import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { bindStdioLifetime } from './stdio_lifecycle.js';

function fixture() {
  const stdin = new EventEmitter() as EventEmitter & NodeJS.ReadableStream;
  const processRef = new EventEmitter() as EventEmitter & {
    exit: (code?: number) => never;
    stderr: { write: (text: string) => unknown };
  };
  const exits: number[] = [];
  processRef.exit = ((code?: number) => {
    exits.push(code ?? 0);
    return undefined;
  }) as (code?: number) => never;
  processRef.stderr = { write: vi.fn() };
  return { stdin, processRef, exits };
}

describe('bindStdioLifetime', () => {
  it('closes cleanup and the server exactly once when the parent pipe reaches EOF', async () => {
    const { stdin, processRef } = fixture();
    const order: string[] = [];
    const lifetime = bindStdioLifetime({
      stdin,
      processRef,
      cleanup: () => {
        order.push('cleanup');
      },
      closeServer: () => {
        order.push('server');
        return Promise.resolve();
      },
    });

    stdin.emit('end');
    stdin.emit('close');
    await lifetime.close();
    expect(order).toEqual(['cleanup', 'server']);
  });

  it('awaits cleanup and exits with the conventional SIGTERM status', async () => {
    const { stdin, processRef, exits } = fixture();
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    bindStdioLifetime({
      stdin,
      processRef,
      cleanup: () => cleanup,
      closeServer: () => Promise.resolve(),
    });

    processRef.emit('SIGTERM');
    await Promise.resolve();
    expect(exits).toEqual([]);
    release();
    await vi.waitFor(() => expect(exits).toEqual([143]));
  });
});
