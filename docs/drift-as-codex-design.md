# Drift-as-codex — design doc (chunk 1)

Today's drift gates live as hardcoded TypeScript: `drift-patterns.ts`,
`workflow-gate.ts`, `honesty-ledger.ts`, `versioning-gate.ts`. Each
refinement requires editing the npm package source, bumping a version,
publishing.

Different users have different workflows. My 7-phase rule isn't
yours isn't anyone else's. Hardcoding mine into the package means
everyone else has to fork it.

**Drift-as-codex** moves the rule definitions into codex YAML, loaded
at hook startup by a generic engine. Per-user / per-project
customization becomes configuration, not source code, and version
bumps stop being the unit of rule evolution.

This document covers **chunk 1**: schema design + a bundled-default
codex encoding today's rules. No loader yet (chunk 2). No removal of
the hardcoded TypeScript (chunk 3, after the loader is in and the
bundled-default + hardcoded TS produce identical behavior across the
test suite).

## Goals (chunk 1)

1. Add four new sections to `FocusedCodex`: `drifts`, `workflows`,
   `claims`, `policies`. Plus `default_workflow_id`. All optional and
   additive — existing codexes parse unchanged.
2. Ship a bundled-default codex that encodes the locked rules so the
   schema has a real-world example + the loader chunk has a fixture.
3. Validate the bundled-default round-trips through `parseCodex`.

Out of scope for chunk 1: any loader code, any change to the existing
hardcoded hooks, any test of behavioral equivalence.

## Schema decisions

### Drift entries

Port of `DriftPattern` from `src/hooks/drift-patterns.ts:20` with the
same trigger taxonomy: `bash_contains`, `bash_regex`, `text_regex`. The
existing `strip_quotes` flag is preserved (some patterns need to peek
inside `-m "..."` quoted message bodies). Severity is `block` or
`warn`, matching today's TS.

YAML shape:

```yaml
drifts:
  - id: never-amend
    tool: Bash
    trigger:
      kind: bash_regex
      pattern: 'git\s+commit\b[^\n]*\s--amend\b'
    lesson: auto-commit
    severity: block
    message: "BLOCKED: ..."
```

**Decision:** keep `lesson` as a free-text reference (matches today's
TS field). Future chunk may enforce that `lesson` resolves to a real
lesson id in the same codex.

### Workflows

New shape. Each workflow has an `id`, ordered `phases`, and an
`enforce_on` list of terminal tool calls that trigger gate
enforcement. Each phase has a `name`, `required` flag, and optional
`description`. Multiple workflows per codex allowed; active workflow
selected via `default_workflow_id` (codex-level) or future
per-task override.

YAML shape:

```yaml
workflows:
  - id: standard-7-phase
    enforce_on: [git_commit]
    phases:
      - { name: pre_research, required: true }
      - { name: learn, required: true }
      - { name: code, required: true }
      - { name: test, required: true }
      - { name: audit, required: true }
      - { name: post_research, required: true }
      - { name: fix, required: false }
default_workflow_id: standard-7-phase
```

**Decision:** make `fix` optional rather than mandatory. Today's
hardcoded gate only enforces `audit + post_research`; the refactor
enforces all-required-phases-or-explicit-skip-with-reason. Marking
`fix` as `required: false` matches reality (audit often finds nothing
that needs fixing).

**Decision (deferred):** how to express skip-with-reason. Options:
(a) require a `skip` phase entry with a `reason` field; (b) accept
absence of any `fix` entry as implicit skip. Chunk 2 (the loader)
makes this decision based on whether the workflow-gate test suite is
easier to satisfy with (a) or (b).

### Claims

Port of honesty-ledger pattern shape. Each entry has `id`,
`claim_pattern` (regex against assistant text), `evidence` (what
fulfills the claim), `unfulfilled_message`, `severity`.

`evidence` is a discriminated union: `tool_call` (any call to a named
tool), `bash_contains` (any Bash call whose command contains a
substring), `bash_regex` (Bash command matching a regex),
`input_contains` (non-Bash tool whose input field contains a needle),
and `any_of` (recursive — at least one option matches).

