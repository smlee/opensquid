# coding-flow — operating procedure (how to run a track so the gates pass first-try)

This is the **METHOD**. The SCOPE/AUTHOR **rubric** (injected alongside this) is the **BAR** — the
criteria the audit applies. Follow both: this tells you the steps; the rubric tells you the standard.

## 0. Pick the flow by request type

- "look / find / check / why / investigate" → **RESEARCH**: full end-to-end reads + a synthesis step.
  No freeform grep-and-guess; investigation is never process-exempt.
- "do X / build / fix / add" → the **3-stage flow** below (SCOPE → AUTHOR → CODE).

## 1. SCOPE — gate: guess-audit → `GUESS_FREE`

- In **one** turn: `recall` + `Read` + `Grep` (**≥3 calls**), **then** write the pre-research **once**.
  Never stub-then-edit across turns — the depth gate counts research per-turn, and each Edit to the
  artifact re-fires the ~1–2 min audit (batch all edits into a single Write).
- Every claim is **derived from cited evidence** (`file:line`, a memory, or the user's words) **or**
  flagged `- [ ] OPEN QUESTION:`. Weigh the alternatives; choose the **simplest correct** one
  (Full-fix over a special-case patch). The artifact lives at `docs/research/T-*-pre-research-*.md`.

## 2. AUTHOR — gate: spec-audit → `SPEC_COMPLETE`

- Write `docs/tasks/T-*.md` with all **11 fields** + **REAL code shapes** (actual code, not
  pseudocode), one `### Task` block per slice.
- `TaskCreate` each block **only after** the spec-audit passes, with `metadata.taskId` +
  `metadata.spec` = the spec's absolute path. A TaskCreate is not "authoring done"; the audit is.

## 3. CODE — gate: phase-log → all 7 phases before commit

- Drive the 7 phases and `log_phase` each as it completes:
  `pre_research → learn → code → test → audit → post_research → fix`.
- `pnpm` only — never `npm i` (it corrupts node_modules). Run the full local gate chain:
  `pnpm typecheck && pnpm lint && pnpm test && pnpm format:check` — **`format:check` LAST** (the
  CHANGELOG is authored in the audit phase, after the gate ran).
- Stage with explicit `git add <paths>` — **never `git add -A`** (it sweeps drive-by files into the
  commit). Sole author: no `Co-Authored-By:` trailers.
- After push, verify CI with `gh run view <id> --json conclusion` (not a backgrounded `gh run watch`).

## On a BLOCK

Do the block's **named step** (write the pre-research / pass the audit / `TaskCreate`). Never
narrate-and-stop, never `--no-verify` (a PreToolUse gate ignores it), never permission-fish. If the
named step errors, fix that and retry **inside** the flow.
