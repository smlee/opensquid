/**
 * Command-gate structural-matching regression guard (T-RJ-FOLLOWUPS FU.14 → GM.3 → GMP.1).
 *
 * History: the default-discipline command gates were once `^`-anchored regex `match_command`
 * patterns (FU.14 swapped the anchor for a command-boundary prefix). GM.3 (wg-52e57e2ed252) then
 * migrated the git-COMMIT-class gates (workflow commit, never-amend) off regex onto the structural
 * `command_invokes` primitive. GMP.1 (wg-320845a92b65) migrated the LAST two — `no-force-push-main`
 * and `versioning-pre1-patch-only` — by adding `arg_any` (refspec-target positional matching).
 *
 * So ALL git/version command gates are now structural (`command_invokes`), not evadable substring
 * regex. Their bare/compound/quoted + positional behavior is proven by `src/functions/shell_parse.test.ts`
 * and the dispatch cases in `test/builtin/{coding-flow,default-discipline}.test.ts`. This file now
 * guards against REGRESSION to the raw `match_command` form: the two GMP.1 gates must stay on
 * `command_invokes` with their structural args.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadPack } from './loader.js';

const HERE = fileURLToPath(import.meta.url);
const PACK = resolve(HERE, '../../../packs/builtin/default-discipline');

/** The args of a rule's `command_invokes` step (or undefined if it isn't on command_invokes). */
function commandInvokesArgs(
  ruleId: string,
  pack: Awaited<ReturnType<typeof loadPack>>,
): Record<string, unknown> | undefined {
  const skill = pack.skills.find((s) => s.name === 'default-discipline/guards');
  const rule = skill?.rules.find((r) => r.id === ruleId);
  if (!rule || !('process' in rule)) return undefined;
  const step = rule.process.find((p) => p.call === 'command_invokes');
  return step?.args;
}

/** True if a rule still carries an (evadable) match_command pattern step. */
function hasMatchCommand(ruleId: string, pack: Awaited<ReturnType<typeof loadPack>>): boolean {
  const skill = pack.skills.find((s) => s.name === 'default-discipline/guards');
  const rule = skill?.rules.find((r) => r.id === ruleId);
  if (!rule || !('process' in rule)) return false;
  return rule.process.some((p) => p.call === 'match_command');
}

describe('GMP.1: the last git/version command gates are structural (command_invokes), not regex', () => {
  it('no-force-push-main is command_invokes(git push, force flags, main/master target)', async () => {
    const pack = await loadPack(PACK);
    expect(commandInvokesArgs('guard:no-force-push-main', pack)).toMatchObject({
      program: 'git',
      subcommand: 'push',
      flag_any: ['--force', '-f', '--force-with-lease'],
      arg_any: ['main', 'master'],
    });
    expect(hasMatchCommand('guard:no-force-push-main', pack)).toBe(false);
  });

  it('versioning-pre1-patch-only is command_invokes(npm version, minor/major)', async () => {
    const pack = await loadPack(PACK);
    expect(commandInvokesArgs('guard:versioning-pre1-patch-only', pack)).toMatchObject({
      program: 'npm',
      subcommand: 'version',
      arg_any: ['minor', 'major'],
    });
    expect(hasMatchCommand('guard:versioning-pre1-patch-only', pack)).toBe(false);
  });
});
