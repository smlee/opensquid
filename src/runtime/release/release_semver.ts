// src/runtime/release/release_semver.ts — PURE conventional-commit → semver bump. No git, no I/O. Net-new
// (versioning.ts:1-18 is pack-lesson 3-way merge, not semver). REL.1 hands us the subjects; we only compute.
//
// REL.2 (T-opensquid-release-flow, wg-d759463d71b3). Consumed LIVE by REL.4's bump path (release.ts) and by
// REL.3's commit-msg gate (`validateConventionalMessage`) — a single shared parser, no duplicate.
export type BumpLevel = 'major' | 'minor' | 'patch' | null;

export interface ParsedCommit {
  type: string;
  scope: string | null;
  breaking: boolean;
  subject: string;
}

// type(scope)!: subject — scope + `!` optional. The conventional-commits header grammar (first line only).
const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?:\s+(?<subject>.+)$/;

/** Parse a conventional-commit MESSAGE (first line is the header; a `BREAKING CHANGE:` footer forces breaking). */
export function parseConventionalCommit(message: string): ParsedCommit | null {
  const [header, ...rest] = message.split('\n');
  const m = HEADER.exec((header ?? '').trim());
  if (m?.groups === undefined) return null;
  const footerBreaking = rest.some((l) => /^BREAKING[ -]CHANGE:/.test(l.trim()));
  return {
    type: m.groups.type ?? '',
    scope: m.groups.scope ?? null,
    breaking: m.groups.bang === '!' || footerBreaking,
    subject: m.groups.subject ?? '',
  };
}

/** The commit gate's predicate (REL.3): a message is valid iff its header parses as a conventional commit. */
export function validateConventionalMessage(message: string): boolean {
  return parseConventionalCommit(message) !== null;
}

/** Fold parsed commits → the highest bump. breaking → major; else feat → minor; else fix → patch; else null.
 *  Precedence + type-classification live HERE only (single source), never scattered into the parser. */
export function bumpLevel(commits: ParsedCommit[]): BumpLevel {
  if (commits.some((c) => c.breaking)) return 'major';
  if (commits.some((c) => c.type === 'feat')) return 'minor';
  if (commits.some((c) => c.type === 'fix')) return 'patch';
  return null; // nothing releasable → REL.4 skips bump + tag
}

/** Apply a bump to a semver `MAJOR.MINOR.PATCH`. null → unchanged (no bump). Pre-1.0 semantics are standard
 *  (a `major` still increments MAJOR here — the ask does not special-case 0.x, so neither do we). */
export function nextVersion(current: string, level: BumpLevel): string {
  if (level === null) return current;
  const [maj = 0, min = 0, pat = 0] = current.split('.').map((n) => parseInt(n, 10));
  if (level === 'major') return `${maj + 1}.0.0`;
  if (level === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}
