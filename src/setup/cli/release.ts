// src/setup/cli/release.ts — the release SEQUENCE + its green PRECONDITION (POLICY). Mechanics via REL.1/REL.2.
//
// REL.4 (T-opensquid-release-flow, wg-7bf3ae9f592b). Mirrors registerRalph (ralph.ts:234) / cli.ts wiring. The
// command carries the ORDER (precondition → merge → bump → tag), the refuse-red safety floor, and the
// skip-when-nothing-releasable no-op; the git/npm/semver mechanics stay in REL.1 (release_core) / REL.2
// (release_semver). Does NOT release to the registry locally — the tag push is the terminus; CI (REL.6) owns
// the irreversible registry upload. Every git effect is behind an injectable seam so release.test.ts drives the
// full sequence with NO live git/npm.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Command } from 'commander';

import {
  mergeToMain,
  tagAndPushTag,
  readPackageVersion,
  writePackageVersion,
  lastReleaseTag,
  commitSubjectsSince,
} from '../../runtime/release/release_core.js';
import {
  parseConventionalCommit,
  bumpLevel,
  nextVersion,
} from '../../runtime/release/release_semver.js';

const execFileP = promisify(execFile);

/** Injectable seams — production defaults do live git; tests inject stubs so the full sequence runs with no I/O.
 *  DATA-shape (allowlisted for coverage): the wiring lives in `runRelease`, the mechanics in REL.1/REL.2. */
export interface ReleaseDeps {
  currentBranch?: (cwd: string) => Promise<string>;
  suiteGreen?: (cwd: string) => Promise<boolean>; // runs the full pre-push suite (scripts/pre-push.sh)
  upToDateWithMain?: (cwd: string) => Promise<boolean>;
  merge?: (branch: string, cwd: string) => Promise<{ sha: string; ff: boolean }>;
  tagPush?: (version: string, cwd: string) => Promise<void>;
  lastTag?: (cwd: string) => Promise<string | null>;
  subjectsSince?: (ref: string | null, cwd: string) => Promise<string[]>;
  readVersion?: (cwd: string) => Promise<string>;
  writeVersion?: (cwd: string, version: string) => Promise<void>;
  commitBump?: (version: string, cwd: string) => Promise<void>; // stages package.json + a chore(release) commit
}

/** The active branch, from `git rev-parse --abbrev-ref HEAD`. */
async function gitCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return stdout.trim();
}

/** Run the project's full pre-push suite; green === exit 0. The real gate re-runs in CI (REL.6). */
async function runFullSuite(cwd: string): Promise<boolean> {
  return execFileP('bash', ['scripts/pre-push.sh'], { cwd })
    .then(() => true)
    .catch(() => false);
}

/** Is the branch up-to-date with `main` (main is an ancestor of HEAD, so a fast-forward merge is possible)? */
async function isUpToDateWithMain(cwd: string): Promise<boolean> {
  return execFileP('git', ['merge-base', '--is-ancestor', 'main', 'HEAD'], { cwd })
    .then(() => true)
    .catch(() => false);
}

/** Commit the version bump on `main` BEFORE tagging, so the tag points at a commit carrying the bumped version
 *  (else the CI guard reads a stale version). The `chore(release): v<next>` subject satisfies REL.3's gate. */
async function commitVersionBump(version: string, cwd: string): Promise<void> {
  await execFileP('git', ['add', 'package.json'], { cwd });
  await execFileP('git', ['commit', '-m', `chore(release): v${version}`], { cwd });
}

function fail(msg: string): number {
  process.stderr.write(`release refused: ${msg}\n`);
  return 1;
}

/** The full release sequence. Returns the process exit code (0 success / no-op, non-zero refusal). */
export async function runRelease(cwd: string, deps: ReleaseDeps = {}): Promise<number> {
  const branch = await (deps.currentBranch ?? gitCurrentBranch)(cwd);
  // 1. PRECONDITION — refuse a red or behind branch BEFORE any mutating git op (the safety floor).
  if (!(await (deps.suiteGreen ?? runFullSuite)(cwd))) return fail('the branch suite is not green');
  if (!(await (deps.upToDateWithMain ?? isUpToDateWithMain)(cwd)))
    return fail('the branch is behind main');
  // 2. MERGE feat/* → main (FF else merge commit).
  const { sha, ff } = await (deps.merge ?? mergeToMain)(branch, cwd);
  // 3. BUMP — from the conventional commits since the last tag.
  const tag = await (deps.lastTag ?? lastReleaseTag)(cwd);
  const subjects = await (deps.subjectsSince ?? commitSubjectsSince)(tag, cwd);
  const parsed = subjects
    .map(parseConventionalCommit)
    .filter((c): c is NonNullable<typeof c> => c !== null);
  const level = bumpLevel(parsed);
  if (level === null) {
    // Nothing releasable → skip bump AND tag (the ask's explicit no-op).
    process.stdout.write(
      `Merged ${branch} → main (${ff ? 'ff' : 'merge commit'} ${sha.slice(0, 8)}). ` +
        `No releasable commits since ${tag ?? 'the initial commit'} — no bump, no tag.\n`,
    );
    return 0;
  }
  const current = await (deps.readVersion ?? readPackageVersion)(cwd);
  const next = nextVersion(current, level);
  await (deps.writeVersion ?? writePackageVersion)(cwd, next);
  await (deps.commitBump ?? commitVersionBump)(next, cwd); // bump-commit BEFORE the tag (tag carries the version)
  // 4. TAG v<next> on the bumped commit + push the tag. CI (REL.6) publishes if the version is new.
  await (deps.tagPush ?? tagAndPushTag)(next, cwd);
  process.stdout.write(
    `Released v${next} (${level} from ${current}); tag pushed. CI will publish if new.\n`,
  );
  return 0;
}

export function registerRelease(program: Command): Command {
  return program
    .command('release')
    .description(
      'Release: merge the green branch to main, auto-bump+tag the semver from conventional commits, push the tag (CI publishes)',
    )
    .action(async () => {
      process.exit(await runRelease(process.cwd()));
    });
}
