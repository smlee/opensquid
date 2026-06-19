/** PFV2.2 — loader-v2: read pack.yaml → LoadedPackV2. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

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
      emits: work_done
    check:
      kind: gate
      guard: looks_ok
      on_pass_emits: check_passed
      on_fail: { action: block, message: not_ok }
    shipped:
      kind: terminal
      outcome: shipped
  transitions:
    - { from: work, on: work_done, to: check }
    - { from: check, on: check_passed, to: shipped }
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
    expect(loaded.compiled.fsm).toBeDefined();
    expect(validateFsm(loaded.compiled.fsm!)).toEqual([]);
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
    a: { kind: executor, directive: d, emits: go }
    b: { kind: terminal, outcome: shipped }
`,
    );
    await expect(loadPackV2(dir)).rejects.toThrow(ZodError);
  });

  it('rejects a dangling transition target (validateFsm enforced via the compiler)', async () => {
    await writeFile(
      join(dir, 'pack.yaml'),
      `name: dangle
version: 1.0.0
scope: workflow
fsm:
  initial: a
  states:
    a: { kind: executor, directive: d, completion: c, emits: go }
  transitions:
    - { from: a, on: go, to: NOPE }
`,
    );
    await expect(loadPackV2(dir)).rejects.toThrow(/invalid FSM/);
  });

  it('rejects a malformed YAML scalar with a parse error', async () => {
    await writeFile(
      join(dir, 'pack.yaml'),
      'name: x\nversion: 1\nscope: workflow\nfsm: [unbalanced',
    );
    await expect(loadPackV2(dir)).rejects.toThrow();
  });
});
