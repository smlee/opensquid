# Candidate-recovery audit contract — 2026-07-20

**WorkGraph:** `wg-0467f177dce7` under `wg-45d72b264ef4`

**Delivery:** one isolated `fix(flow): execute pack-declared audit lenses` commit.

## Scope, preservation, and exclusions

AUDIT.1 repairs fullstack-flow's latent `lenses[2..4]` → single-`prompt` mismatch through one bounded contract and its direct consumers/proofs. It excludes stage/PLAN/phase/process/team/v1/comment work; v1's pre-existing FSM gate and unavailable reaudit remain pinned by tests.

The byte-preserved authoritative candidate rechecked at **40 modified / 7 deleted / 3 untracked**: status SHA-256 `06b20cf12552252151ee3bfa2004e6d4c0fce0f87362dd09ffc80160aa4aaa8c`, diff SHA-256 `0fb276ea583ef5526c1ea5ad49657b00fb9f4c3c5bda1bee6f86d14394428e9e`, backup `/tmp/opensquid-candidate-recovery-20260720T064500Z.{patch,index.patch,status0,untracked.tgz}`.

## Exact isolated path manifest

```text
docs/ARCHITECTURE.md
docs/coverage-allowlist.txt
docs/pack-system-guide.md
docs/reports/candidate-recovery-audit-contract-2026-07-20.md
src/functions/audit_fanout.test.ts
src/functions/audit_fanout.ts
src/functions/audit_policy.ts
src/functions/cached_audit.test.ts
src/functions/cached_audit.ts
src/functions/staged_diff.test.ts
src/functions/staged_diff.ts
src/models/dispatcher.test.ts
src/models/dispatcher.ts
src/models/strategies/subscription_cli.test.ts
src/models/strategies/subscription_cli.ts
src/models/types.ts
src/packs/fullstack_audit_runtime.test.ts
src/packs/fullstack_flow_pack.test.ts
src/runtime/audit_admission.test.ts
src/runtime/audit_admission.ts
src/runtime/audit_schema.ts
src/runtime/coverage/ci.test.ts
src/runtime/hooks/session_liveness.test.ts
src/runtime/hooks/session_liveness.ts
src/runtime/hooks/timeouts.ts
src/runtime/handoff/collect.test.ts
src/runtime/handoff/collect.ts
src/runtime/loop/audit_ctx.test.ts
src/runtime/loop/audit_evidence.test.ts
src/runtime/loop/audit_evidence.ts
src/runtime/loop/audit_telemetry.test.ts
src/runtime/loop/audit_telemetry.ts
src/runtime/loop/fullstack_flow.e2e.test.ts
src/runtime/loop/guard_context.ts
src/runtime/loop/task_audit_cache.test.ts
src/runtime/loop/task_audit_cache.ts
src/setup/cli/codex_hooks.test.ts
src/setup/cli/gate.test.ts
src/setup/cli/gate.ts
src/setup/cli/reaudit.test.ts
src/setup/cli/reaudit.ts
src/setup/wizard/codex-hooks-writer.test.ts
src/setup/wizard/codex-hooks-writer.ts
src/setup/wizard/settings-writer.ts
```

The manifest is compared literally with isolated `git status` before staging/commit; both currently contain the same 44 paths.

## Current AUTHOR and rolling evidence

Authoritative task: `/Users/slee/projects/loop/docs/tasks/T-candidate-recovery-audit-contract.md`, SHA-256 `cb8b00a40558f4860565224400a8ad3f7e6f349639812b07e5cd8105b8ecfa4f`.

Exported AUTHOR cache: `/Users/slee/projects/loop/docs/research/opensquid-candidate-recovery-author-audit-2026-07-22.json`, SHA-256 `0aa6e8a38a688d637045df59688b2777e88ed25202d99580a7e90b004d83e1c3`.

Exact current cache projection (the `subjectHash` equals the task SHA; all four declared lenses are present, exact-first-line passing, complete, and failure-free):

