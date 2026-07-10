// src/runtime/release/stage_pr.ts — open the batched `stage → main` PR (`gh`) + the release-tag-on-merge mechanic.
// FAIL-CLOSED on no `gh` auth (the auth gap is SURFACED, never a silently-dropped batch); NEVER auto-merges the PR
// — the human MERGE click is the SOLE gate (design §5 OUT "never automate step 5"). The release tag pushed on
// merge triggers the EXISTING publish.yml (`on: push: tags: ['v*']`), whose clean-env re-run + versionAlreadyPublished
// guard are KEPT verbatim.
//
// AGF.6 (T-opensquid-automated-gitflow, wg-b9c7c21cb124). Supersedes runRelease's direct merge to `main`
// (release.ts:78-111) + the naive intent-from-commit semver (release_semver.ts:39-54).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { VersioningConfig, ResolvedEnvironments } from '../../packs/discovery.js';
import { STAGE_BRANCH } from './stage_integration.js';
import { nextLockedTag } from './locked_version.js';

const execFileP = promisify(execFile);

/** Thrown when `gh` is not authenticated — the caller surfaces it, the batch is NOT silently dropped. */
export class GhAuthError extends Error {}

/** Injectable `gh` + git effects — default binds real `gh`/`git`; tests pass a pure stub (no network). */
export interface GhIo {
  ghAuthOk: (cwd: string) => Promise<boolean>; // `gh auth status` exit 0
  prView: (head: string, base: string, cwd: string) => Promise<string | null>; // GF.7 — `gh pr view <head> --json url` → url | null (idempotency probe)
  prCreate: (
    a: { base: string; head: string; title: string; body: string },
    cwd: string,
  ) => Promise<string>; // → PR url
  latestPrefixTag: (prefix: string, cwd: string) => Promise<string | null>; // AGF.1's release_core mechanic
  tagPush: (tag: string, cwd: string) => Promise<void>;
}

/** The default real GhIo — the concrete `gh`/git mechanics behind the seam. */
export const realGhIo: GhIo = {
  ghAuthOk: async (cwd) =>
    execFileP('gh', ['auth', 'status'], { cwd })
      .then(() => true)
      .catch(() => false),
  prView: async (head, _base, cwd) => {
    // `gh pr view <head> --json url` → the OPEN PR's url, or null when none exists (a non-zero exit / no PR).
    const { stdout } = await execFileP('gh', ['pr', 'view', head, '--json', 'url', '-q', '.url'], {
      cwd,
    }).catch(() => ({ stdout: '' }));
    const url = stdout.trim();
    return url.length > 0 ? url : null;
  },
  prCreate: async (a, cwd) => {
    const { stdout } = await execFileP(
      'gh',
      ['pr', 'create', '--base', a.base, '--head', a.head, '--title', a.title, '--body', a.body],
      { cwd },
    );
    return stdout.trim();
  },
  latestPrefixTag: async (prefix, cwd) => {
    const { latestPrefixTag } = await import('./release_core.js');
    return latestPrefixTag(prefix, cwd);
  },
  tagPush: async (tag, cwd) => {
    await execFileP('git', ['tag', tag], { cwd });
    await execFileP('git', ['push', 'origin', tag], { cwd });
  },
};

/** Open the batched `stage → main` PR. FAIL-CLOSED: no `gh` auth → `GhAuthError` (no PR, the auth gap surfaced —
 *  mirrors publish.yml's NPM_TOKEN prerequisite). NEVER merges — step 5 (the human MERGE) is deliberately NOT
 *  automated — there is NO PR-merge invocation anywhere in this path. */
export async function openStagePr(
  title: string,
  body: string,
  cwd: string,
  io: GhIo,
): Promise<{ url: string }> {
  if (!(await io.ghAuthOk(cwd)))
    throw new GhAuthError('gh is not authenticated — cannot open the stage→main PR');
  const url = await io.prCreate({ base: 'main', head: STAGE_BRANCH, title, body }, cwd);
  return { url };
}

/** GF.7 (scope-7) — ensure ONE PR (the integration branch → production) is open, IDEMPOTENTLY. head =
 *  `staging ?? local` (config-driven, GF.1), base = `production` — NO hardcoded `main`/`stage`. `prView` first:
 *  an existing PR is a no-op (its url returned; GitHub auto-tracks later pushes); else `prCreate`. FAIL-VISIBLE:
 *  no `gh` auth → `GhAuthError` (surfaced, never swallowed). NEVER merges — the human MERGE is the SOLE gate
 *  (this path NEVER shells the merge — the human clicks it in the GitHub UI; that click triggers the CI publish, the one irreversible act). */
export async function ensureProductionPr(
  env: ResolvedEnvironments,
  cwd: string,
  io: GhIo = realGhIo,
): Promise<{ url: string }> {
  if (!(await io.ghAuthOk(cwd)))
    throw new GhAuthError('gh is not authenticated — cannot open the → production PR');
  const head = env.staging ?? env.local; // staging if set, else the loop branch — config-driven
  const base = env.production;
  const existing = await io.prView(head, base, cwd);
  if (existing !== null) return { url: existing }; // idempotent — the PR is already open, tracks new pushes
  const url = await io.prCreate(
    {
      base,
      head,
      title: `Release: ${head} → ${base}`,
      body: `Automated integration PR (${head} → ${base}). Merging opens the release tag + publish.`,
    },
    cwd,
  );
  return { url };
}

/** On merge to `main`: compute the locked release tag (AGF.1, prefix-scoped — never chases an off-prefix tag) +
 *  push it, triggering publish.yml. Invoked by the release-tag workflow. Idempotent-safe: an already-published
 *  version is a clean no-op at publish.yml's `versionAlreadyPublished` guard. Returns the pushed tag (`v<prefix>.N`). */
export async function tagMainRelease(
  cfg: VersioningConfig,
  cwd: string,
  io: GhIo,
): Promise<string> {
  const tag = nextLockedTag(cfg, await io.latestPrefixTag(cfg.prefix, cwd)); // e.g. 0.5.548 (bare)
  const vTag = `v${tag}`;
  await io.tagPush(vTag, cwd); // triggers publish.yml (on: push: tags: ['v*'])
  return vTag;
}
