/** PFV2.2 — loader-v2: read pack.yaml → LoadedPackV2. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateFsm } from '../runtime/fsm.js';
import { loadPackV2 } from './loader_v2.js';

const PACK_YAML = `
name: tiny
version: 1.0.0
scope: workflow
fsm:
  initial: work
  states:
    work:
      kind: executor
      directive: do the thing
      completion: done_ok
      next: check
    check:
      kind: gate
      guard: looks_ok
      on_pass: { to: shipped }
      on_fail: { action: block, message: not_ok }
    shipped:
      kind: terminal
      outcome: shipped
messages:
  not_ok: "Fix it and re-run."
`;

describe('loadPackV2 (PFV2.2)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'osq-packv2-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads pack.yaml, validates, and compiles to a machine the engine accepts', async () => {
    await writeFile(join(dir, 'pack.yaml'), PACK_YAML);
    const loaded = await loadPackV2(dir);
    expect(loaded.pack.name).toBe('tiny');
    expect(validateFsm(loaded.compiled.fsm)).toEqual([]);
    expect(loaded.compiled.meta.work).toMatchObject({ kind: 'executor', completion: 'done_ok' });
    expect(loaded.messages.not_ok).toBe('Fix it and re-run.');
  });

  it('fails loud on a missing pack.yaml', async () => {
    await expect(loadPackV2(dir)).rejects.toThrow();
  });

  it('fails loud (ZodError) on a malformed pack (executor missing completion)', async () => {
    await writeFile(
      join(dir, 'pack.yaml'),
      `name: bad
version: 1.0.0
scope: workflow
fsm:
  initial: a
  states:
    a: { kind: executor, directive: d, next: b }
    b: { kind: terminal, outcome: shipped }
`,
    );
    await expect(loadPackV2(dir)).rejects.toThrow();
  });
});
