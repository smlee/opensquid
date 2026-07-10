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
import { nextRcTag, nextLockedTag } from '../../runtime/release/locked_version.js';
import {
  mergeToStage,
  STAGE_BRANCH,
  realStageIo,
  type StageIo,
} from '../../runtime/release/stage_integration.js';
import {
  openStagePr,
  ensureProductionPr,
  realGhIo,
  type GhIo,
} from '../../runtime/release/stage_pr.js';
import {
  resolveVersioning,
  type VersioningConfig,
  type ResolvedEnvironments,
} from '../../packs/discovery.js';
import { resolveBuiltinScopeRoot, resolveUserScopeRoot } from '../../runtime/paths.js';
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
  /**
   * GF.3/GF.7 (T-gitflow-integration-fix) — the resolved config-driven environments. PRESENT ⇒ the integration
   * routes through the CONFIG branch names (`staging` is the integration branch, GF.4's fixed context) and the
   * PR is the idempotent config-driven `ensureProductionPr(env)` (base=production, head=staging). ABSENT ⇒ the
   * legacy manual path (STAGE_BRANCH → `openStagePr('stage'→'main')`) — back-compat for `opensquid release`.
   */
  environments?: ResolvedEnvironments;
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

/** The EFFECTIVE locked-prefix versioning config: the project's `.opensquid/active.json` object merged OVER the
 *  active pack's declared default (project-over-pack, AGF.1) — so a project that declares only the `prefix` (or
 *  omits `versioning`) still resolves `strategy`/`bump` from the pack. Null only when neither source declares it. */
async function readVersioning(cwd: string): Promise<VersioningConfig | null> {
  return resolveVersioning(
    join(cwd, '.opensquid'),
    resolveBuiltinScopeRoot(),
    resolveUserScopeRoot(),
  );
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

/** The integration outcome — either integrated (with the PR url + the release base version + the rc tag), or not
 *  (with a machine-readable `skip`/`reason`). SSOT for both the `opensquid release` command (below) and the live
 *  loop's SHIPPED fold (`onShipped` in ralph.ts) — one path to `stage`, one rc-counter, one PR-open. */
export interface IntegrationResult {
  integrated: boolean;
  url?: string;
  base?: string; // the bare release version (e.g. 0.5.548) the human MERGE will tag
  rcTag?: string; // the single-writer rc tag applied to the stage integration
  reason?: 'no-versioning' | 'not-integrated'; // why it did not integrate (skip vs merge-reject)
}

/**
 * AGF.5+AGF.6 SSOT — integrate a pushed `auto/wg-<id>` branch into the persistent `stage` branch (suite-gated +
 * single-writer `rc`-tagged, AGF.5) then open/refresh the batched `stage → main` PR (AGF.6). NO precondition here
 * (the caller owns whether to gate on a green tree): `runRelease` runs the manual command's suite/up-to-date floor
 * BEFORE this; the loop's `onShipped` calls this directly (the item already passed its own suite; the suite reruns
 * ON THE MERGE inside `mergeToStage`). Versions ONLY by the declared locked-prefix config — never intent-from-commit;
 * a project with no `versioning` config resolves `{ integrated:false, reason:'no-versioning' }` (skipped, not failed).
 */
export async function integrateBranchToStage(
  branch: string,
  cwd: string,
  deps: ReleaseDeps = {},
): Promise<IntegrationResult> {
  // VERSIONING — the locked-prefix config (project-over-pack, AGF.1). Absent ⇒ this project is not on the automated
  // git-flow ⇒ skip integration (not an error — a non-automated project ships without a stage/PR).
  const cfg = await (deps.versioning ?? readVersioning)(cwd);
  if (cfg === null) return { integrated: false, reason: 'no-versioning' };
  // rc TAG — the next single-writer rc tag for the `stage` integration (locked-prefix base + rc counter).
  const prefixTag = await (deps.prefixTag ?? latestPrefixTag)(cfg.prefix, cwd);
  const base = nextLockedTag(cfg, prefixTag);
  const existingRc = await (deps.rcTagsFor ?? rcTagsForBase)(base, cwd);
  const rcTag = `v${nextRcTag(cfg, prefixTag, existingRc)}`;
  // INTEGRATE — merge the item branch → the staging branch, re-run the suite, rc-tag on green (AGF.5 + GF.4). The
  // staging branch NAME is CONFIG-DRIVEN (`environments.staging`, GF.1) when present, else the legacy STAGE_BRANCH;
  // GF.4's fixed `mergeToStage` isolates the destructive ops to the staging worktree (never the main tree).
  const stageBranch = deps.environments?.staging ?? STAGE_BRANCH;
  const integrate =
    deps.stageIntegrate ??
    ((b: string, tag: string, c: string) =>
      mergeToStage(b, stageBranch, tag, c, deps.stageIo ?? realStageIo));
  const { integrated } = await integrate(branch, rcTag, cwd);
  if (!integrated) return { integrated: false, base, rcTag, reason: 'not-integrated' };
  // PR — open/refresh the batched integration → production PR. The human MERGE is the SOLE gate (never auto-merged
  // here). GF.7: with a configured `environments`, route through the IDEMPOTENT config-driven `ensureProductionPr`
  // (base=production, head=staging); else the legacy `openStagePr('stage'→'main')` (back-compat).
  const env = deps.environments;
  const open =
    deps.openPr ??
    ((title: string, body: string, c: string) =>
      env !== undefined
        ? ensureProductionPr(env, c, deps.ghIo ?? realGhIo)
        : openStagePr(title, body, c, deps.ghIo ?? realGhIo));
  const { url } = await open(
    `Release: ${stageBranch} → main`,
    `Batched integration of ${branch} and prior stage items. ` +
      `Merging opens the release tag (${base}) + publish.`,
    cwd,
  );
  return { integrated: true, url, base, rcTag };
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
  // 2-5. VERSIONING + rc + INTEGRATE + PR — the SSOT integration core (shared with the loop's onShipped fold).
  const r = await integrateBranchToStage(branch, cwd, deps);
  if (r.reason === 'no-versioning')
    return fail(
      'no `versioning` config declared in .opensquid/active.json (locked-prefix strategy required)',
    );
  if (!r.integrated) {
    return fail(
      `merge of ${branch} into ${STAGE_BRANCH} did not integrate (conflict or red suite on the merge) — ` +
        `the branch re-drives from fresh main`,
    );
  }
  process.stdout.write(
    `Integrated ${branch} → ${STAGE_BRANCH} (${r.rcTag}); opened stage → main PR: ${r.url}. ` +
      `Click MERGE to release ${r.base}.\n`,
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
