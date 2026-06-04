# Pre-research — T-PREPUSH-AND-FLAKE (2026-06-04)

Two fixes, prompted by a red HEAD (`3831fdf`) + a user directive. Both VERIFIED.

## Context

I pushed a docs-only "SHIPPED banner" commit (`3831fdf`) having run ONLY `format:check`,
not the full gate chain, and reported it green WITHOUT checking CI. CI then failed — not
on my change (a docs banner can't break a file-watcher test) but on a pre-existing flaky
timing test. Two corrective fixes:

## PP.1 — a pre-push quality gate (user directive)

**Problem:** nothing forces the full CI chain (lint + typecheck + test + build +
format:check) to run locally before a push. My lapse (push after only `format:check`) was
possible because the discipline was manual.

**Fix:** a `scripts/pre-push.sh` that runs the exact CI chain, fail-fast, with clear
per-step output; a `prepush` package.json script; and a `scripts/install-git-hooks.sh`
that writes `.git/hooks/pre-push` to run it, wired via a `prepare` script so
`pnpm install` installs it. The hook is plain (no opensquid marker) so opensquid's own
`gate install` (GF.2) CHAINS its flow-gate onto it rather than clobbering — the two gates
compose (quality gate + flow gate). `git push --no-verify` still bypasses (an explicit
opt-out, consistent with GF.3).

Chain order mirrors CI + the project rule (`format:check` LAST, after any CHANGELOG
authoring): `lint → typecheck → test → build → format:check`.

## FX.1 — fix the transport_bridge testTimeout flake (greens HEAD)

**Root cause (verified):** `src/runtime/agent_bridge/transport_bridge.test.ts:83-85` sets
`vi.setConfig({ testTimeout: 20_000 })` inside a `beforeAll`. Vitest captures a test's
timeout at `it()` REGISTRATION (collection time); `beforeAll` runs at EXECUTION (after
collection), so the 20s is set too late and never applies — every test keeps the default
5s. The file's own comment at line 256 ("vi.setConfig timeout is captured at it()
registration, not here") confirms the capture semantics. Under CI contention the
chokidar-polling tests occasionally exceed 5s → the CAT.5 test failed at 5011ms (≈ the 5s
default, NOT the 15s `waitFor` ceiling, proving the 20s never took effect).

**Fix:** move `vi.setConfig({ testTimeout: 20_000 })` from the `beforeAll` to MODULE
TOP-LEVEL (before the `describe` blocks), so it runs during collection BEFORE the `it()`s
register and the 20s is captured. (Alternative — per-`it` 3rd-arg timeouts on ~13 tests —
rejected: more churn, same effect; the top-level setConfig is the one-line root-cause fix.)

## Verification

- PP.1: `bash scripts/pre-push.sh` runs green locally; the installed hook blocks a push
  when the chain fails; `--no-verify` bypasses.
- FX.1: the suite stays green; the 20s timeout is now in effect (captured at registration).
- BOTH: run the full chain locally, push, and VERIFY CI via `gh run view <id> --json
conclusion` before reporting green (the discipline I skipped).
