/**
 * Role: open / tag helpers for the human-gated PR path (gh).
 * Context: base/head from IntegrationPlan (not hardcoded main/stage).
 * Constraints: FAIL-CLOSED on no gh auth; NEVER auto-merges the PR.
 * Output: { url } or GhAuthError; tag string for tagMainRelease.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { VersioningConfig } from '../../packs/discovery.js';
import { nextLockedTag } from './locked_version.js';

const execFileP = promisify(execFile);

/** Thrown when `gh` is not authenticated — the caller surfaces it. */
export class GhAuthError extends Error {}

/** Injectable `gh` + git effects — default binds real `gh`/`git`; tests pass a pure stub. */
export interface GhIo {
  ghAuthOk: (cwd: string) => Promise<boolean>;
  prCreate: (
    a: { base: string; head: string; title: string; body: string },
    cwd: string,
  ) => Promise<string>;
  latestPrefixTag: (prefix: string, cwd: string) => Promise<string | null>;
  tagPush: (tag: string, cwd: string) => Promise<void>;
}

export const realGhIo: GhIo = {
  ghAuthOk: async (cwd) =>
    execFileP('gh', ['auth', 'status'], { cwd })
      .then(() => true)
      .catch(() => false),
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

/**
 * Role: open a PR head→base (config-driven base/head; defaults keep older tests working).
 * Context: title/body/cwd + branches from IntegrationPlan.
 * Constraints: fail-closed auth; never merges. Prefer ensurePr() for idempotent view||create.
 * Output: { url }.
 */
export async function openStagePr(
  title: string,
  body: string,
  cwd: string,
  io: GhIo,
  branches: { base: string; head: string } = { base: 'main', head: 'stage' },
): Promise<{ url: string }> {
  if (!(await io.ghAuthOk(cwd))) {
    throw new GhAuthError(
      `gh is not authenticated — cannot open the ${branches.head}→${branches.base} PR`,
    );
  }
  const url = await io.prCreate(
    { base: branches.base, head: branches.head, title, body },
    cwd,
  );
  return { url };
}

/**
 * Role: on merge to production, push locked-prefix release tag (triggers publish.yml).
 * Context: VersioningConfig + GhIo.
 * Constraints: prefix-scoped; never chases off-prefix tags.
 * Output: pushed tag `v…`.
 */
export async function tagMainRelease(
  cfg: VersioningConfig,
  cwd: string,
  io: GhIo,
): Promise<string> {
  const tag = nextLockedTag(cfg, await io.latestPrefixTag(cfg.prefix, cwd));
  const vTag = `v${tag}`;
  await io.tagPush(vTag, cwd);
  return vTag;
}
