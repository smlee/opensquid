/**
 * GS1 — Orchestrator guard: the interactive main loop may write DOCUMENTS ONLY; coding files are hard-blocked.
 *
 * The main loop is a PLANNER that dispatches implementation to executor subagents — it MUST NOT freehand coding
 * files (src/packs/tests/config). SPEC (user, 2026-07-05): "you can only write docs in this project" — a
 * document write (Markdown / anything under `docs/`) always passes; ANY other mutating call (a non-document file
 * write, or a file-writing Bash) is a CODING-FILE mutation and is DENIED unless one of:
 *   - the caller is an executor subagent (`agent_id` present), OR
 *   - a STANDING human permission grant is present (the project-local `allow_code_write` config value in
 *     orchestrator.json, flipped by `/code-write`; the caller resolves it and passes `codeWritePermitted`).
 *
 * PROJECT-SCOPED, NOT GLOBAL (user: "this is not global"): the caller (pre-tool-use.ts) fires this guard ONLY
 * when the project at `cwd` declares `discipline: { orchestrator_only: true }` (fullstack-flow does). A project
 * without that declaration never gets the guard. It fires in BOTH interactive and automation sessions — the
 * interactive orchestrator is exactly the freehand risk the previous automation-only gate left open.
 *
 * This guard enforces that boundary at PreToolUse.
 *
 * DENY-LIST, default-allow:
 *   - Write, Edit, NotebookEdit: always mutating (direct file editors).
 *   - Bash: mutating ONLY if the command matches a file-writing pattern:
 *       * `sed -i`   — in-place edit.
 *       * `>` / `>>` — output redirect to a file (stderr fd `2>` is NOT matched
 *         because a digit precedes `>`; `&>` is excluded via the `(?<![0-9&])`
 *         lookbehind, and `>&2` via the `(?!\s*&)` lookahead).
 *       * `tee`      — writes stdin to one or more files.
 *       * `cp` / `mv` — copy or move files into the repo.
 *   - Everything else → NOT mutating (fail-open default).
 *     This explicitly allows: git, pnpm, vitest, node, grep, ls, cat, head, tail, cd,
 *     find, sort, awk, jq, echo (without redirect), Read, Grep, Agent, Task, mcp__* tools.
 *
 * NOTE: Do NOT reuse `isReadOnlyBash` from `session_state.ts` — that is an all-segments
 * allow-list (every pipeline segment must be a known read-only verb) that OVER-DENIES
 * `cd`, compound commands, `git`, `pnpm`, and any unrecognized verb. This guard uses the
 * opposite shape: a small deny-list where only specific mutating patterns trigger a block.
 *
 * EXECUTOR EXEMPTION: if the hook input includes `agent_id`, the caller is a
 * Task/Agent executor subagent — exempt from GS1. Claude Code populates `agent_id`
 * in the hook stdin JSON ONLY inside a subagent (per the CC hook docs).
 * (The `OPENSQUID_SUBAGENT=1` guard in `subagent_guard.ts` handles opensquid-spawned
 * reviewers and ralph laps BEFORE this guard runs; `agent_id` covers Claude Code–native
 * Task/Agent children, which do NOT carry that env marker.)
 *
 * FAIL-OPEN: any error in this module must never block the call — the caller
 * (pre-tool-use.ts) wraps the check in a try/catch.
 *
 * Imports from: (none — pure functions, no I/O).
 * Imported by:  src/runtime/hooks/pre-tool-use.ts.
 */

/** Tools that are ALWAYS mutating regardless of their arguments. */
const ALWAYS_MUTATING_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

/**
 * DENY-LIST for Bash commands: true only when the command matches a file-writing pattern.
 * Default-allow — anything NOT on the deny-list is treated as NOT mutating.
 *
 * Deny patterns:
 *   `sed -i`       — in-place edit (the file is rewritten by sed itself).
 *   `>` / `>>`     — output redirect to a file (stderr fd `2>` / `&>` / `>&2` excluded).
 *   `\btee\b`      — writes stdin to one or more files in addition to stdout.
 *   `\b(cp|mv)\b`  — copy or move files.
 */
function isMutatingBash(command: string): boolean {
  // sed -i: in-place edit. `sed` followed by a `-i` flag before any pipe/sequence boundary.
  // The `[^|;&]*` cannot cross a pipe/`;`/`&`, so `cat x | sed 's/a/b/'` (no -i) is not matched.
  if (/\bsed\s[^|;&]*-i\b/.test(command)) return true;

  // Output redirect: `>` or `>>` NOT preceded by a digit (a file descriptor like `2>`)
  // or `&` (combined redirect `&>`), and NOT followed by `&` (a dup like `>&2`).
  // Catches: `echo x > f`, `cmd >> log`, `> outfile`.
  // Does NOT catch: `2>/dev/null`, `2>&1`, `&>/dev/null`, `>&2`.
  if (/(?<![0-9&])>>?(?!\s*&)/.test(command)) return true;

  // tee: writes to a file regardless of what follows.
  if (/\btee\b/.test(command)) return true;

  // cp / mv: copy or move files.
  if (/\b(?:cp|mv)\b/.test(command)) return true;

  return false;
}

