// src/runtime/release/release_core.ts — generic git + npm + package.json mechanics; NO release sequencing/policy.
// Mirrors the shipped git-op idiom in gate.ts:52,89-108 (execFileP('git', […], { cwd })). Stage/release-blind:
// carries no ordering and no release-sequencing vocabulary — the caller (REL.4/REL.6) owns WHEN.
//
// REL.1 (T-opensquid-release-flow, wg-5de59d0b8f2b). Consumed LIVE by REL.4 (release.ts sequence) and REL.6
// (publish.yml's version-difference guard runs `versionAlreadyPublished` from dist/).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const execFileP = promisify(execFile);

/** Fast-forward `main` to `branch` when the merge is a clean FF; else create a merge commit. Returns the
 *  resulting `main` SHA and whether it was a fast-forward. Mechanics only — the caller (REL.4) owns WHEN.
 *  Post-condition: the working tree is left ON `main` (the caller restores the feature branch if it needs to). */
export async function mergeToMain(
  branch: string,
  cwd: string,
): Promise<{ sha: string; ff: boolean }> {
  await execFileP('git', ['checkout', 'main'], { cwd });
  // --ff-only succeeds iff `branch` is ahead of main with no divergence; on failure fall back to a merge commit.
  const ff = await execFileP('git', ['merge', '--ff-only', branch], { cwd })
    .then(() => true)
    .catch(async () => {
      await execFileP('git', ['merge', '--no-edit', branch], { cwd });
      return false;
    });
  const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd });
  return { sha: stdout.trim(), ff };
}

/** Tag `v<version>` on HEAD and push the tag. The DECISION to tag is the caller's (REL.4, gated by green). */
export async function tagAndPushTag(
  version: string,
  cwd: string,
  remote = 'origin',
): Promise<void> {
  const tag = `v${version}`;
  await execFileP('git', ['tag', tag], { cwd });
  await execFileP('git', ['push', remote, tag], { cwd });
}

/** Read `package.json` `version`. */
export async function readPackageVersion(cwd: string): Promise<string> {
  const raw = await readFile(join(cwd, 'package.json'), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

/** Patch ONLY the `version` field, preserving the file's formatting (a targeted string replace, not re-serialize —
 *  a JSON.parse→stringify round-trip would reorder keys and churn whitespace, breaking prettier --check). */
export async function writePackageVersion(cwd: string, version: string): Promise<void> {
  const path = join(cwd, 'package.json');
  const raw = await readFile(path, 'utf8');
  const next = raw.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
  await writeFile(path, next);
}

/** The most recent `v*` tag reachable from HEAD, or null when the repo has no release tag yet. */
export async function lastReleaseTag(cwd: string): Promise<string | null> {
  const { stdout } = await execFileP('git', ['describe', '--tags', '--match', 'v*', '--abbrev=0'], {
    cwd,
  }).catch(() => ({ stdout: '' }));
  return stdout.trim() || null;
}

/** Commit subjects in `<ref>..HEAD` (or all of HEAD when ref is null), newest first. */
export async function commitSubjectsSince(ref: string | null, cwd: string): Promise<string[]> {
  const range = ref === null ? ['HEAD'] : [`${ref}..HEAD`];
  const { stdout } = await execFileP('git', ['log', '--format=%s', ...range], { cwd });
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** The npm-registry probe seam: run `npm view <spec> <field>` and return its stdout (empty on any error).
 *  Injectable so `versionAlreadyPublished`'s tests never touch the network. */
export type NpmView = (spec: string, field: string) => Promise<string>;
const npmView: NpmView = (spec, field) =>
  execFileP('npm', ['view', spec, field])
    .then(({ stdout }) => stdout)
    .catch(() => '');

/** VERSION-DIFFERENCE GUARD: is `version` already published for `pkg`? `npm view <pkg>@<version> version` prints
 *  the version iff it exists on the registry, empty otherwise (a version can be published without being `latest`,
 *  so the exact-version probe is more robust than `npm view <pkg> version` = latest). FAIL-SAFE toward "not
 *  published = false" on any npm error, so a transient blip never spuriously claims a version is published (which
 *  would skip a real publish); npm's own 409-on-duplicate is the backstop for the rarer double-attempt. */
export async function versionAlreadyPublished(
  pkg: string,
  version: string,
  view: NpmView = npmView,
): Promise<boolean> {
  const stdout = await view(`${pkg}@${version}`, 'version');
  return stdout.trim() === version;
}
