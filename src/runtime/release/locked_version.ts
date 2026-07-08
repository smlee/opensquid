// src/runtime/release/locked_version.ts — PURE next-tag computation (no git, no I/O). REPLACES the intent-from-
// commit bumpLevel/nextVersion (release_semver.ts:39-54) in the automated flow: it reads the DECLARED prefix +
// the current prefix patch, it NEVER inspects commit types.
//
// AGF.1 (T-opensquid-automated-gitflow, wg-01d5a9233026). Consumed by AGF.5's `rc` tag (stage_integration.ts)
// and AGF.6's release tag (stage_pr.ts). The `prefix` is HUMAN-held — the loop only bumps the patch; moving off
// the prefix is a manual edit (design §3 step 8: "NEVER assumes feat→minor/BREAKING→major").
import type { VersioningConfig } from '../../packs/discovery.js';

/** Parse the patch integer from a `v<prefix>.<patch>` tag for the declared prefix, or null when it does not match.
 *  Prefix is escaped so its dots are literal (`0.5` matches `v0.5.7`, NOT `v0X5X7`); the leading `v` is optional. */
export function patchOfTag(tag: string, prefix: string): number | null {
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^v?${esc}\\.(\\d+)$`).exec(tag.trim());
  return m ? parseInt(m[1] ?? '', 10) : null;
}

/** The next tag for a locked-prefix / patch-per-release strategy: `<prefix>.<currentPatch + 1>`, where the current
 *  patch is parsed off the highest EXISTING prefix tag; `<prefix>.0` when the prefix has no release tag yet
 *  (latestPrefixTag === null, OR the latest tag is OFF the declared prefix so patchOfTag is null). The prefix is
 *  human-held — the loop only bumps the patch. Returns a BARE version string (`0.5.548`); the caller's tagAndPushTag
 *  prepends the `v` (do NOT double-prefix). */
export function nextLockedTag(cfg: VersioningConfig, latestPrefixTag: string | null): string {
  const patch = latestPrefixTag === null ? null : patchOfTag(latestPrefixTag, cfg.prefix);
  return `${cfg.prefix}.${(patch ?? -1) + 1}`;
}

/** The next `rc` (pre-release) tag for a `stage` integration: `<nextLockedTag>-rc.<n>`, where `n` is `1 +` the
 *  highest existing rc number for that base version (parsed from `existingRcTags`). SINGLE-WRITER on the one
 *  `stage` branch — items integrate serially into `stage`, so the rc counter never races (AGF.5). Pure: the
 *  caller supplies the existing rc-tag list from git. E.g. base `0.5.11` + `['v0.5.11-rc.1']` → `'0.5.11-rc.2'`. */
export function nextRcTag(
  cfg: VersioningConfig,
  latestPrefixTag: string | null,
  existingRcTags: string[],
): string {
  const base = nextLockedTag(cfg, latestPrefixTag);
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^v?${esc}-rc\\.(\\d+)$`);
  const max = existingRcTags.reduce((m, t) => {
    const x = re.exec(t.trim());
    return x ? Math.max(m, parseInt(x[1] ?? '0', 10)) : m;
  }, 0);
  return `${base}-rc.${max + 1}`;
}
