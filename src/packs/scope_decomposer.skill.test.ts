/**
 * Behavior tests for the shipped `scope-decomposer` skill (Track SD.2 + SD.3).
 *
 * Loads the ACTUAL built-in pack (not a re-spec) and evaluates its real rules
 * against constructed events, so the test breaks if the shipped skill.yaml
 * regresses. The `inline-spec-block` no-artifact case is the anti-fail-open
 * anchor: if the gate ever silently passes a genuine inline-spec, that test
 * goes RED.
 *
 * path_exists resolves its `dir` against `ctx.event.cwd`, so each tool_call
 * fixture sets `cwd` to a tmp dir that either has or lacks
 * `docs/research/*-pre-research-*.md`.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerEventFunctions } from '../functions/event.js';
import { type EvalCtx, FunctionRegistry } from '../functions/registry.js';
import { PathExists } from '../functions/path_exists.js';
import { TextPatternMatch } from '../functions/text_pattern_match.js';
import { registerVerdictFunctions } from '../functions/verdict.js';
import type { Event } from '../runtime/event.js';
import { evaluateProcess } from '../runtime/evaluator.js';
import type { ProcessStep, RuleResult } from '../runtime/types.js';

import { loadPack } from './loader.js';

const HERE = fileURLToPath(import.meta.url);
const PACK_DIR = resolve(HERE, '../../../packs/builtin/sangmin-personal');

function buildTestRegistry(): FunctionRegistry {
  const reg = new FunctionRegistry();
  registerEventFunctions(reg); // tool_name, tool_args, cwd, ...
  registerVerdictFunctions(reg); // verdict
  reg.register(TextPatternMatch);
  reg.register(PathExists);
  return reg;
}

function ctxWith(event: Event): EvalCtx {
  return {
    event,
    bindings: new Map<string, unknown>(),
    sessionId: 's',
    packId: 'sangmin-personal',
  };
}

async function runRule(process: ProcessStep[], event: Event): Promise<RuleResult> {
  return evaluateProcess(process, ctxWith(event), buildTestRegistry());
}

let nudgeSteps: ProcessStep[];
let blockSteps: ProcessStep[];
let tmpNoArtifact: string;
let tmpWithArtifact: string;

beforeAll(async () => {
  const pack = await loadPack(PACK_DIR);
  const skill = pack.skills.find((s) => s.name === 'scope-decomposer');
  if (!skill) throw new Error('scope-decomposer skill not found in pack');
  const nudge = skill.rules.find((r) => r.id === 'scope-intent-nudge');
  const block = skill.rules.find((r) => r.id === 'inline-spec-block');
  if (nudge?.kind !== 'track_check') throw new Error('scope-intent-nudge not a track_check');
  if (block?.kind !== 'track_check') throw new Error('inline-spec-block not a track_check');
  nudgeSteps = nudge.process;
  blockSteps = block.process;

  tmpNoArtifact = await mkdtemp(join(tmpdir(), 'sd-no-artifact-'));
  await mkdir(join(tmpNoArtifact, 'docs', 'tasks'), { recursive: true });

  tmpWithArtifact = await mkdtemp(join(tmpdir(), 'sd-with-artifact-'));
  await mkdir(join(tmpWithArtifact, 'docs', 'research'), { recursive: true });
  await mkdir(join(tmpWithArtifact, 'docs', 'tasks'), { recursive: true });
  await writeFile(
    join(tmpWithArtifact, 'docs', 'research', 'T-foo-pre-research-2026-05-26.md'),
    '# pre-research',
  );
});

afterAll(async () => {
  await rm(tmpNoArtifact, { recursive: true, force: true });
  await rm(tmpWithArtifact, { recursive: true, force: true });
});

const SPEC_BODY = '### Task FOO.1\n\n**Deliverable:** ship the thing\n**Required skills:** X';

describe('scope-decomposer / scope-intent-nudge', () => {
  it('warns on scope-authoring intent', async () => {
    const r = await runRule(nudgeSteps, {
      kind: 'prompt_submit',
      prompt: 'spec out a new track for the memory fix',
    });
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('warn');
  });

  it('stays silent on a non-scope prompt', async () => {
    const r = await runRule(nudgeSteps, {
      kind: 'prompt_submit',
      prompt: 'what is the weather today',
    });
    expect(r.kind).toBe('no_verdict');
  });
});

describe('scope-decomposer / inline-spec-block', () => {
  it('BLOCKS a spec Write with no pre-research artifact (anti-fail-open anchor)', async () => {
    const r = await runRule(blockSteps, {
      kind: 'tool_call',
      tool: 'Write',
      args: { file_path: 'docs/tasks/T-foo.md', content: SPEC_BODY },
      cwd: tmpNoArtifact,
    });
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('block');
  });

  it('passes a spec Write when a pre-research artifact is present', async () => {
    const r = await runRule(blockSteps, {
      kind: 'tool_call',
      tool: 'Write',
      args: { file_path: 'docs/tasks/T-foo.md', content: SPEC_BODY },
      cwd: tmpWithArtifact,
    });
    expect(r.kind).toBe('no_verdict');
  });

  it('BLOCKS an Edit that injects a task block into TASKS.md with no artifact', async () => {
    const r = await runRule(blockSteps, {
      kind: 'tool_call',
      tool: 'Edit',
      args: { file_path: 'TASKS.md', old_string: 'x', new_string: SPEC_BODY },
      cwd: tmpNoArtifact,
    });
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('block');
  });

  it('passes a non-spec Write (src/**)', async () => {
    const r = await runRule(blockSteps, {
      kind: 'tool_call',
      tool: 'Write',
      args: { file_path: 'src/foo.ts', content: 'export const x = 1;' },
      cwd: tmpNoArtifact,
    });
    expect(r.kind).toBe('no_verdict');
  });

  it('passes a prose-only Write to a spec destination (no task markers)', async () => {
    const r = await runRule(blockSteps, {
      kind: 'tool_call',
      tool: 'Write',
      args: { file_path: 'docs/tasks/T-foo.md', content: 'just some prose, no task markers here' },
      cwd: tmpNoArtifact,
    });
    expect(r.kind).toBe('no_verdict');
  });
});