YAML shape:

```yaml
claims:
  - id: telegram-sent
    claim_pattern: "(?:Telegram report sent|sent to Telegram)"
    evidence:
      kind: any_of
      options:
        - { kind: tool_call, tool: mcp__plugin_telegram_telegram__reply }
        - { kind: tool_call, tool: mcp__opensquid__chat_send }
    unfulfilled_message: "..."
    severity: warn
```

**Decision:** only the most load-bearing 5 claims ship in the
bundled-default for chunk 1. Full catalog (~12 patterns from the
existing honesty-ledger) ports in a later chunk so the schema can be
validated in isolation first.

### Policies

Higher-level declarative rules the gates compose. v1 ships two
policy kinds: `versioning` and `phase_logged`. Each entry has `id`,
`kind`, and `params` (shape per-kind).

`versioning` policy params:

```yaml
params:
  per_commit_required: true
  allowed_slots: [patch]
  slot_for:
    bug_fix: patch
    feature: patch
    breaking: patch
```

The `allowed_slots: [patch]` declaration is the data form of the
PATCH-ONLY pre-1.0 rule. Future codexes for stable projects may
allow `[patch, minor]` etc. The `slot_for` map is the data form of
"a feature diff must bump minor" — used by a future lint-style check
that detects misclassification.

`phase_logged` policy params:

```yaml
params:
  workflow_id: standard-7-phase
  enforce_on: [git_commit]
```

References a workflow by id. Composes with the workflow's own
`enforce_on` list to determine when the gate fires.

**Decision:** policies and workflows are intentionally separate
sections even though `phase_logged` references a workflow. This lets
a single codex declare multiple policies that consume the same
workflow (e.g. a future "phase_logged" + "phase_timing" policy
sharing one workflow definition).

## Bundled-default location

`src/codex/bundled-default/codex.yaml`

Ships with the npm package via the existing `files` array in
`package.json`. The loader (chunk 2) imports it via Node's
`fs.readFileSync(import.meta.url ...)`-style resolution.

## What the loader will do (chunk 2 preview)

```
loader_input:
  - active project codex (~/.opensquid/projects/<uuid>/codex.yaml or detected)
  - bundled default (src/codex/bundled-default/codex.yaml)
loader_output:
  - drifts: merged catalog (project overrides bundled by id)
  - workflows: merged by id; default_workflow_id resolved
  - claims: merged catalog (project overrides bundled by id)
  - policies: merged by id (project overrides allowed)
```

Each hook (drift-patterns, workflow-gate, honesty-ledger,
versioning-gate) becomes a thin shell that loads its section from the
loader and enforces. The hardcoded TS catalogs become bootstrap
fallbacks during the cutover period and are removed in chunk 3.

## Backward compatibility

- Existing codexes (no `drifts/workflows/claims/policies` sections)
  parse unchanged — all four new fields are optional on
  `FocusedCodex`.
- Hooks continue to use their hardcoded TS until the loader chunk
  lands and behavioral equivalence is proven via test parity.
- The bundled-default codex is co-distributed with the npm package
  (no separate install).

## Versioning

This chunk ships as the next available PATCH bump per the locked
[[feedback_pre1_versioning]] PATCH-ONLY rule. Current opensquid is
`0.7.2`; this chunk ships as `0.7.3`. No minor/major bumps from the
agent — ever.

## Open questions for the user

These are intentionally NOT answered in chunk 1:

1. **Should the loader merge project + bundled by id-override, or by
   project-only-fallback-to-bundled?** Override is more flexible
   (project can disable a bundled drift by id); fallback is simpler.
2. **Skip-with-reason syntax.** See "Workflows" section decision-deferred
   above.
3. **Where do per-codex overrides of `slot_for` policy live?** A
   codex could ship its own versioning policy; should the active
   project codex override the bundled-default, or compose? Chunk 2
   makes this decision.
