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

import { latestPrefixTag } from '../../runtime/release/release_core.js';
import { nextRcTag } from '../../runtime/release/locked_version.js';
import {
  mergeToStage,
  STAGE_BRANCH,
  realStageIo,
  type StageIo,
} from '../../runtime/release/stage_integration.js';
import { openStagePr, realGhIo, type GhIo } from '../../runtime/release/stage_pr.js';
import { readActiveVersioning, type VersioningConfig } from '../../packs/discovery.js';
import { join } from 'node:path';

const execFileP = promisify(execFile);

/**
 * AGF.6 (T-opensquid-automated-gitflow, wg-b9c7c21cb124) — `runRelease` is SUPERSEDED: it no longer fast-forwards
 * a feature branch STRAIGHT to `main` (the old direct-merge helper) nor GUESSES the bump from commit types (the
 * naive intent-from-commit semver, `release_semver.ts:39-54`). It now routes through the automated git-flow's SINGLE
 * path to main: green precondition → auto-merge the item branch into the persistent `stage` integration branch
 * (suite-gated, `rc`-tagged, AGF.5) → open the batched `stage → main` PR (AGF.6). The ONLY human action is
 * clicking MERGE on that PR; on merge, the release-tag workflow computes the locked-prefix tag (`0.5.N → 0.5.N+1`)
 * and CI publishes. There is ONE path to `main` (the PR gate), no direct merge, no intent-from-commit semver.
 *
 * Injectable seams — production defaults do live git/gh; tests inject stubs so the full sequence runs with no I/O.
 */
export interface ReleaseDeps {
  currentBranch?: (cwd: string) => Promise<string>;
  suiteGreen?: (cwd: string) => Promise<boolean>; // runs the full pre-push suite (scripts/pre-push.sh)
  upToDateWithMain?: (cwd: string) => Promise<boolean>;
  versioning?: (cwd: string) => Promise<VersioningConfig | null>; // the declared locked-prefix config
  prefixTag?: (prefix: string, cwd: string) => Promise<string | null>; // AGF.1's prefix-scoped tag read
  rcTagsFor?: (base: string, cwd: string) => Promise<string[]>; // existing `v<base>-rc.*` tags (rc counter)
  stageIntegrate?: (branch: string, rcTag: string, cwd: string) => Promise<{ integrated: boolean }>; // AGF.5 mergeToStage
  openPr?: (title: string, body: string, cwd: string) => Promise<{ url: string }>; // AGF.6 openStagePr
  stageIo?: StageIo;
  ghIo?: GhIo;
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

/** The declared locked-prefix versioning config from the project's `.opensquid/active.json`, or null when absent. */
async function readVersioning(cwd: string): Promise<VersioningConfig | null> {
  return readActiveVersioning(join(cwd, '.opensquid'));
}

/** The existing `v<base>-rc.*` tags (for the rc counter — single-writer on the one `stage` branch). */
async function rcTagsForBase(base: string, cwd: string): Promise<string[]> {
  const { stdout } = await execFileP('git', ['tag', '--list', `v${base}-rc.*`], { cwd }).catch(
    () => ({ stdout: '' }),
  );
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function fail(msg: string): number {
  process.stderr.write(`release refused: ${msg}\n`);
  return 1;
}

/** AGF.6 — the SUPERSEDED release sequence: green precondition → merge the item branch into the persistent `stage`
 *  integration branch (suite-gated + `rc`-tagged, AGF.5) → open the batched `stage → main` PR (AGF.6). There is
 *  ONE path to `main` (the human MERGE on the PR); NO direct merge to `main`, NO intent-from-commit semver. Returns
 *  the process exit code (0 success, non-zero refusal). */
export async function runRelease(cwd: string, deps: ReleaseDeps = {}): Promise<number> {
  const branch = await (deps.currentBranch ?? gitCurrentBranch)(cwd);
  // 1. PRECONDITION — refuse a red or behind branch BEFORE any mutating git op (the safety floor).
  if (!(await (deps.suiteGreen ?? runFullSuite)(cwd))) return fail('the branch suite is not green');
  if (!(await (deps.upToDateWithMain ?? isUpToDateWithMain)(cwd)))
    return fail('the branch is behind main');
  // 2. VERSIONING — the locked-prefix config is REQUIRED (the automated flow versions by declared strategy, never
  //    by guessing intent from commit types). Absent ⇒ refuse (no naive-semver fallback — that path is superseded).
  const cfg = await (deps.versioning ?? readVersioning)(cwd);
  if (cfg === null)
    return fail(
      'no `versioning` config declared in .opensquid/active.json (locked-prefix strategy required)',
    );
  // 3. rc TAG — the next single-writer rc tag for the `stage` integration (locked-prefix + rc counter).
  const prefixTag = await (deps.prefixTag ?? latestPrefixTag)(cfg.prefix, cwd);
  const base = (await import('../../runtime/release/locked_version.js')).nextLockedTag(
    cfg,
    prefixTag,
  );
  const existingRc = await (deps.rcTagsFor ?? rcTagsForBase)(base, cwd);
  const rcTag = `v${nextRcTag(cfg, prefixTag, existingRc)}`;
  // 4. INTEGRATE — merge the item branch → persistent `stage`, re-run the suite, rc-tag on green (AGF.5).
  const integrate =
    deps.stageIntegrate ??
    ((b: string, tag: string, c: string) => mergeToStage(b, tag, c, deps.stageIo ?? realStageIo));
  const { integrated } = await integrate(branch, rcTag, cwd);
  if (!integrated) {
    return fail(
      `merge of ${branch} into ${STAGE_BRANCH} did not integrate (conflict or red suite on the merge) — ` +
        `the branch re-drives from fresh main`,
    );
  }
  // 5. PR — open/refresh the batched stage → main PR. The human MERGE is the SOLE gate (never auto-merged here).
  const open =
    deps.openPr ??
    ((title: string, body: string, c: string) =>
      openStagePr(title, body, c, deps.ghIo ?? realGhIo));
  const { url } = await open(
    `Release: ${STAGE_BRANCH} → main`,
    `Batched integration of ${branch} and prior stage items. ` +
      `Merging opens the release tag (${base}) + publish.`,
    cwd,
  );
  process.stdout.write(
    `Integrated ${branch} → ${STAGE_BRANCH} (${rcTag}); opened stage → main PR: ${url}. ` +
      `Click MERGE to release ${base}.\n`,
  );
  return 0;
}

export function registerRelease(program: Command): Command {
  return program
    .command('release')
    .description(
      'Release: merge the green branch into the persistent stage branch (suite-gated + rc-tagged), then open the batched stage → main PR (the human MERGE is the sole gate; CI tags + publishes on merge)',
    )
    .action(async () => {
      process.exit(await runRelease(process.cwd()));
    });
}
