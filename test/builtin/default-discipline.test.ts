/**
 * E2E test for the built-in default-discipline pack.
 *
 * Renamed from `sangmin-personal` per T-BUILTIN-RETIRE BR.1 (2026-05-29):
 * the previous name implied personal content despite the pack carrying
 * generic drift-gate discipline. Authoritative source:
 * docs/tasks/T-builtin-retire.md.
 *
 * Acceptance:
 *  - Pack folder + side-files present.
 *  - Pack loads cleanly via the Phase 2 loader.
 *  - validateUniqueSkillNames passes (no skill name collisions).
 *  - validatePackFunctions passes against the runtime registry (every
 *    `call:` resolves to a registered primitive).
 *  - Seven skill folders (d9-guard, engine-vocab, git, honesty-ledger,
 *    phase-logging, versioning, workflow).
 *
 * The pack ships from packs/builtin/default-discipline/ (in package.json's
 * `files`). We resolve the path relative to process.cwd() so the test
 * runs from the repo regardless of invocation directory.
 */

import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadPack } from '../../src/packs/loader.js';
import { validatePackFunctions } from '../../src/packs/validate_functions.js';
import { validateUniqueSkillNames } from '../../src/packs/validate_uniqueness.js';
import { buildRegistry } from '../../src/runtime/bootstrap.js';
import { dispatchEvent } from '../../src/runtime/hooks/dispatch.js';

