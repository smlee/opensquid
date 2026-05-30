---
name: task-spec-author
description: 'Author task specs that ship at high compression. Use when the user wants to add a new task to docs/tasks/, extend an existing track, or create a new track spec file. Applies the standardized 11-field template (persona-specific skills + 7-phase workflow + concrete code shapes + acceptance criteria) that empirically ships 10–15× faster than minimal specs by eliminating implementation drift.'
---

# Task Spec Author

You're authoring a task spec destined for `docs/tasks/<track>.md` in the loop planning repo (or equivalent task-spec location). The spec is a contract for future implementation — a subagent reading any task block should have zero guesswork about what to do.

**Why this discipline matters:** detailed specs have empirically compressed 14–15 working days of typical implementation into ~10.6 wall-clock hours (~13× compression on the opensquid 8-phase refactor, 2026-05-19 → 2026-05-20). The mechanism: subagents given persona-specific skills + concrete 7-phase steps + real code shapes don't burn cycles exploring or asking — they execute. The cost of detail upfront (~30–60 min per task) is paid back many times over in avoided rework cycles.

## When to use this skill

Trigger phrases include:

- "add a task for X"
- "spec out the work for Y"
- "create a new track for Z"
- "author task specs"
- "extend docs/tasks/ with..."
- "write up the implementation plan for..."

Do NOT use this skill for:

- Memory entries (use the auto-memory system in CLAUDE.md)
- Slash commands or runtime skills (those have separate formats)
- One-off implementation notes (this is for tracked, multi-phase work)
- ADRs / design docs (those go in `docs/`, not `docs/tasks/`)

## The 11-field task template (fixed order)

Every task block follows this template in this order:

````markdown
### Task <ID>: <name>

**Required skills:** [2–5 from skills-catalog.md]
**Deliverable:** [one sentence]
**Depends on:** [task IDs or markdown links to other phase files]

**Files affected:**

- `path/to/file.ts` (new) — role
- `other/file.ts` (modify) — what changes

**Key code shapes:**

```<lang>
// real TS / YAML / SQL — never pseudocode
```
````

**Test fixtures:**

- Input X → expected Y
- Input A → expected B
- Edge case: empty input → expected behavior

**Acceptance criteria:**

- [ ] specific condition 1
- [ ] specific condition 2

**Risk callouts:**

- gotcha 1
- gotcha 2

**References:**

- URL or path

**Verification commands:**

```bash
pnpm typecheck
pnpm vitest run path/to/test
```

**7-phase steps:**

1. **pre-research:** [specific files, URLs, questions]
2. **learn:** [specific output deliverable]
3. **code:** [specific files + module structure]
4. **test:** [specific test names + cases]
5. **audit:** [specific quality gates]
6. **post-research:** [specific external sources]
7. **fix:** [what audit + post-research feedback gets applied]

```

The order is load-bearing — readers scan top-down. Skills line first lets a subagent know which persona to embody before reading further.

## Field-by-field discipline

### Required skills (2–5 entries)

**Granularity rule:** library/package or research-domain level. NOT generic categories.

Wrong (generic):
```

**Required skills:** TypeScript expert; Testing expert

```

Right (persona-specific):
```

**Required skills:** Zod schema design expert (zod npm package, TS); TypeScript discriminated union design expert; Audit / code review expert; Architectural design expert

```

Mix two types:
- **Library/package** experts: `chokidar npm package expert`, `lru-cache npm package expert`, `Zod schema design expert (zod npm package, TS)`, `commander v12 CLI argument parsing expert`
- **Research-domain** experts: `Audit / code review expert`, `Architectural design expert`, `Security capability model expert`, `Performance / overhead analysis expert`, `Two-stage validation gate design expert`

The persona IS the embodied expertise. Mix both kinds so the subagent knows the right library AND the right thinking discipline.

If a skill isn't in `skills-catalog.md` yet, **add it** (see "Skills catalog extension" below).

### Deliverable (one sentence)

The shipped artifact. Concrete and observable.

Wrong: "Improve the runtime"
Right: "`src/runtime/types.ts` Event union has 8 variants (4 existing + 4 new); skill schema accepts `triggers:` block; evaluator filters rules by event kind; all Phase 1–7 tests still pass."

### Depends on

Task IDs OR markdown links to other phase files. Every dependency must be resolvable.

Wrong: "Depends on Phase 1"
Right: "Depends on [AUTO.1](automation.md#task-auto1-widen-event-union-...), [phase-7-wedge-gate.md](phase-7-wedge-gate.md) (capture.ts + promote.ts)"

### Files affected

Manifest of every file the task creates or modifies, with role.

```