```json
{
  "hash": "4b34b53ed2ba8cb58a6171fcf829fc335e7d9655d9ba3dad7088136d5b8e8db3",
  "subjectHash": "cb8b00a40558f4860565224400a8ad3f7e6f349639812b07e5cd8105b8ecfa4f",
  "complete": true,
  "passVerdict": "GUESS_FREE",
  "failVerdict": "UNRESOLVED",
  "lenses": [
    {
      "id": "contract-coverage",
      "promptHash": "5cef4a6ad58c8cfadc03a9871339c979bacf9d6fece4b61a21912a62a2a8231e",
      "first": "VERDICT: GUESS_FREE"
    },
    {
      "id": "correctness-reuse",
      "promptHash": "944152b6f9294e864c3f37da5f21add0b0c5ada5b6e5d0d099549d35c370c897",
      "first": "VERDICT: GUESS_FREE"
    },
    {
      "id": "simplicity-architecture",
      "promptHash": "46144ebc5567505789be109a348bf4eaeb14a282b34daca595164b05065ed76f",
      "first": "VERDICT: GUESS_FREE"
    },
    {
      "id": "rolling-plan",
      "promptHash": "86e9ba222e5f3a57261f9ade58981451facd54a9ce0425887545aab991f53804",
      "first": "VERDICT: GUESS_FREE"
    }
  ],
  "failures": []
}
```

The child PLAN SHA-256 remains `f1df0a7142990a3699e718de101d073e0a81bafa8b6c6b25b3cc5463bbb45225`; its freshly exported three-lens cache SHA-256 is `fd7e6c0cfddb4aab85594c193f563116da432bb2d34d52632fe31f5d5d01eca1`.

## Primary research and existing-solution recheck

Successful `webFetch` ledger `candidate-recovery-primary-sources-2026-07-22/web-fetch.log` (SHA-256 `da437117281dc5fc93a9cdcf46d409af495f11ba57739af95f8eee5ec392695f`) records these inspectable HTTP-200 sources:

- SQLite transactions: `https://www.sqlite.org/lang_transaction.html`, response SHA-256 `b65dc308fd9e0ce471844c97366a4f5ad3a1f42833a3b19486ad7d6555a8e24e` (DEFERRED versus IMMEDIATE write acquisition).
- libSQL API: `https://raw.githubusercontent.com/tursodatabase/libsql-client-ts/main/packages/libsql-core/src/api.ts`, SHA-256 `f7d53ff372f30a3a519f644ca61a6b1ad7207e06cef38d11b48adfecf94fc889` (transaction close/rollback contract; installed 0.14.0 source was the version-matched authority).
- Zod 3.25.76: `https://raw.githubusercontent.com/colinhacks/zod/v3.25.76/packages/zod/README.md`, SHA-256 `f534842731b0e9599e3927c234fab2090ac2b64ab98fe5035f26c28f1e149536` (`safeParse` discriminant and refinements, cross-checked against installed types).
- Codex Hooks: `https://learn.chatgpt.com/docs/hooks` → `https://developers.openai.com/codex/hooks`, SHA-256 `a94f06ea97ad128d2b656537c88e430338ef3271e65ff54db681450ce33a581b` (Claude-compatible hook decisions/concurrent execution).

The final existing-solution commands and 25-line output are retained at `candidate-recovery-post-search-2026-07-23.log` (SHA-256 `c1ca6dad14fd07a3bac05a273ad1557e1b551c130795ec19590d5bfa0724195b`): `rg` searched exported audit owners, production `writeTaskAuditCache(` calls, historical audit-cache JSON readers, and telemetry readers/writers. Results show one policy materializer/aggregate/derivation, one production task-evidence call site plus its store definition, no session-cache JSON reader, and one telemetry writer/tail-reader path. Reused authorities remain registry/dispatcher/task cache, active YAML, shared diff/policy cap, `loop_owner` transaction pattern, and the existing 620-second host timeout.

## Verification

- Clean-HEAD negative contract failed specifically because real pack `lenses` were rejected.
- Latest focused schema/fan-out/evidence/telemetry/cache/policy/reaudit/handoff/gate/coverage suites are green.
- Full `pnpm prepush` reached lint, typecheck, clean, build, tests, and format green: **551 files passed / 9 skipped; 5,891 tests passed / 24 skipped (5,915 total)**.
- A fresh four-lens CODE audit is required after the final report bytes; only that exact-diff `GUESS_FREE` cache may authorize commit.

## Current AUTHOR task acceptance for diff-bound CODE review

These are verbatim deliverable/files and acceptance excerpts from the current external task; the complete task and canonical AUTHOR evidence are identified by exact SHA-256 above.

<pre data-opensquid-task-deliverable-snapshot>
### Task AUDIT.1 — execute the pack-declared reviewer contract through one bounded owner

**Required skills:** TypeScript/Zod schema composition; concurrent promise scheduling; content-addressed caches; atomic token fencing; model-process output bounds; pack-policy projection; deterministic integration testing.

