/**
 * pnpm-only guard (default-discipline) — block `npm install`/`i`/`ci`/`add` ONLY in a pnpm-managed repo
 * (pnpm-lock.yaml present). Evidence for the rule: coding-flow/procedure.md:32 ("pnpm only — never npm i").
 * Universally safe: a pure-npm repo (no pnpm-lock.yaml) is NOT blocked. Deterministic, zero-LLM.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { registerEventFunctions } from '../functions/event.js';
import { PathExists } from '../functions/path_exists.js';
import { FunctionRegistry } from '../functions/registry.js';
import { registerVerdictFunctions } from '../functions/verdict.js';
import type { Event } from '../runtime/event.js';
import { evaluateProcess } from '../runtime/evaluator.js';
import type { ProcessStep, RuleResult } from '../runtime/types.js';

import { Skill } from './schemas/skill.js';
import { parseYamlFile } from './yaml.js';

const HERE = fileURLToPath(import.meta.url);
const SKILL_PATH = resolve(
  HERE,
  '../../../packs/builtin/default-discipline/skills/pnpm-only/skill.yaml',
);

let n = 0;
function buildRegistry(): FunctionRegistry {
  const reg = new FunctionRegistry();
  registerEventFunctions(reg); // match_command
  registerVerdictFunctions(reg); // verdict
  reg.register(PathExists); // path_exists
  return reg;
}

let pnpmRepo: string; // has pnpm-lock.yaml
let npmRepo: string; // no pnpm-lock.yaml
beforeAll(async () => {
  pnpmRepo = await mkdtemp(join(tmpdir(), 'pnpm-repo-'));
  await writeFile(join(pnpmRepo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
  npmRepo = await mkdtemp(join(tmpdir(), 'npm-repo-'));
  await writeFile(join(npmRepo, 'package-lock.json'), '{}', 'utf8');
});

async function steps(): Promise<ProcessStep[]> {
  const { data } = await parseYamlFile(SKILL_PATH, Skill);
  const skill = data as Skill;
  const rule = skill.rules.find((r) => r.id === 'no-npm-install-in-pnpm-repo');
  if (rule?.kind !== 'track_check') throw new Error('pnpm-only rule not a track_check');
  return rule.process;
}

function bash(command: string, cwd: string): Event {
  return { kind: 'tool_call', tool: 'Bash', args: { command }, cwd } as unknown as Event;
}
function run(s: ProcessStep[], event: Event): Promise<RuleResult> {
  return evaluateProcess(
    s,
    { event, bindings: new Map(), sessionId: `pnpm-${String(n++)}`, packId: 'default-discipline' },
    buildRegistry(),
  );
}

describe('default-discipline pnpm-only guard', () => {
  it('validates against the Skill schema', async () => {
    const { data } = await parseYamlFile(SKILL_PATH, Skill);
    expect((data as Skill).name).toBe('pnpm-only');
    expect((data as Skill).load).toBe('lazy');
  });

  it('BLOCKS `npm install` in a pnpm repo (pnpm-lock.yaml present)', async () => {
    const r = await run(await steps(), bash('npm install', pnpmRepo));
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('block');
  });

  it('BLOCKS `npm i` and `npm add <pkg>` and `npm ci` in a pnpm repo', async () => {
    for (const cmd of ['npm i', 'npm add lodash', 'npm ci']) {
      const r = await run(await steps(), bash(cmd, pnpmRepo));
      expect(r.kind, cmd).toBe('verdict');
    }
  });

  it('does NOT block `pnpm install` (the correct command)', async () => {
    const r = await run(await steps(), bash('pnpm install', pnpmRepo));
    expect(r.kind).toBe('no_verdict');
  });

  it('does NOT block `npm install` in a NON-pnpm repo (no pnpm-lock.yaml)', async () => {
    const r = await run(await steps(), bash('npm install', npmRepo));
    expect(r.kind).toBe('no_verdict');
  });

  it('does NOT block `npm publish` (a different concern) or `npm run build`', async () => {
    for (const cmd of ['npm publish', 'npm run build', 'npx tsc']) {
      const r = await run(await steps(), bash(cmd, pnpmRepo));
      expect(r.kind, cmd).toBe('no_verdict');
    }
  });

  it('blocks `npm install` after a shell operator (cd x && npm install)', async () => {
    const r = await run(await steps(), bash('cd pkg && npm install', pnpmRepo));
    expect(r.kind).toBe('verdict');
  });

  it('does NOT match a command that merely MENTIONS npm install (e.g. a commit message)', async () => {
    // the over-match bug this regression guards: a git commit whose message text contains "npm install".
    const r = await run(
      await steps(),
      bash('git commit -m "guard blocking npm install in pnpm repos"', pnpmRepo),
    );
    expect(r.kind).toBe('no_verdict');
  });
});
