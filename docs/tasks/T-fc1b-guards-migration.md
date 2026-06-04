# Track T-FC1B-GUARDS-MIGRATION — default-discipline cluster → manifest `guards:`

**Pre-research:** `docs/research/T-fc1b-guards-migration-pre-research-2026-06-03.md`
(21 shape-perfect rules; first real `guards:` adopter; drift_response silent-fallthrough
risk; 3 test files). Spec origin: `docs/tasks/T-fsm-completion.md:43-60`.

### Task FC.1b: Migrate git/engine-vocab/versioning/honesty-ledger/phase-logging to `guards:` (atomic)

**Required skills:** opensquid pack-format / manifest expert; YAML + regex-preservation expert; drift-response policy expert; Vitest fixtures expert; Audit / code review expert

**Deliverable:** the 5 cluster skills become one synthetic `default-discipline/guards` skill via a `guards:` manifest block (21 entries); the 5 skill folders are deleted; every migrated `per_rule` key in `drift_response.yaml` is re-prefixed `guard:<name>` (the 2 `workflow` keys untouched); the 3 test files updated — ONE commit. Verdict level + message + drift policy are byte-preserved; only audit attribution changes.

**Depends on:** None (the `guards:` mechanism shipped in slice B; loader wires it at `loader.ts:130`).

**Files affected:**

- `packs/builtin/default-discipline/manifest.yaml` (add `guards:` with 21 entries).
- `packs/builtin/default-discipline/skills/{git,engine-vocab,versioning,honesty-ledger,phase-logging}/` (delete).
- `packs/builtin/default-discipline/drift_response.yaml` (re-prefix 21 keys → `guard:<name>`).
- `test/builtin/default-discipline.test.ts` (skill-name list + 3 per-skill assertions).
- `src/packs/command_boundary.skill.test.ts` (git/versioning CASES + no-force-push → guards skill).

**Key code shapes:**

```yaml
# manifest.yaml guards: — command gates (tool_call) keep patterns VERBATIM (single-quoted
# so regex backslashes survive); claim gates (prompt_submit) carry text_pattern_match.
guards:
  - name: never-amend
    on: tool_call
    detect: { call: match_command, args: { pattern: '<verbatim>', target: tool_args.command } }
    when: hit
    level: block
    message: >- ...
  - name: research-start
    on: prompt_submit
    detect:
      call: text_pattern_match
      args: { text_field: priorAssistantText, patterns: ['<verbatim>'] }
    as: claimed
    when: 'len(claimed.matched) > 0'
    level: warn
    message: spawn a research agent or do explicit reading
```

```yaml
# drift_response.yaml — every migrated id gains the guard: prefix; workflow keys stay.
per_rule:
  guard:never-amend: block_tool
  guard:version-slot-assignment: notify_and_pause
  guard:versioning-pre1-patch-only: full_stop_and_redo
  # … 18 more guard:<name> …
  workflow-phases-required: full_stop_and_redo # UNCHANGED (workflow skill, not migrated)
  phase-logged-before-commit: full_stop_and_redo # UNCHANGED
```

```ts
// default-discipline.test.ts — assert on the synthetic guards skill instead of per-skill.
const guards = pack.skills.find((s) => s.name === 'default-discipline/guards');
const ids = guards?.rules.map((r) => r.id);
expect(ids).toContain('guard:never-amend');
expect(ids?.filter((i) => i.startsWith('guard:')).length).toBe(21);
```

**Test fixtures:** `loadPack(default-discipline)`; assert skill names = `['d9-guard', 'default-discipline/guards', 'workflow']`; the guards skill holds all 21 `guard:*` rules; `command_boundary` patterns still match bare + compound, not quoted; each migrated key resolves to its policy (not `full_stop_and_redo` default) — e.g. `guard:substrate-purity` → warn, `guard:committed` → warn.

**Acceptance criteria:**

- [ ] `npm run build` + full suite green; `npm run lint` + tsc clean
- [ ] the 5 skill folders are gone; the guards skill carries all 21 rules
- [ ] each migrated guard resolves to its intended drift policy (no silent default fallthrough)
- [ ] `workflow-phases-required` + `phase-logged-before-commit` still resolve (workflow unchanged)
- [ ] a dispatch/level check confirms blocks stay block, warns stay warn

**Risk callouts:** the SILENT failure mode — any drift_response key left un-prefixed resolves to `full_stop_and_redo` (a hard stop where a warn was intended). Verify EACH of the 21. Preserve regex patterns byte-exact (single-quoted YAML; the FU.14 command-boundary prefixes `(?:^|[;&|\n(])\s*` must survive). Do NOT migrate `workflow`/`d9-guard`. Keep `as: claimed` for the text gates (the `when` references it).

**References:** `src/packs/guards_compiler.ts` (compile target), `src/packs/schemas/manifest.ts:451-478,547` (Guard schema + field), `src/packs/loader.ts:130` (wiring), `packs/builtin/default-discipline/drift_response.yaml`, `docs/tasks/T-fsm-completion.md:43-60`.

**Verification commands:** `npm run build && npx vitest run test/builtin/default-discipline.test.ts src/packs/command_boundary.skill.test.ts && npx vitest run && npx tsc -p tsconfig.build.json --noEmit && npm run lint`.

**7-phase steps:** 1 pre-research: DONE (21-rule catalog + fallthrough risk). 2 learn: lock guard YAML shape + the 2 preserved keys. 3 code: manifest guards block, delete 5 folders, re-prefix drift_response. 4 test: rewrite the 3 files + resolution proof; full suite. 5 audit: every key re-prefixed, patterns byte-exact, levels preserved. 6 post-research: n/a. 7 fix.
