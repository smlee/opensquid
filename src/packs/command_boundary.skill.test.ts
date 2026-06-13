/**
 * Command-boundary matching test (T-RJ-FOLLOWUPS FU.14).
 *
 * The default-discipline command gates (workflow commit, git amend/push/force,
 * versioning) were `^`-anchored, so they missed the `cd … && git commit` form
 * the Bash tool actually sends. FU.14 swapped the anchor for a command-boundary
 * prefix `(?:^|[;&|\n(])\s*`. This loads the REAL pack and asserts each pattern
 * matches both the bare and the `cd … &&` compound form, and does NOT match a
 * quoted mention inside an `echo`.
 *
 * GM.3 (wg-52e57e2ed252): the git-INVOCATION gates (workflow commit, never-amend) were
 * migrated off regex `match_command` onto the structural `command_invokes` primitive — so
 * they no longer carry a pattern string and are no longer in CASES here. Their bare/compound/
 * quoted behavior is now proven by `src/functions/shell_parse.test.ts` + the GM.3 cases in
 * `test/builtin/{coding-flow,default-discipline}.test.ts`. The matchers that REMAIN on
 * `match_command` (versioning `npm version`, no-force-push-main) keep their FU.14 regex coverage.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadPack } from './loader.js';

const HERE = fileURLToPath(import.meta.url);
const PACK = resolve(HERE, '../../../packs/builtin/default-discipline');

/** Pull the `match_command` pattern string from a rule's process. */
function patternOf(
  skillName: string,
  ruleId: string,
  pack: Awaited<ReturnType<typeof loadPack>>,
): string {
  const skill = pack.skills.find((s) => s.name === skillName);
  const rule = skill?.rules.find((r) => r.id === ruleId);
  if (rule?.kind !== 'track_check') throw new Error(`${skillName}/${ruleId} not a track_check`);
  const step = rule.process.find((p) => p.call === 'match_command');
  const pat = step?.args?.pattern;
  if (typeof pat !== 'string')
    throw new Error(`no match_command pattern in ${skillName}/${ruleId}`);
  return pat;
}

interface Case {
  skill: string;
  rule: string;
  bare: string; // matches
  compound: string; // matches (cd … && …)
  quoted: string; // does NOT match
}

const CASES: Case[] = [
  // NOTE: workflow/phase-logged-before-commit and guard:never-amend moved to command_invokes
  // (GM.3) — they no longer have a match_command pattern, so they are covered elsewhere (see
  // the file header). Only the matchers still on match_command remain here.
  {
    // FC.1b: git/versioning are now compiled guards under default-discipline/guards.
    skill: 'default-discipline/guards',
    rule: 'guard:versioning-pre1-patch-only',
    bare: 'npm version minor',
    compound: 'cd /repo && npm version minor',
    quoted: 'echo "npm version minor"',
  },
];

describe('FU.14: command gates match compound `cd … && …` commands', () => {
  it('each gate matches bare + compound, and NOT a quoted mention', async () => {
    const pack = await loadPack(PACK);
    for (const c of CASES) {
      const re = new RegExp(patternOf(c.skill, c.rule, pack));
      expect(re.test(c.bare), `${c.rule} should match bare: ${c.bare}`).toBe(true);
      expect(re.test(c.compound), `${c.rule} should match compound: ${c.compound}`).toBe(true);
      expect(re.test(c.quoted), `${c.rule} should NOT match quoted: ${c.quoted}`).toBe(false);
    }
  });

  it('no-force-push-main matches a compound force-push to main', async () => {
    const pack = await loadPack(PACK);
    const re = new RegExp(patternOf('default-discipline/guards', 'guard:no-force-push-main', pack));
    expect(re.test('cd /repo && git push --force origin main')).toBe(true);
    expect(re.test('git push origin feature')).toBe(false);
  });
});
