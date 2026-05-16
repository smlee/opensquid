# opensquid platform binary packages

This directory holds the six per-platform npm packages that ship the
`loop-engine` binary alongside `opensquid` via npm
`optionalDependencies`. Pattern: esbuild / biomejs / swc — main package
is pure TS, each `opensquid-engine-<platform>-<arch>` package contains
exactly one binary, npm's `os`/`cpu` fields ensure only the right one
installs on each host.

| Package                       | os     | cpu   |
| ----------------------------- | ------ | ----- |
| opensquid-engine-darwin-x64   | darwin | x64   |
| opensquid-engine-darwin-arm64 | darwin | arm64 |
| opensquid-engine-linux-x64    | linux  | x64   |
| opensquid-engine-linux-arm64  | linux  | arm64 |
| opensquid-engine-win32-x64    | win32  | x64   |
| opensquid-engine-win32-arm64  | win32  | arm64 |

## Release process

1. Tag the engine repo (`MindcraftorAI/loop-engine`) with `v1.x.y`. The
   `release.yml` workflow there cross-builds + uploads 6 binary archives
   to a GitHub Release. **The engine workflow `chmod +x`'s each Unix
   binary before tarring** — preserves the executable bit through the
   tarball.
2. The opensquid release script downloads those archives, extracts each
   binary into the corresponding `npm/engine-<platform>-<arch>/bin/`
   directory, **`chmod 0755` on the extracted Unix binaries** (CRITICAL
   — npm preserves file mode on `npm pack` but loses it if the source
   tree was prepared on Windows or via a tool that strips mode bits),
   bumps every `package.json` `version` in lockstep, and runs
   `npm publish` for each platform package, then the main package.
3. Runtime resolver in `src/engine-binary-resolver.ts` picks the right
   optional dep by `process.platform` + `process.arch` and returns the
   bundled binary path. If the optional dep isn't installed (npm
   `--no-optional`, or wrong-platform install, or local pre-publish
   dev), the resolver falls back to the existing five-step discovery
   chain (env override → config.json → ~/projects search → $PATH).

## Pre-publish state (v0.6c)

The package skeletons + workflow are in place but the `bin/` directories
are empty until the first tagged release populates them. Local
development continues to use the discovery-chain fallback that's been
opensquid's only path since v0.4. No user-visible behavior change until
publish is enabled.

## Audit findings worth noting (resolved in v0.6c-fix cycle)

- **Windows path separator bug** (resolver) — fixed in
  `src/engine-binary-resolver.ts` by switching the path build from
  string-slice to `path.join(path.dirname(pkgJson), "bin", binName)`.
- **Executable bit preservation** — engine `release.yml` now `chmod +x`'s
  before tar, and the release script step above explicitly chmods 0755
  on extracted binaries before `npm publish`. Without this `isExecutable`
  in opensquid `config.ts` would silently reject the bundled binary and
  fall through to the discovery chain on every install.
- **sha256 sidecar path** — engine workflow runs `shasum` from inside
  `dist/` so the embedded path is bare (`<file>.tar.gz`) instead of
  `dist/<file>.tar.gz`. Lets `shasum -c` work from the dist dir without
  manual path rewriting.