describe('builtin default-discipline pack', () => {
  it('loads cleanly via loadPack', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    expect(pack.name).toBe('default-discipline');
    expect(pack.scope).toBe('universal');
    expect(pack.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pack.goal).toMatch(/verified work/i);
    expect(pack.evolves).toBe(true);
  });

  it('ships d9-guard + workflow + the synthetic guards skill (FC.1b migrated 5 folders)', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    const skillNames = pack.skills.map((s) => s.name).sort();
    // FC.1b: git/engine-vocab/versioning/honesty-ledger/phase-logging folders were
    // deleted; their rules are now the compiled `default-discipline/guards` skill.
    expect(skillNames).toEqual([
      'd9-guard',
      'default-discipline/guards',
      'inbound-greeter',
      'pnpm-only',
      'session-connection-check',
      'workflow',
    ]);
  });

  it('passes validateUniqueSkillNames (no in-pack collisions)', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    const issues = validateUniqueSkillNames([pack]);
    expect(issues).toEqual([]);
  });

  it('every process step references a registered primitive', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    // Inject a no-op RAG backend so the test doesn't try to spawn a live
    // loop-engine daemon (T.3 wired RAG; resolveBackendConfig() defaults
    // to loop-engine when the binary is discoverable). Registry shape is
    // independent of which backend services the calls — validatePackFunctions
    // only checks primitive names are registered.
    const registry = await buildRegistry({
      backend: {
        init: () => Promise.resolve(),
        embed: () => Promise.resolve(null),
        recall: () => Promise.resolve([]),
        storeLesson: () => Promise.resolve(),
        deleteLesson: () => Promise.resolve({ deleted: false, forced: false }),
      },
    });
    const issues = validatePackFunctions(pack, registry);
    expect(issues).toEqual([]);
  });

  it('compiles all 21 cluster rules into the synthetic default-discipline/guards skill', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    const guards = pack.skills.find((s) => s.name === 'default-discipline/guards');
    expect(guards).toBeDefined();
    const ids = guards?.rules.map((r) => r.id) ?? [];
    expect(ids.filter((i) => i.startsWith('guard:'))).toHaveLength(21);
    // git block rules (no-implicit-push stays removed — push is pre-authorized).
    expect(ids).toContain('guard:never-amend');
    expect(ids).toContain('guard:no-force-push-main');
    expect(ids).toContain('guard:substrate-purity');
    expect(ids).toContain('guard:versioning-pre1-patch-only');
  });

  it('declares workflow skill with a destination_check + track_check pair', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    const workflow = pack.skills.find((s) => s.name === 'workflow');
    expect(workflow).toBeDefined();
    expect(workflow?.load).toBe('preload');
    const kinds = workflow?.rules.map((r) => r.kind).sort();
    expect(kinds).toEqual(['destination_check', 'track_check']);
  });

  it('carries the 14 honesty-ledger + 3 phase-logging claim gates as guards', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    const guards = pack.skills.find((s) => s.name === 'default-discipline/guards');
    const ids = new Set(guards?.rules.map((r) => r.id));
    for (const n of [
      'research-start',
      'committed',
      'pushed',
      'ci-verify-after-push', // honesty-ledger sample (14 total)
      'version-slot-assignment',
      'phase-claim-forward',
      'session-no-task', // phase-logging (3)
    ]) {
      expect(ids.has(`guard:${n}`), `missing guard:${n}`).toBe(true);
    }
  });

  it('each migrated guard resolves to its intended drift policy (no silent default fallthrough)', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    const pr = pack.driftResponse?.per_rule ?? {};
    // blocks/stops preserved
    expect(pr['guard:never-amend']).toBe('block_tool');
    expect(pr['guard:no-force-push-main']).toBe('block_tool');
    expect(pr['guard:versioning-pre1-patch-only']).toBe('full_stop_and_redo');
    expect(pr['guard:version-slot-assignment']).toBe('notify_and_pause');
    // warns preserved
    expect(pr['guard:substrate-purity']).toBe('warn');
    expect(pr['guard:committed']).toBe('warn');
    expect(pr['guard:session-no-task']).toBe('warn');
    // the NON-migrated workflow keys keep their bare ids
    expect(pr['workflow-phases-required']).toBe('full_stop_and_redo');
    expect(pr['phase-logged-before-commit']).toBe('full_stop_and_redo');
    // every migrated guard id is present (no bare leftover that would hit the default)
    const guards = pack.skills.find((s) => s.name === 'default-discipline/guards');
    for (const r of guards?.rules ?? []) {
      expect(
        pr[r.id],
        `${r.id} has no per_rule policy → would hit full_stop default`,
      ).toBeDefined();
    }
  });

  // GM.3 (wg-52e57e2ed252): the never-amend guard is now structural (command_invokes).
  // Two guarantees: (1) wiring — the compiled guard passes the right args (a typo'd flag_any
  // would surface here); (2) behavior — a command that merely MENTIONS `git commit --amend`
  // (a grep/echo) no longer false-fires through the dispatcher.
  it('never-amend is wired to command_invokes(git commit --amend) and does not false-fire on a mention', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    const guards = pack.skills.find((s) => s.name === 'default-discipline/guards');
    const amendRule = guards?.rules.find((r) => r.id === 'guard:never-amend');
    const step =
      amendRule && 'process' in amendRule
        ? amendRule.process.find((p) => p.call === 'command_invokes')
        : undefined;
    expect(step?.args).toMatchObject({
      program: 'git',
      subcommand: 'commit',
      flag_any: ['--amend'],
    });

    const registry = await buildRegistry({
      backend: {
        init: () => Promise.resolve(),
        embed: () => Promise.resolve(null),
        recall: () => Promise.resolve([]),
        storeLesson: () => Promise.resolve(),
        deleteLesson: () => Promise.resolve({ deleted: false, forced: false }),
      },
    });
    // The amend string inside a grep is NOT an invocation → no guard fires → not blocked.
    const mention = await dispatchEvent(
      { kind: 'tool_call', tool: 'Bash', args: { command: 'grep -n "git commit --amend" log' } },
      [pack],
      registry,
      'dd-amend',
    );
    expect(mention.exitCode).toBe(0);
    expect(mention.stderr).not.toMatch(/BLOCKED/);
  });

  // GMP.1 (wg-320845a92b65): the two last raw matchers migrated to command_invokes + arg_any.
  it('no-force-push-main + versioning-pre1-patch-only block real commands but not a prose mention', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    const guards = pack.skills.find((s) => s.name === 'default-discipline/guards');
    const detectArgs = (id: string) => {
      const rule = guards?.rules.find((r) => r.id === id);
      return rule && 'process' in rule
        ? rule.process.find((p) => p.call === 'command_invokes')?.args
        : undefined;
    };
    expect(detectArgs('guard:no-force-push-main')).toMatchObject({
      program: 'git',
      subcommand: 'push',
      flag_any: ['--force', '-f', '--force-with-lease'],
      arg_any: ['main', 'master'],
    });
    expect(detectArgs('guard:versioning-pre1-patch-only')).toMatchObject({
      program: 'npm',
      subcommand: 'version',
      arg_any: ['minor', 'major'],
    });

    const registry = await buildRegistry({
      backend: {
        init: () => Promise.resolve(),
        embed: () => Promise.resolve(null),
        recall: () => Promise.resolve([]),
        storeLesson: () => Promise.resolve(),
        deleteLesson: () => Promise.resolve({ deleted: false, forced: false }),
      },
    });
    const bash = (command: string, sid: string) =>
      dispatchEvent({ kind: 'tool_call', tool: 'Bash', args: { command } }, [pack], registry, sid);

    // Real commands block.
    expect((await bash('git push --force origin main', 'dd-fp1')).exitCode).toBe(2);
    expect((await bash('npm version major', 'dd-v1')).exitCode).toBe(2);
    // Prose / non-main-target / patch do NOT block.
    expect((await bash('echo "git push --force main"', 'dd-fp2')).exitCode).toBe(0);
    expect((await bash('git push --force origin main:develop', 'dd-fp3')).exitCode).toBe(0);
    expect((await bash('npm version patch', 'dd-v2')).exitCode).toBe(0);
    expect((await bash('grep "npm version major" notes.md', 'dd-v3')).exitCode).toBe(0);
  });
});
