import { describe, expect, it } from 'vitest';

import { AuditFanout, type AuditLens, type AuditLensVerdict } from './audit_fanout.js';

const lenses: AuditLens[] = [
  { id: 'evidence', prompt: 'evidence prompt' },
  { id: 'solution', prompt: 'solution prompt' },
  { id: 'architecture', prompt: 'architecture prompt' },
  { id: 'scale', prompt: 'scale prompt' },
];
const hash = (lens: AuditLens): string => `hash:${lens.id}:${lens.prompt}`;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AuditFanout', () => {
  it('starts every missing lens before awaiting any result and preserves declaration order', async () => {
    const gates = new Map(lenses.map((lens) => [lens.id, deferred<string>()]));
    const started: string[] = [];
    const running = new AuditFanout().run(lenses, new Map(), hash, (lens) => {
      started.push(lens.id);
      return gates.get(lens.id)!.promise;
    });

    await Promise.resolve();
    expect(started).toEqual(lenses.map((lens) => lens.id));
    for (const lens of [...lenses].reverse()) gates.get(lens.id)!.resolve(`VERDICT: ${lens.id}`);

    const result = await running;
    expect(result.failures).toEqual([]);
    expect(result.completed.map((entry) => entry.id)).toEqual(lenses.map((lens) => lens.id));
  });

  it('reuses matching cached lenses and runs only missing or changed lenses', async () => {
    const cached = new Map<string, AuditLensVerdict>([
      [
        'evidence',
        {
          id: 'evidence',
          promptHash: hash(lenses[0]!),
          output: 'VERDICT: GUESS_FREE',
        },
      ],
      ['solution', { id: 'solution', promptHash: 'stale', output: 'VERDICT: GUESS_FREE' }],
    ]);
    const started: string[] = [];
    const result = await new AuditFanout().run(lenses, cached, hash, (lens) => {
      started.push(lens.id);
      return Promise.resolve('VERDICT: GUESS_FREE');
    });

    expect(started).toEqual(['solution', 'architecture', 'scale']);
    expect(result.completed).toHaveLength(4);
  });

  it('waits for all lenses and reports failures without discarding completed reviews', async () => {
    const result = await new AuditFanout().run(lenses, new Map(), hash, (lens) =>
      lens.id === 'architecture'
        ? Promise.reject(new Error('review timeout'))
        : Promise.resolve('VERDICT: GUESS_FREE'),
    );

    expect(result.completed.map((entry) => entry.id)).toEqual(['evidence', 'solution', 'scale']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.id).toBe('architecture');
  });

  it('rejects duplicate, unbounded, and invalid-id declarations through the shared schema', async () => {
    await expect(
      new AuditFanout().run([lenses[0]!, lenses[0]!], new Map(), hash, () => Promise.resolve('')),
    ).rejects.toThrow('invalid audit lens set');
    await expect(
      new AuditFanout().run([lenses[0]!], new Map(), hash, () => Promise.resolve('')),
    ).rejects.toThrow('invalid audit lens set');
    await expect(
      new AuditFanout().run(
        [lenses[0]!, { id: 'x'.repeat(65), prompt: 'too long' }],
        new Map(),
        hash,
        () => Promise.resolve(''),
      ),
    ).rejects.toThrow('invalid audit lens set');
    await expect(
      new AuditFanout().run(
        [lenses[0]!, { id: 'bounded', prompt: 'x'.repeat(300_001) }],
        new Map(),
        hash,
        () => Promise.resolve(''),
      ),
    ).rejects.toThrow('audit text exceeds 300000 bytes');
    await expect(
      new AuditFanout().run(
        [lenses[0]!, { id: 'criteria-count', prompt: 'p', criteria: Array(17).fill('c') }],
        new Map(),
        hash,
        () => Promise.resolve(''),
      ),
    ).rejects.toThrow('Array must contain at most 16 element');
    await expect(
      new AuditFanout().run(
        [lenses[0]!, { id: 'criterion-size', prompt: 'p', criteria: ['c'.repeat(4_097)] }],
        new Map(),
        hash,
        () => Promise.resolve(''),
      ),
    ).rejects.toThrow('audit criterion exceeds 4096 bytes');
    await expect(
      new AuditFanout().run(
        [lenses[0]!, { id: 'rendered-size', prompt: 'p'.repeat(299_990), criteria: ['criterion'] }],
        new Map(),
        hash,
        () => Promise.resolve(''),
      ),
    ).rejects.toThrow('rendered audit prompt exceeds 300000 bytes');
  });
});
