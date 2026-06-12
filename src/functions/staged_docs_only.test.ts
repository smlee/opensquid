import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Event } from '../runtime/event.js';

import { FunctionRegistry } from './registry.js';
import type { EvalCtx } from './registry.js';
import { registerStagedDocsOnlyFunction } from './staged_docs_only.js';

const execFileP = promisify(execFile);

let repo: string;

async function git(args: string[], cwd: string): Promise<void> {
  await execFileP('git', args, { cwd });
}

async function stage(rel: string): Promise<void> {
  const abs = join(repo, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, 'x\n');
  await git(['add', rel], repo);
}

/** Invoke the primitive with a tool_call event carrying `cwd`. */
async function call(event: Event): Promise<unknown> {
  const reg = new FunctionRegistry();
  registerStagedDocsOnlyFunction(reg);
  const def = reg.get('staged_docs_only');
  if (def === undefined) throw new Error('staged_docs_only not registered');
  const ctx: EvalCtx = {
    event,
    bindings: new Map(),
    sessionId: 'sdo-test',
    packId: 'default-discipline',
  };
  return def.execute({}, ctx);
}

const toolCall = (cwd: string | undefined): Event => ({
  kind: 'tool_call',
  tool: 'Bash',
  args: { command: 'git commit -m x' },
  ...(cwd !== undefined ? { cwd } : {}),
});

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'opensquid-sdo-'));
  await git(['init', '-q'], repo);
  await git(['config', 'user.email', 't@t'], repo);
  await git(['config', 'user.name', 't'], repo);
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('staged_docs_only primitive', () => {
  it('true when only docs files are staged', async () => {
    await stage('docs/x.md');
    expect(await call(toolCall(repo))).toEqual({ ok: true, value: true });
  });

  it('false when a code file is staged', async () => {
    await stage('src/a.ts');
    expect(await call(toolCall(repo))).toEqual({ ok: true, value: false });
  });

  it('false when both docs and code are staged', async () => {
    await stage('docs/x.md');
    await stage('src/a.ts');
    expect(await call(toolCall(repo))).toEqual({ ok: true, value: false });
  });

  it('false when nothing is staged (empty set → not docs-only)', async () => {
    expect(await call(toolCall(repo))).toEqual({ ok: true, value: false });
  });

  it('false (fail-toward-block) when cwd is not a git repo', async () => {
    const notRepo = await mkdtemp(join(tmpdir(), 'opensquid-sdo-nogit-'));
    expect(await call(toolCall(notRepo))).toEqual({ ok: true, value: false });
    await rm(notRepo, { recursive: true, force: true });
  });

  it('false when cwd is absent or empty', async () => {
    expect(await call(toolCall(undefined))).toEqual({ ok: true, value: false });
    expect(await call(toolCall(''))).toEqual({ ok: true, value: false });
  });

  it('false on a non-tool_call event', async () => {
    const stopEvent = { kind: 'stop', assistantText: 'done' } as unknown as Event;
    expect(await call(stopEvent)).toEqual({ ok: true, value: false });
  });
});
