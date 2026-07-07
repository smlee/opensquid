<!-- docs/release.md — REL.7 (T-opensquid-release-flow): the release flow's PROJECT-side contract
     (human-owned prerequisites + the publishability rule). No release POLICY here — the sequence lives in the
     `opensquid release` command (REL.4), the version-difference guard in REL.1/REL.6. -->

# Releasing opensquid

`opensquid release` (or `/release`) merges the green, up-to-date branch to `main`, auto-bumps + tags the semver
from the conventional-commit history, and pushes the tag.
CI (`.github/workflows/publish.yml`) then publishes to npm — ONLY when the tagged version is new.
The human gate is one `/release`; everything after is automatic.
A red or behind branch is refused.

## Human prerequisite (one-time)

Publishing requires an `NPM_TOKEN` repository secret with publish rights to the `opensquid` package
(Settings → Secrets and variables → Actions → `NPM_TOKEN`).
Provisioning it is a HUMAN act — the agent cannot create it.
Without it, the publish step fails loudly (a real misconfiguration surfaces), never silently.

## Publishability

The project is publishable because `package.json` is not `private` and declares `publishConfig.registry` +
`files`.
A project that sets `private: true` (or omits a registry) is non-publishable: `opensquid release` still merges +
tags, but CI's `npm publish` is a no-op (npm refuses a private package).
The registry is read from `publishConfig.registry`; the version-difference guard makes an already-published
version a clean skip (`vX.Y.Z already published — skip`, exit 0), so re-runs / duplicate tags / unchanged-version
tags do nothing.

## The commit-message dependency

Auto-versioning reads conventional commits (`feat` → minor, `fix` → patch, `BREAKING CHANGE` / `!` → major).
The managed `commit-msg` git hook (REL.3) enforces this format on agent commits, so the bump input is always
well-formed going forward; a non-conventional commit simply does not contribute a bump.
