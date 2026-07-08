/** PFV2.2 — loader-v2: read pack.yaml → LoadedPackV2. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { validateFsm } from '../runtime/fsm.js';
import { loadPackV2 } from './loader_v2.js';

const PACK_YAML = `
name: tiny
version: 1.0.0
scope: workflow
guards:
  looks_ok: "true"
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

  it('warns and LOADS on an unknown pack.yaml top-level key (was: crash, wg-a02313251dfb)', async () => {
    const warned: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((c: string | Uint8Array): boolean => (warned.push(String(c)), true));
    try {
      // A genuinely-unknown top-level key (NOT `versioning:`, which is now recognized) on an otherwise-valid pack.
      await writeFile(
        join(dir, 'pack.yaml'),
        `name: fwd
version: 1.0.0
scope: workflow
future_flag: true
foundation:
  manifest: strict-ts
  lessons: []
`,
      );
      const loaded = await loadPackV2(dir); // NO throw
      expect(loaded.pack.name).toBe('fwd');
      expect(warned.join('')).toContain('pack.yaml'); // source named
      expect(warned.join('')).toContain("'future_flag'"); // key NAMED
    } finally {
      spy.mockRestore();
    }
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

  // H1 — loadPackV2 loads the pack's skills/ dir into LoadedPackV2.skills (reusing the v1 loadSkillsDir).
  it('loads skills/<name>/skill.yaml into LoadedPackV2.skills', async () => {
    await writeFile(join(dir, 'pack.yaml'), PACK_YAML);
    const sdir = join(dir, 'skills', 'demo-skill');
    await mkdir(sdir, { recursive: true });
    await writeFile(
      join(sdir, 'skill.yaml'),
      `name: demo-skill
load: preload
triggers: [{ kind: tool_call }]
rules:
  - id: demo
    process:
      - call: verdict
        args: { level: surface, message: hi }
`,
    );
    const loaded = await loadPackV2(dir);
    expect(loaded.skills.map((s) => s.name)).toEqual(['demo-skill']);
  });

  it('returns skills: [] when the pack has no skills/ dir (ENOENT contract)', async () => {
    await writeFile(join(dir, 'pack.yaml'), PACK_YAML);
    const loaded = await loadPackV2(dir);
    expect(loaded.skills).toEqual([]);
  });

  it('fails loud on a malformed skill.yaml', async () => {
    await writeFile(join(dir, 'pack.yaml'), PACK_YAML);
    const sdir = join(dir, 'skills', 'bad');
    await mkdir(sdir, { recursive: true });
    await writeFile(join(sdir, 'skill.yaml'), 'name: 123\nrules: not-an-array\n');
    await expect(loadPackV2(dir)).rejects.toThrow();
  });

  it('live-loads the real fullstack-flow pack skills (≥1; includes a lens)', async () => {
    const here = dirname(fileURLToPath(import.meta.url)); // src/packs
    const packDir = join(here, '..', '..', 'packs', 'builtin', 'fullstack-flow');
    const loaded = await loadPackV2(packDir);
    expect(loaded.skills.length).toBeGreaterThan(0);
    expect(loaded.skills.map((s) => s.name)).toContain('security'); // an engineering lens
  });
});