- `src/runtime/types.ts` (modify) — extend Event union with 4 new variants
- `src/runtime/types.test.ts` (new) — round-trip tests per variant
- `package.json` (modify) — add `chokidar: ^3.6.0` dependency

````

Catches scope creep. If you're touching 10 files, the task is too big — split it.

### Key code shapes

**Real code, not pseudocode.** The shapes are paste-and-adapt scaffolding for the implementing subagent. Show:
- Type signatures
- Function shapes (impl body can be `/* ... */`)
- YAML schemas
- SQL DDL

Wrong (pseudocode):
```typescript
// somewhere, somehow, parse the cron expression and validate it
function parseCron(input: string): CronResult { /* magic */ }
````

Right (real shape):

```typescript
import { CronExpressionParser } from 'cron-parser';

export interface CronResult {
  cron: string;
  next: Date;
  timezone: string;
}

export function parseCron(input: string, tz: string = 'UTC'): CronResult {
  const expr = CronExpressionParser.parse(input, { tz });
  return { cron: input, next: expr.next().toDate(), timezone: tz };
}
```

If the spec's signatures differ from the design doc, **the design doc wins** — file an issue rather than diverging silently.

### Test fixtures

Concrete input → expected output. Treat as the floor: add to them; don't shrink them.

Format:

```
- Input: X → expected: Y
- Input: edge case A → expected: B
- Input: malformed payload → expected: ZodError citing the variant
```

Include happy path + at least one error path + at least one edge case.

### Acceptance criteria

Checklist that the audit phase verifies explicitly. Specific, not vague.

Wrong: "Code works correctly"
Right:

```
- [ ] Event union exports 8 variants (4 old + 4 new)
- [ ] Each new variant has Zod schema + TS type via `z.infer`
- [ ] Skill schema accepts `triggers:` block; default fills `[{kind: 'tool_call'}]`
- [ ] `pnpm typecheck` exits zero
- [ ] `pnpm vitest run src/runtime/types.test.ts` passes ≥ 5 new tests
```

### Risk callouts (optional but valuable for foundation/security tasks)

Specific gotchas that have bitten or will bite. Each should be actionable.

Wrong: "Be careful with concurrency"
Right: "Discriminated unions in Zod require `z.literal(<value>)` on the discriminator — `z.string()` breaks narrowing silently."

For foundation tasks (event unions, type definitions), security tasks (capability gates, auth), and performance-critical tasks (checkpointing, caching), always include 3–5 risk callouts. Cheap CLI wrappers and doc tasks can skip this field.

### References

URLs, file paths, memory entries. Anything the implementer should read.

```
- `src/runtime/types.ts` lines 52–84 — current Event union
- `docs/opensquid-real-design.md` §"Event union"
- Zod discriminated-union docs: https://zod.dev/?id=discriminated-unions
- Memory: `feedback_user_authored_lessons_immune`
```

### Verification commands

Bash commands the implementer runs to verify the task is done. Treat exit codes as gates; never proceed to commit on red.

```bash
cd /Users/slee/projects/opensquid
pnpm typecheck
pnpm vitest run src/runtime/types.test.ts
pnpm build
```

CI invokes the same set — that's the contract.

### 7-phase steps

The non-negotiable structural lock. Every task lists all seven phases with concrete actions per phase, even if a phase is trivial.

The seven phases:

1. **pre-research** — read existing code, study docs, lock the approach BEFORE writing
2. **learn** — synthesize what to build (the "spec output" of pre-research)
3. **code** — write the implementation
4. **test** — write + run tests
5. **audit** — quality gates (file size, idioms, no fail-open, exhaustiveness)
6. **post-research** — compare against external sources, competitor patterns
7. **fix** — apply audit + post-research feedback

Each phase entry is a SPECIFIC action, not a generic verb.

Wrong (vague):

```
1. **pre-research:** Read the relevant code.
2. **learn:** Figure out what to build.
3. **code:** Implement it.
```

Right (specific):

```
1. **pre-research:** Re-read `src/runtime/types.ts` lines 52–84 (current Event union). Re-read `src/runtime/evaluator.ts` to enumerate every `switch (event.kind)` site. Read Zod discriminated-union docs.
2. **learn:** Lock the new event variants' payload fields. Lock `triggers:` block default = `[{kind: 'tool_call'}]`.
3. **code:** Add 4 z.object schemas + TS types. Extend Event union. Add `triggers:` block to skill schema. Update evaluator filter. Add TS exhaustiveness checks at every switch.
```

The audit phase is the one most often skipped under momentum pressure. **Never skip it** — retroactive audits have empirically surfaced 13+ critical findings on prior tracks. Specs that have a clear `audit:` action save downstream cycles.

## Skills catalog extension

If a task needs a persona-skill not in `skills-catalog.md`:

1. Add an entry to the catalog in the appropriate category (Language/Architectural/Schema/Testing/MCP/Storage/Channels/Secrets/CLI/Cross-platform/Domain-specific/Automation/Durable/Security/Observability/Cost/Wedge/Performance)
2. Format: `- **<Persona name>** — <one-line scope: library name, key concepts, gotchas>`
3. Match the granularity of existing entries (library + concepts, not just library name)

Example new entry:

```markdown
- **chokidar npm package expert** — `chokidar` file system watcher, `awaitWriteFinish`, polling fallback, FSEvents quirks, ignored globs
```

Adding to the catalog is part of the spec authoring task — don't ship task specs that reference catalog entries that don't exist.

## File location + naming

Specs live in:

```
/Users/slee/projects/loop/.claude/worktrees/<branch>/docs/tasks/<track>.md
```

Track file naming:

- Phase files: `phase-<N>-<slug>.md` (e.g. `phase-1-runtime.md`)
- Cross-cutting tracks: `cross-<area>.md` or just `<area>.md` (e.g. `cross-llm-call-modes.md`, `automation.md`, `scheduling.md`)
- Specialty: `personal-pack.md`, `release.md`

Task IDs:

- Phase tasks: `<phase>.<index>` (e.g. `1.7`, `2.4`)
- Cross-cutting: `<ABBREV>.<index>` (e.g. `AUTO.1`, `SCHED.3`, `UI.1`, `CLI.5`)
- Keep IDs stable once shipped — don't renumber, even when inserting tasks

## Track file structure (top of file)

Every track file opens with a header block before any task entries:

```markdown
# <Track name>