/**
 * Returns true when the tool call is a mutating action in the orchestrator context.
 *
 * - Write / Edit / NotebookEdit → always mutating.
 * - Bash → mutating only when the command matches a file-writing deny-list pattern.
 *   No command string → NOT mutating (fail-open: nothing to match against the deny-list).
 * - Everything else (Read, Grep, Agent, Task, mcp__* tools, git, pnpm, node, …) → NOT mutating.
 */
export function isMutatingCall(tool: string, args: Record<string, unknown>): boolean {
  if (ALWAYS_MUTATING_TOOLS.has(tool)) return true;
  if (tool === 'Bash') {
    const cmd = args.command;
    if (typeof cmd !== 'string') return false; // no command string → fail-open (not mutating)
    return isMutatingBash(cmd);
  }
  return false; // Read, Grep, Agent, Task, mcp__* tools, git, pnpm, node, … — fail-open
}

/**
 * A DOCUMENT the orchestrator may always write (the doc-only lane, user spec): a Markdown file (`.md`/`.mdx`) or
 * ANY path under a `docs/` directory. Case-insensitive; matches both absolute (`/repo/docs/x.md`) and
 * repo-relative (`docs/x.md`) paths. Everything else is a coding file.
 */
export function isDocumentPath(path: string): boolean {
  const p = path.toLowerCase();
  if (p.endsWith('.md') || p.endsWith('.mdx')) return true;
  if (p.startsWith('docs/') || p.includes('/docs/')) return true;
  return false;
}

/**
 * A CODING-FILE mutation = a mutating call that is NOT a document write. A file-editor
 * (Write/Edit/NotebookEdit) whose single target path is a DOCUMENT is allowed (→ false); any other mutating call
 * — a non-document file write, or a file-writing Bash (`sed -i`, `>`, `tee`, `cp`/`mv`, whose target we cannot
 * trust as a document) — is a coding-file mutation (→ true). Reads never mutate (→ false).
 */
export function isCodeFileMutation(tool: string, args: Record<string, unknown>): boolean {
  if (!isMutatingCall(tool, args)) return false; // reads / non-mutating → never a coding-file write
  if (ALWAYS_MUTATING_TOOLS.has(tool)) {
    const a = args as { file_path?: unknown; notebook_path?: unknown };
    const fp = typeof a.file_path === 'string' ? a.file_path : a.notebook_path;
    if (typeof fp === 'string' && isDocumentPath(fp)) return false; // a document write — always allowed
    return true; // a non-document file write → coding file
  }
  return true; // a file-writing Bash mutation → treated as a coding-file mutation (no trusted doc target)
}

/** Optional hook-input fields threaded from the PreToolUse stdin payload. */
export interface HookInput {
  /** Present only when the hook runs inside a Task/Agent subagent (per Claude Code docs). */
  agent_id?: string;
}

export interface OrchestratorGuardResult {
  deny: boolean;
  message?: string;
}

const DENY_MESSAGE =
  '🦑 [orchestrator guard] In this project you may write DOCUMENTS only (docs/, *.md). Writing a coding file ' +
  'requires explicit permission — run `/code-write` to flip `allow_code_write` in this project’s orchestrator.json ' +
  '(it holds until you toggle it off), or dispatch an executor subagent to implement.';

/** Caller-resolved inputs the pure guard can't read itself (filesystem lives in pre-tool-use.ts). */
export interface OrchestratorGuardOptions {
  /** A STANDING human grant is present (the project-local `allow_code_write` value in orchestrator.json) → allow
   *  a coding-file write this call. The caller resolves the value; the guard stays pure. */
  codeWritePermitted?: boolean;
}

/**
 * GS1 orchestrator-only check: in a project that declares `orchestrator_only`, the main loop may write DOCUMENTS
 * but a CODING-FILE write is denied unless explicitly permitted.
 *
 * Returns `{ deny: false }` when:
 *   - `hookInput.agent_id` is present (a Task/Agent executor — always exempt), OR
 *   - the call is not a coding-file mutation (reads + document writes always pass), OR
 *   - `opts.codeWritePermitted` is true (a standing human grant is in effect).
 *
 * Returns `{ deny: true, message }` when the main loop (no agent_id) attempts a coding-file write with no grant.
 */
export function checkOrchestratorGuard(
  tool: string,
  args: Record<string, unknown>,
  hookInput?: HookInput,
  opts?: OrchestratorGuardOptions,
): OrchestratorGuardResult {
  // Executor exemption: agent_id present → Task/Agent subagent, not the main loop.
  if (hookInput?.agent_id !== undefined) return { deny: false };
  if (!isCodeFileMutation(tool, args)) return { deny: false }; // reads + DOCUMENT writes always pass
  if (opts?.codeWritePermitted === true) return { deny: false }; // standing human permission granted
  return { deny: true, message: DENY_MESSAGE };
}