**Deliverable:** Make the actual fullstack-flow declaration validate and execute through one canonical cached-audit owner. Missing lenses start concurrently; complete lens evidence survives partial failure and fresh StageProcesses; subject-bearing reuse requires exact artifact bytes; unchanged id+prompt-hash evidence for that same subject remains reusable; and only exact all-lens success emits the active configured pass token (the current pack uses `VERDICT: GUESS_FREE`). Gate reaudit projects the complete active-pack declaration and invokes the same owner. Long reviewers publish an explicit fenced activity lease rather than widening handoff freshness guesses.

**Depends on:** The already-delivered fullstack `/scope` task and pack policy. No new WorkGraph dependency edge, model hierarchy, executor loop, queue, daemon, approval system, or pack selector.

**Files affected:**

- `src/runtime/audit_schema.ts`, `src/functions/audit_fanout.ts`, and tests — one shared cardinality/id/verdict/text scalar grammar plus bounded concurrent scheduling/order/partial result seam.
- `src/functions/audit_policy.ts`, `cached_audit.ts`, `staged_diff.ts`, and tests — complete policy materialization, one shared 300,000-byte artifact/prompt boundary, exact runtime/gate identity, canonical telemetry/evidence writes, aggregate bounds, and dispatch.
- `src/setup/cli/reaudit.ts` and `.test.ts` — complete active-pack policy materialization and thin canonical dispatch adapter.
- `src/models/types.ts`, `src/models/dispatcher.ts` and test, `src/models/strategies/subscription_cli.ts` and test — strategy-neutral timeout classification, capture-bounded CLI enforcement, and pre-dispatch rejection of byte-bounded calls to strategies that cannot enforce at capture.
- `src/runtime/audit_admission.ts` and test — two fixed machine-local fail-fast fan-out slots, with expiry reclamation and no queue.
- `src/runtime/hooks/session_liveness.ts`, `src/runtime/hooks/timeouts.ts`, and tests — consume bounded admission projection without changing generic mtime freshness semantics, plus neutral hook timeout policy.
- `src/runtime/loop/audit_evidence.ts`, `.test.ts`, `task_audit_cache.ts`, `.test.ts`, `audit_telemetry.ts`, `guard_context.ts`, `audit_ctx.test.ts`, and `fullstack_flow.e2e.test.ts` — one strict task-durable evidence contract, bounded non-authorizing telemetry, and one read-time derivation seam shared by cache, lifecycle guards, real flow gates, and commit gate; historical session caches cannot shadow it.
- `src/setup/wizard/settings-writer.ts`, `src/setup/wizard/codex-hooks-writer.ts`, and Codex test — project the same neutral 620-second PreToolUse timeout into both host formats.
- `src/packs/fullstack_flow_pack.test.ts`, `src/packs/fullstack_audit_runtime.test.ts`, and `src/runtime/handoff/collect.ts`/`.test.ts` — real pack schema, YAML→registry→model→telemetry/cache runtime, and handoff-tail regressions against the one bounded telemetry source.
- `docs/ARCHITECTURE.md`, `docs/coverage-allowlist.txt`, `docs/pack-system-guide.md`, and the delivery report — requirements, data-only exceptions, and operator contract.
</pre>

<pre data-opensquid-task-acceptance-snapshot>
**Acceptance criteria:**

- [ ] Actual fullstack-flow `cached_audit` arguments satisfy the live primitive schema.
- [ ] Every missing lens starts concurrently and all declared lenses must pass exactly before GUESS_FREE.
- [ ] Failure output retains an attributed PASS/finding row for every lens within the aggregate cap.
- [ ] Partial evidence resumes across fresh StageProcesses without crossing subject identity.
- [ ] One shared schema owns bounds, uniqueness, verdict defaults, and pass/fail separation.
- [ ] One canonical dispatch owns model call, capture-bound admission, bounded metadata-only telemetry, sole task-durable cache for both prompt/fan-out modes, and partial state; one strict evidence module owns persisted parsing and verdict derivation for primitive, guard, and gate.
- [ ] Reaudit and commit gate derive complete prompt/criteria/model/timeout/verdict/subject policy from one pure active-pack projection; the gate requires the exact resulting outer hash and current subject.
- [ ] Global fan-out concurrency is fixed at two invocations/eight reviewers; same-key work is serialized inside 64 fixed transaction slots; saturation/collision fails fast without a queue or unbounded files.
- [ ] In-flight liveness is a bounded projection from the same two canonical admission locks; handoff freshness constants remain unchanged.
- [ ] Behavioral exports have architecture requirements; only data records are allowlisted.
- [ ] The exact selected-path manifest in `docs/reports/candidate-recovery-audit-contract-2026-07-20.md` matches the anchored archive and AUDIT.1 remains one isolated commit; paths assigned to `wg-a0ae6c9c3cb8`, `wg-6a9559c3ef35`, `wg-93ee717cec1e`, `wg-5b963c95c091`, and `wg-3f6afb3477bf` remain equal to `e0cd481` and unstaged in the isolated AUDIT.1 worktree while their candidate bytes remain preserved in the authoritative checkout; the manifest also excludes exactly `src/runtime/commit_gate_evidence.ts`, `src/runtime/handoff/substance.ts`, and `src/runtime/loop/loop_driver.ts` as rejected comment-only churn.
- [ ] Focused tests and full pre-push verification pass, followed by semantic-branch push and green Node 20/22, Windows, and cold-install CI.

