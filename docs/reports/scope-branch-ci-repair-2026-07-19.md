# `fix/scope-handoff-atomic-recovery` CI repair (2026-07-19)

## Captured task and exact failing artifact

User correction: “the previous push for `fix/scope-handoff-atomic-recovery` fails tests … in the CI”; the later “latest fix” reference was the same branch. This repair is tracked by project-local WorkGraph item `wg-bc8a5e818cfe` (“Repair CI failures on fix/scope-handoff-atomic-recovery”).

GitHub Actions run `29669784320` tested head `3e2550972b2da50f94f2eaa2a338545c96ced2e6` through pull-request merge `58758a709815492200ccbc5bf3e41f1eae878b87`. Local Git tree comparison proved both commits have tree `1e37651649557406eb8d329f557830fcbd05b4e6`; this was platform coverage missed locally, not merge-only drift.

The failing jobs were read directly with `gh run view 29669784320 --json jobs` and job logs:

1. Ubuntu/Node 22: `src/runtime/ralph/loop_owner.test.ts` failed when a regular file occupied the Unix endpoint. Linux returned `ECONNREFUSED`; `quarantineRefusedSocket` then threw on `!stat.isSocket()` instead of returning the promised fail-closed `occupied` result.
2. Windows Server 2025/Node 22: the Job Object E2E timed out waiting for `grand.pid`. The test awaited a 500 ms inactivity timeout before checking readiness. Since `runOneShotCli` now owns automatic TERM→KILL cleanup, that timeout correctly reclaimed the Job before a cold PowerShell `Add-Type` broker could start the grandchild.

Cold install passed. Node 20 was cancelled after another matrix job failed; it did not report an independent failure.

## Existing-solution and AUTHOR re-check

This is a bounded regression repair, not a process-control redesign:

- Keep the existing kernel admission lock, probe, stale-socket quarantine, and `AcquireLoopOwnerResult` contract. Only classify a non-socket endpoint as unsafe and return `occupied`; never rename or delete it (`src/runtime/ralph/loop_owner.ts:342-360,446-479`). The existing `ENOENT` branches before and during rename remain the race-safe retry behavior.
- Keep `controlledOwnedProcess`, the named Windows Job Object, and registered `requestProcessControl`. Correct the E2E ordering so the invocation stays live while the cold broker starts, then exercise registered human termination; retain a separate automatic-inactivity test instead of silently deleting that coverage (`test/e2e/windows-job-object.test.ts:58-190`).
- Do not weaken automatic owned-tree cleanup or reintroduce raw OS-signal control. `runOneShotCli` remains the timeout owner and `controlledOwnedProcess` remains the Windows signal-tree adapter (`src/runtime/spawn_lifecycle.ts:335-350`; `src/runtime/processes/process_control.ts:1202-1240`).

AUTHOR was re-audited against the original task, not assumed from its old verdict. The configured task source says process supervision is excluded (`../docs/tasks/T-fullstack-slash-scope.md:736`) and `/scope` must reuse existing transport rather than add another supervisor (`../docs/tasks/T-fullstack-slash-scope.md:31-33`). This repair honors both: it changes no `/scope` command, lifecycle, host adapter, coordinator, transport, process-control implementation, branch, release, or WorkGraph semantics. The loop-owner change makes its already-declared fail-closed result true on Linux; the Windows changes are E2E ordering/assertion corrections against already-shipped `runOneShotCli` and Job Object behavior. The full suite rechecks the original `/scope` path alongside these corrections.

## Primary documentation consultation

Node’s official `fs` API documentation was retrieved on 2026-07-19 from `https://nodejs.org/api/fs.html` (1,092,869 bytes; SHA-256 `84c19e9281eda612374765d90fe62ee085bde917fa574c782333856f1de15b05`). Its `fsPromises.lstat()` section states that the promise fulfills with `fs.Stats` for the symbolic-link path itself, which supports rejecting symlinks via `lstat(...).isSocket()`. Its `fsPromises.rename()` section confirms the asynchronous rename boundary; disappearance is handled as `ENOENT` and retried without deleting another path.

Official Microsoft Win32 documentation was also retrieved on 2026-07-19:

- `https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects` (61,469 bytes; SHA-256 `d4ffe6040f360e0a038a92bb049cba79074a6b167063e9d1f46f8db7f788af10`) defines a Job Object as a group managed as a unit and states that Job operations affect all associated processes.
- `https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject` (57,775 bytes; SHA-256 `748f0b7ab1bdbea76041c87b035083c08083b3401a7cf56685f48eb2a5dd0f00`) documents associating a process with an existing Job.
- `https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject` (52,987 bytes; SHA-256 `d43088cf7156da54fcef8245b2a757b8cdfce30f4556548f7e8ed105eabb611f`) states that `TerminateJobObject` terminates all processes associated with the Job.

These primary contracts match the repository implementation: `windows_job_broker.ps1` assigns the suspended target before resuming it, and `windows_job_control.ps1` terminates the exact named Job.

## Tests

- Existing stale Unix-socket acquisition remains covered.
- Regular-file, directory, and symlink endpoint occupancy each assert `occupied` and preservation of the existing object/target (`src/runtime/ralph/loop_owner.test.ts:229-271`).
- Human Windows termination now asserts a real rejected invocation outcome and specifically rejects accidental inactivity timeout.
- Automatic Windows inactivity retains explicit coverage and must reclaim the already-ready grandchild Job; no blanket `.catch(() => undefined)` remains.
- Focused macOS run: 20 passed, 2 Windows-only skipped.
- Full macOS pre-push gate: 5,833 passed, 23 skipped; lint, typecheck, build, and format green.
- Pre-commit CODE acceptance is complete. GitHub’s Ubuntu Node 20/22 and Windows jobs are the post-push delivery gate because the Windows runner is not locally available; the WorkGraph repair item remains open until that outward run is green. This is a delivery check, not an unresolved design or code fork.
