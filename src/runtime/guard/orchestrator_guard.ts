/**
 * Project-scoped coordinator write guard.
 *
 * The interactive coordinator is document-only unless a standing human grant permits code writes. A disposable
 * StageProcess is not a child exemption: it is the pack-selected worker for its own stage and receives direct
 * authority, so this coordinator-only restriction does not apply to it. Review helpers receive no blanket write
 * exemption. Pack lanes and safety policy continue to govern every StageProcess tool call.
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
 * FAIL-OPEN: any error in this module must never block the call — the caller
 * (pre-tool-use.ts) wraps the check in a try/catch.
 *
 * Imports from: (none — pure functions, no I/O).
 * Imported by:  src/runtime/hooks/pre-tool-use.ts.
 */

import { toolMatches } from '../../integrations/pi/tool_aliases.js';
import { isReadOnlyBash } from '../session_state.js';

function isAlwaysMutatingTool(tool: string): boolean {
  return toolMatches(tool, /^(Write|Edit|NotebookEdit)$/);
}

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
  if (isAlwaysMutatingTool(tool)) return true;
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
  if (isAlwaysMutatingTool(tool)) {
    const a = args as { file_path?: unknown; notebook_path?: unknown };
    const fp = typeof a.file_path === 'string' ? a.file_path : a.notebook_path;
    if (typeof fp === 'string' && isDocumentPath(fp)) return false; // a document write — always allowed
    return true; // a non-document file write → coding file
  }
  return true; // a file-writing Bash mutation → treated as a coding-file mutation (no trusted doc target)
}

export type GuardActor = 'coordinator' | 'stage_process' | 'reviewer';

export interface OrchestratorGuardResult {
  deny: boolean;
  message?: string;
}

const DENY_MESSAGE =
  '🦑 [coordinator guard] In this project the interactive coordinator may write DOCUMENTS only (docs/, *.md). ' +
  'Writing a coding file requires explicit permission — run `/code-write` to flip `allow_code_write` in this ' +
  'project’s orchestrator.json. Automated implementation belongs to the pack-authorized StageProcess.';

const REVIEWER_DENY_MESSAGE =
  '🦑 [reviewer guard] Reviewers are bounded read-only processes and cannot invoke mutating or unknown tools.';

const REVIEWER_READ_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'webfetch',
  'web_fetch',
  'recall',
  'read_state',
  'workgraph_get',
  'read_procedure',
  'read_rubric',
  'stage_inject',
]);

/** Fail-closed reviewer capability check: unknown tools are not read-only. */
export function checkReviewerReadOnly(
  tool: string,
  args: Record<string, unknown>,
): OrchestratorGuardResult {
  const normalized = tool.toLowerCase();
  if (normalized === 'bash') {
    return typeof args.command === 'string' && isReadOnlyBash(args.command)
      ? { deny: false }
      : { deny: true, message: REVIEWER_DENY_MESSAGE };
  }
  return REVIEWER_READ_TOOLS.has(normalized)
    ? { deny: false }
    : { deny: true, message: REVIEWER_DENY_MESSAGE };
}

/** Caller-resolved inputs the pure guard can't read itself (filesystem lives in pre-tool-use.ts). */
export interface OrchestratorGuardOptions {
  actor: GuardActor;
  /** A standing human grant permits an interactive coordinator code write. */
  codeWritePermitted?: boolean;
}

/** Enforce the document-only coordinator boundary without creating a parent/child authority exception. */
export function checkOrchestratorGuard(
  tool: string,
  args: Record<string, unknown>,
  opts: OrchestratorGuardOptions = { actor: 'coordinator' },
): OrchestratorGuardResult {
  if (opts.actor === 'stage_process') return { deny: false };
  if (opts.actor === 'reviewer') return checkReviewerReadOnly(tool, args);
  if (!isCodeFileMutation(tool, args)) return { deny: false };
  if (opts.codeWritePermitted === true) return { deny: false };
  return { deny: true, message: DENY_MESSAGE };
}

/**
 * AQG.5 (T-arch-quality-gate) — a `docs/design/*.md` scope-of-record. The orchestrator-guard's design-doc REWRITE
 * gate fires ONLY on these (a `docs/tasks/T-*.md` or a `src/` path is out of scope — those are owned by the
 * AUTHOR rule / the code-file guard). Case-sensitive on the `docs/design/` segment (matching the content-audit
 * trigger AQG.3 widened), matching both absolute (`/repo/docs/design/x.md`) and repo-relative paths.
 */
export function isDesignDoc(path: string): boolean {
  return path.includes('docs/design/') && (path.endsWith('.md') || path.endsWith('.mdx'));
}

/** Caller-resolved inputs the pure design-doc gate can't read itself (the audit cache lives in the runtime). */
export interface DesignDocGuardOptions {
  actor: GuardActor;
  /** Read the pack-declared approved-artifact audit verdict. */
  readScopeVerdict(): Promise<string | undefined>;
}

/** Audit-gate rewrites by the coordinator; a StageProcess remains governed by its pack stage gate. */
export async function checkDesignDocRewrite(
  tool: string,
  args: Record<string, unknown>,
  opts: DesignDocGuardOptions,
): Promise<OrchestratorGuardResult> {
  if (opts.actor === 'stage_process') return { deny: false };
  if (!toolMatches(tool, /^(Write|Edit)$/)) return { deny: false }; // only file writes are gated
  const fp = typeof args.file_path === 'string' ? args.file_path : undefined;
  if (fp === undefined || !isDesignDoc(fp)) return { deny: false }; // only design-doc writes are gated
  let verdict: string | undefined;
  try {
    verdict = await opts.readScopeVerdict();
  } catch {
    return { deny: false }; // fail-open on a read error — never a hard stall
  }
  if (verdict === undefined) return { deny: false }; // no cache yet (first write) ⇒ REWRITE-gate ⇒ allow
  if (verdict.includes('VERDICT: GUESS_FREE')) return { deny: false };
  return {
    deny: true,
    message:
      '🦑 [orchestrator guard] Design-doc rewrite blocked: the scope-audit verdict for this design doc is not ' +
      'GUESS_FREE. Resolve the flagged architecture/guess issues (modularity, scalability, single-source-of-truth, ' +
      'push-vs-pull), then rewrite.',
  };
}