**Risk callouts:** A complete cache hit requires exact outer identity and subject. Cross-revision per-lens reuse is allowed only for identical subject hash plus identical id+prompt hash. Never truncate the aggregate before every valid declared lens attribution is emitted; defensive out-of-contract lens counts fail closed, retain bounded rows for feasible supplied entries, and summarize only entries beyond the hard defensive row cap. Never treat activity-publication failure as audit success. Never replace a kernel-owned transaction with a clock guess or compare-and-delete lease. Never parse a second reaudit schema or silently drop unknown pack fields. Do not include the excluded stage-context, PLAN, phase-vocabulary, process-timer, dead-driver, team, v1-policy, or comment-only candidate changes.

**References:** Captured ask; existing kernel lock `src/runtime/ralph/loop_owner.ts:286-320` and cross-process crash/reacquire proof `src/runtime/ralph/loop_owner.test.ts:76-113`; parent task `/Users/slee/projects/loop/docs/tasks/T-fullstack-slash-scope.md:1-40,720-979`; tracked later slices `wg-a0ae6c9c3cb8`, `wg-6a9559c3ef35`, `wg-93ee717cec1e`, `wg-5b963c95c091`, `wg-3f6afb3477bf`; `src/functions/registry.ts:145-220`; `src/runtime/spawn_lifecycle.ts:78-119,344-390`; `src/runtime/loop/task_audit_cache.ts`; `src/runtime/hooks/timeouts.ts`; `packs/builtin/fullstack-flow/skills/content-audit/skill.yaml:56-270`.

**Verification commands:**

```bash
pnpm vitest run \
  src/functions/audit_fanout.test.ts \
  src/functions/cached_audit.test.ts \
  src/setup/cli/reaudit.test.ts \
  src/models/strategies/subscription_cli.test.ts \
  src/runtime/hooks/session_liveness.test.ts \
  src/runtime/audit_admission.test.ts \
  src/packs/fullstack_flow_pack.test.ts \
  src/packs/fullstack_audit_runtime.test.ts \
  src/runtime/coverage/ci.test.ts \
  src/setup/wizard/settings-writer.test.ts \
  src/setup/wizard/codex-hooks-writer.test.ts
pnpm typecheck
pnpm lint
pnpm build
pnpm format:check
pnpm prepush
```

**7-phase workflow:**

1. **pre_research:** Reproduce the clean pack→primitive failure; inventory registry, model, cache, liveness, pack-policy, and hook-timeout authorities; record the negative test and exact parent hashes in `docs/reports/candidate-recovery-audit-contract-2026-07-20.md`.
2. **learn:** Recheck fresh official Zod/libSQL/SQLite primary sources, exact installed-package semantics, and preserved official Codex hook semantics; define exact subject, per-lens, aggregate, output-cap, and lease-fencing invariants in the tests above.
3. **code:** Implement only the files listed here: shared schema/fan-out, canonical cached dispatch, complete reaudit projection, strategy output cap, fenced activity lease, and Codex constant reuse.
4. **test:** Run the focused command, then typecheck/lint/build/format and a clean-environment `pnpm prepush`; record exact counts and failures.
5. **audit:** Run all four pack CODE lenses on the complete diff. Treat any lens failure as unresolved; append each accepted finding and structural fix to the delivery report.
6. **post_research:** Compare the final APIs with fresh official primary sources, exact installed Zod/libSQL source, preserved Codex hook research, parent task, architecture requirements, and actual pack YAML; record why no new dependency or vendor assumption was introduced.
7. **fix:** Resolve every audit finding at its owning seam, rerun focused/full verification and a fresh diff-bound audit, then stage only explicit paths and commit/push the semantic branch with `--no-follow-tags`.
</pre>