**Scope:** Per `docs/<design-doc>.md` §"<section>". One-paragraph description of what this track delivers + why it exists.
**Relationship to phases:** Which phases/tracks this depends on. Which tasks are keystones.
**Tasks:** N (<ID-low> through <ID-high>)
**Specialist skills referenced:** see [`skills-catalog.md`](skills-catalog.md). New entries added in this track: <list any new persona-skills added>.
**Cross-references:** [other-track.md](other-track.md) (why); [phase-X.md](phase-X.md) (why).

---
```

Then the task entries follow, separated by `---` between tasks.

## Worked example (compact)

A task in the canonical form:

````markdown
### Task EXAMPLE.1: Add request ID propagation to MCP server

**Required skills:** MCP SDK expert (@modelcontextprotocol/sdk npm package, TS); TypeScript ESM module design expert; Architectural design expert
**Deliverable:** Every inbound MCP request generates or propagates a `requestId`; downstream logs + tool responses include it; round-trip test verifies propagation.
**Depends on:** [Task 1.8](phase-1-runtime.md#task-18-mcp-server-entry--5-read-only-tools)

**Files affected:**

- `src/mcp/server.ts` (modify) — add request-id middleware
- `src/mcp/request_id.ts` (new) — generation + extraction helpers
- `src/mcp/request_id.test.ts` (new)

**Key code shapes:**

```typescript
// src/mcp/request_id.ts
import { randomUUID } from 'node:crypto';

export function ensureRequestId(headers: Record<string, unknown>): string {
  const existing = headers['x-request-id'];
  if (typeof existing === 'string' && existing.length > 0) return existing;
  return randomUUID();
}
```
````

**Test fixtures:**

- Input: headers without `x-request-id` → returns generated UUID v4
- Input: headers with `x-request-id: "abc-123"` → returns `"abc-123"` unchanged
- Input: headers with empty string `x-request-id` → returns generated UUID

**Acceptance criteria:**

- [ ] `ensureRequestId` returns existing id if present, else generates
- [ ] MCP server wraps every request with the id in context
- [ ] Tool responses include `requestId` in metadata
- [ ] `pnpm vitest run src/mcp/request_id.test.ts` passes ≥ 3 tests

**Risk callouts:**

- MCP SDK 1.29.0 middleware hook signature differs from 1.28 — verify against current version
- Empty string id should fail the "existing" check, not propagate

**References:**

- MCP SDK middleware docs: https://github.com/modelcontextprotocol/typescript-sdk

**Verification commands:**

```bash
pnpm typecheck
pnpm vitest run src/mcp/request_id.test.ts
```

**7-phase steps:**

1. **pre-research:** Read `src/mcp/server.ts` to find the middleware insertion point. Read MCP SDK 1.29.0 middleware docs to confirm signature.
2. **learn:** Lock generation strategy (UUID v4 via node:crypto, no external dep).
3. **code:** Implement `ensureRequestId` + middleware wrapper. Inject into server.ts.
4. **test:** Three input fixtures. Run vitest.
5. **audit:** Empty-string case handled. No PII in request ID. File size ≤ 80 LOC.
6. **post-research:** Compare against gRPC's `x-correlation-id` conventions.
7. **fix:** Tighten naming if conventions differ.

```

Note: this is a deliberately small task to show the format compactly. Real foundation/security/performance tasks should be denser in code shapes + risk callouts + 7-phase specificity.

## Verification checklist before shipping a spec

Before committing a new task or track file:

- [ ] Every task has all 11 fields (risk callouts optional for thin tasks)
- [ ] Every `Required skills` entry resolves in `skills-catalog.md` (or has been added)
- [ ] Every `Depends on` reference is a valid task ID or working markdown link
- [ ] Every `Files affected` row has new/modify + role
- [ ] Every `Key code shapes` block is real code (not pseudocode)
- [ ] Every 7-phase step is specific (names files, URLs, locks decisions)
- [ ] Track file has the header block (Scope + Relationship + Tasks count + Skills reference + Cross-references)
- [ ] README.md task-index updated with the new track + total task count
- [ ] No engine-vocabulary leak in tasks that touch substrate-side code

## Common pitfalls

- **Generic skill assignments.** "TypeScript expert" doesn't tell a subagent which persona to embody. Specify library + concepts.
- **Pseudocode in key code shapes.** The shapes are paste-and-adapt — pseudocode forces the subagent to redesign rather than implement.
- **Skipping risk callouts on foundation tasks.** Saves 5 minutes now, costs 5 hours of rework later.
- **Vague 7-phase steps.** "Read the docs" is worthless. "Read commander v12 docs at https://... — focus on subcommand action chaining" is actionable.
- **Forgetting to extend skills-catalog.** Catalog entries are a dependency; task specs that reference missing entries fail to brief subagents.
- **Letting task count drift.** README.md task index is the source of truth — every new task increments the total. Update both.
- **Mixing scopes in one task.** If you find yourself writing "and also" in the deliverable, split into two tasks.
- **Skipping the audit phase action.** The phase is non-negotiable; specify what audit gate applies (file size, no fail-open, exhaustiveness, license check, engine-vocabulary scan).

## What makes a track keystone vs follower

Foundation tasks (event unions, type definitions, schema migrations, security gates, perf-critical paths) carry the highest detail bar. Their downstream tasks depend on them; a bad design ripples.

Follower tasks (thin CLI wrappers, doc regeneration, simple migrations) carry standard detail. Don't over-engineer them — but never skip the 11 fields entirely.

The marginal value of detail is highest for keystone tasks and lowest for follower tasks. Spend authoring time accordingly.

## Cross-cutting reminders (apply to every task)

These come from the loop project's `docs/tasks/README.md` "Cross-cutting notes" section and should not be duplicated in each task block — but the spec author should verify the task respects them:

- TaskCreate before logging the first phase
- Log all seven phases (never skip audit)
- File-size discipline (no monoliths)
- Engine-vocabulary discipline (substrate types only in substrate code)
- License discipline (no AGPL/GPL/SSPL)
- Model-neutral architecture (LLM calls via aliases, no model names in source)
- Auto-commit each verified slice (PATCH bump per slice)
- No silent fail-open (validate at load, notify, pause)
- User-authored lessons are eviction-immune
- Pre-push checklist (typecheck + prettier + lint + test + build, in opensquid)
- Verify CI after every push

These are the cross-cutting contract a task ships into. The spec doesn't restate them — but if the task's design violates one (e.g. introduces silent fail-open, or names a model in source), surface it as a risk callout.

## Output

After authoring a track file or extending an existing one:

1. Confirm the task IDs and count are stable
2. List the new persona-skills added to skills-catalog.md (if any)
3. Update `docs/tasks/README.md` task-index row + total count
4. Commit as one logical slice (`docs: tasks/ — <track> spec authoring (N tasks)`)
5. Report: how many tasks added, total now, which keystone tasks anchor downstream work

If the user said "spec out X tasks" — author + commit. Don't ask "shall I commit?" — the auto-commit rule applies.
```
