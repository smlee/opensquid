/**
 * Honesty ledger — catches claim-vs-action gaps in assistant turns.
 *
 * The agent makes claims like "running tests now" or "starting research"
 * or "committed" in its text output. These claims are checkable against
 * the tool calls that actually happened in the same turn. When the
 * claim has no matching tool call, that's a "broken promise" — opensquid
 * records it so the next turn surfaces it to the agent for correction.
 *
 * Storage:
 *   <data-root>/sessions/<session-id>/turn-ledger.jsonl
 *     One JSON line per tool call this turn, appended by the PreToolUse
 *     hook. Cleared at turn-end after reconciliation.
 *
 *   <data-root>/sessions/<session-id>/broken-promises.jsonl
 *     Append-only ledger of claims that lacked matching evidence.
 *     Surfaced to the agent on the NEXT turn via SessionStart/
 *     UserPromptSubmit hook output.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { resolveDataRoot } from "../codex/store.js";

// ---------------------------------------------------------------------
// Claim → required-evidence catalog
// ---------------------------------------------------------------------

export type ClaimEvidenceShape =
  | { kind: "any_tool" }
  | { kind: "bash_contains"; needle: string }
  | { kind: "bash_regex"; pattern: string }
  | { kind: "tool_called"; tool: string }
  // v0.6.4: composable + tool-agnostic shapes for claim patterns that
  // can be satisfied by multiple MCP tools (e.g. telegram via plugin
  // OR opensquid chat_send) or that match against an Edit/Write file
  // path (e.g. "bumped Cargo.toml" → input_contains Edit + Cargo.toml).
  | { kind: "any_of"; options: ClaimEvidenceShape[] }
  | { kind: "input_contains"; tool: string; needle: string };

export interface ClaimPattern {
  /** Stable id (e.g. "research-start"). */
  id: string;
  /** Regex matched against assistant text. */
  text_regex: string;
  /** What proof of action satisfies this claim. */
  evidence: ClaimEvidenceShape;
  /** Short label surfaced to the agent when the promise is broken. */
  promise_label: string;
}

/**
 * Catalog of common claim phrases observed in the 2026-05-15 build
 * session. Each pattern is conservative — false positive cost is
 * "the agent gets nagged once" while false negative cost is
 * "the lie slips through."
 */
export const CLAIM_PATTERNS: ClaimPattern[] = [
  {
    id: "research-start",
    text_regex: "\\b(pre-?research|research)\\s+(starting|begins?)\\b",
    evidence: { kind: "tool_called", tool: "Agent" },
    promise_label: "spawn a research agent or do explicit reading",
  },
  {
    id: "research-spawning",
    text_regex: "\\bspawn(?:ing)?\\s+(?:a\\s+)?(?:research\\s+)?agent\\b",
    evidence: { kind: "tool_called", tool: "Agent" },
    promise_label: "spawn a research agent",
  },
  {
    id: "starting-now",
    text_regex: "\\b(?:starting|kicking off)\\s+(?:#?\\w+\\s+)?now\\b",
    evidence: { kind: "any_tool" },
    promise_label: "actually start the work (any tool call counts)",
  },
  {
    id: "running-tests",
    text_regex: "\\brunning\\s+(?:the\\s+)?tests?\\b|\\btests?\\s+pass(?:ing|ed|es)?\\b",
    evidence: { kind: "bash_regex", pattern: "(npm\\s+test|cargo\\s+test|vitest|jest)" },
    promise_label: "run npm test / cargo test",
  },
  {
    id: "running-build",
    text_regex:
      "\\brunning\\s+(?:the\\s+)?build\\b|\\bbuild\\s+(?:pass(?:ing|es|ed)?|clean|green)\\b",
    evidence: { kind: "bash_regex", pattern: "(npm\\s+run\\s+build|cargo\\s+build|tsc)" },
    promise_label: "run the build",
  },
  {
    id: "committed",
    text_regex: "\\b(?:committed|just committed|committing)\\b",
    evidence: { kind: "bash_regex", pattern: "git\\s+commit\\b" },
    promise_label: "git commit",
  },
  {
    id: "audit-done",
    text_regex: "\\b(?:audit\\s+(?:done|complete|✅)|Phase\\s+\\d+\\s*[—-]\\s*Audit)\\b",
    evidence: { kind: "any_tool" },
    promise_label: "do the audit (any inspection tool call)",
  },

  // ---- v0.6.4 expansion (drift catalog from 2026-05-16 cycle) -----
  //
  // Five additional patterns covering claim shapes that silently
  // slipped today. Each was a real "said it / didn't do it" gap
  // observed in the session transcript. Per the discipline check
  // (`mem-3cf66f39`), structural visibility > self-correction prompts.

  {
    // Claim: "Telegram report sent" / "pinged you" / "sent to Telegram"
    // Evidence: EITHER the external plugin's reply tool OR Open Squid's
    // own chat_send (both can fulfill the same intent). Caught today's
    // silent skip when the plugin MCP was disconnected.
    id: "telegram-sent",
    text_regex:
      "\\b(?:telegram(?:\\s+(?:report|message))?\\s+(?:sent|delivered)|sent\\s+(?:to|via)\\s+telegram|pinged\\s+(?:you|telegram))\\b",
    evidence: {
      kind: "any_of",
      options: [
        { kind: "tool_called", tool: "mcp__plugin_telegram_telegram__reply" },
        { kind: "tool_called", tool: "mcp__opensquid__chat_send" },
      ],
    },
    promise_label: "call mcp__plugin_telegram_telegram__reply or mcp__opensquid__chat_send",
  },

  {
    // Claim: "pushed / pushing" with a git-push-shaped object. v0.6.4
    // audit-LOW: expanded alternation to catch "pushed it" / "pushed up"
    // / "pushed the changes/branch/release/PR" — previous regex only
    // matched specific objects (origin/main/remote/commit/engine/etc.)
    // and let common phrasings slip as false negatives.
    id: "pushed",
    text_regex:
      "\\b(?:pushed|pushing)\\s+(?:to\\s+(?:origin|main|remote|github)|it|up|the\\s+(?:commit|engine|opensquid|tag|fix|changes?|branch|release|PR|update))\\b",
    evidence: { kind: "bash_regex", pattern: "git\\s+push\\b" },
    promise_label: "git push origin <branch>",
  },

  {
    // Claim: "tagged v0.5.0 / created the tag v0.5.0 / new tag v0.5.0"
    // Evidence: `git tag` Bash command.
    //
    // v0.6.4 audit-MED tightening: require a version-shaped token
    // (`v0.5`, `0.5.0`, `1.0.0`, etc.) near the verb. Previous
    // `\btagged\b` alone fired on prose like "tagged for review" /
    // "I tagged this as P0" / "the file is tagged" → noisy false
    // positives.
    id: "tagged",
    text_regex:
      "\\b(?:just\\s+)?tagged\\s+v?\\d+\\.\\d+(?:\\.\\d+)?\\b|\\bcreated\\s+(?:the\\s+|a\\s+)?tag\\s+v?\\d+\\.\\d+\\b|\\bnew\\s+tag\\s+v?\\d+\\.\\d+\\b",
    evidence: { kind: "bash_regex", pattern: "git\\s+tag\\b" },
    promise_label: "git tag <name>",
  },

  {
    // Claim: phase-ceremony language (must include "phase" keyword OR
    // explicit log_phase reference). Evidence: mcp__opensquid__log_phase
    // call.
    //
    // v0.6.4 audit-MED tightening: previous regex matched "logged audit"
    // bare, which fires on prose like "logging test results" or "logged
    // fix details to the journal." Require the word "phase(s)" near
    // the verb OR the literal `log_phase` identifier. False-negative
    // cost ("logged audit + post_research" without saying "phase"
    // won't trigger) is acceptable because the workflow-gate is the
    // primary defense — this is the secondary visibility check.
    id: "phase-logged",
    text_regex:
      "\\b(?:logged|logging)\\s+(?:the\\s+)?(?:audit|post[_-]?research|fix|test|code|learn|pre[_-]?research)\\s+phase\\b|\\bphases?\\s+logged\\b|\\blog_phase\\b",
    evidence: { kind: "tool_called", tool: "mcp__opensquid__log_phase" },
    promise_label: "call mcp__opensquid__log_phase",
  },

  {
    // Claim: "fmt clean / clippy clean / prettier clean / formatting passes"
    // Evidence: ran fmt/clippy/prettier via Bash. Catches the pattern
    // where I assert cleanliness without verification.
    id: "fmt-clippy",
    text_regex: "\\b(?:fmt|clippy|prettier|formatting)\\s+(?:clean|passes?|passing|green|ok|✅)\\b",
    evidence: {
      kind: "bash_regex",
      pattern: "(cargo\\s+(?:fmt|clippy)|prettier|npm\\s+run\\s+(?:format|lint))",
    },
    promise_label: "run cargo fmt / cargo clippy / prettier / npm run format",
  },

  // ---- 0.7.6 expansion (#150 drift-fix track) ---------------------
  //
  // Three patterns addressing the 60% agent-classification drift
  // share from the 2026-05-16 session retro. Each came from a real
  // repeated incident; warn-only by design (Stop hook surfaces them
  // at next turn START via UserPromptSubmit). Block-level
  // enforcement waits for drift-as-codex chunk 2.

  {
    // Claim: assistant assigns a minor/major version slot in any
    // surface ("v0.8", "v0.9", "ships as v1.0", "next minor", "bump
    // to v0.8.0"). Per the PATCH-ONLY rule ([[feedback_pre1_versioning]]
    // v4), the agent is FORBIDDEN from picking these slots. Evidence:
    // either an AskUserQuestion tool call (asked for authorization)
    // OR the user already said the same version string in this turn.
    //
    // 6+ incidents on 2026-05-16. Each cost a TASKS.md / ROADMAP.md
    // rollback edit. Cheaper to nag at next turn than to clean up.
    //
    // Regex is conservative: requires a literal v0.X / v1.X / "minor
    // bump" / "next minor"-shaped phrase. False positives on prose
    // ("v0.1 of the spec") are acceptable — false-negative cost is
    // another roadmap edit-and-revert.
    id: "version-slot-assignment",
    text_regex:
      "\\b(?:v?0\\.[89]\\b|v?0\\.1[0-9]\\b|v?1\\.[0-9]+\\b|next\\s+minor\\b|next\\s+major\\b|bump(?:ing)?\\s+(?:to\\s+)?(?:minor|major)\\b|ships?\\s+as\\s+v?[0-9]+\\.[0-9]+\\.[0-9]+\\b)",
    evidence: {
      kind: "any_of",
      options: [
        // Agent asked the user — the right path.
        { kind: "tool_called", tool: "AskUserQuestion" },
        // Agent referenced TaskCreate/TaskUpdate (acceptable: those
        // ops may legitimately name a version in a task subject the
        // user already authorized).
        { kind: "tool_called", tool: "TaskCreate" },
        { kind: "tool_called", tool: "TaskUpdate" },
      ],
    },
    promise_label:
      "ASK the user before naming a non-patch version slot (call AskUserQuestion); never pick v0.8/v0.9/v1.0 unilaterally",
  },

  {
    // Claim: assistant declares "starting <phase>" / "now in phase X"
    // / "moving to phase Y". Evidence: log_phase MCP call within the
    // same turn. Catches the forward-tense gap that today's
    // "phase-logged" pattern (past-tense only) misses.
    //
    // Example: I say "Phase 3/7 — code:" then immediately make file
    // edits without ever calling log_phase(code). Today's gate only
    // catches the past-tense version ("logged code phase"); this
    // catches the announcement before the work.
    id: "phase-claim-forward",
    // Two alternations: (a) "Phase N/7 — <phasename>" / "Phase N — <phasename>"
    // (b) verb-prefixed: "starting <phasename>" / "entering phase X" /
    // "moving to phase X" / "now in phase X" / "Phase X:" inline.
    // Phase-name list matches the locked 7-phase set; allows `_` or `-`
    // separators (post_research / post-research).
    text_regex:
      "(?:\\bPhase\\s+[1-7](?:\\s*\\/\\s*7)?\\s*[—\\-:]\\s*(?:pre[_-]?research|learn|code|test|audit|post[_-]?research|fix)\\b)|(?:\\b(?:starting|entering|moving\\s+to|now\\s+in)\\s+(?:phase\\s+)?(?:pre[_-]?research|learn|code|test|audit|post[_-]?research|fix)\\b)",
    evidence: { kind: "tool_called", tool: "mcp__opensquid__log_phase" },
    promise_label: "call mcp__opensquid__log_phase for the phase you announced",
  },

  {
    // Claim: assistant says "executing", "running", "now I'll", etc.
    // — implying substantive work — while no active task exists.
    // The 2026-05-16 Telegram bootstrap chain ran ~20 substantive
    // tool calls (curl, kill, edit) with no TaskCreate. Workflow-
    // gate had nothing to enforce against.
    //
    // Evidence: TaskCreate, TaskUpdate, or TaskGet within this turn.
    // Wider than "tool_called X" because any task-touching call
    // means the agent is at least aware of the task layer.
    //
    // False-positive risk: legitimate quick replies ("now I'll check
    // X" as a one-liner) get nagged. Acceptable per the same trade-
    // off as other claim patterns — better to nag than to let a
    // 20-call substantive chain run unscoped.
    id: "session-no-task",
    text_regex:
      "\\b(?:executing|now\\s+i'?ll|let\\s+me\\s+(?:run|execute|implement|fix|build|wire)|i'?ll\\s+(?:run|implement|fix|build|wire))\\b",
    evidence: {
      kind: "any_of",
      options: [
        { kind: "tool_called", tool: "TaskCreate" },
        { kind: "tool_called", tool: "TaskUpdate" },
        { kind: "tool_called", tool: "TaskGet" },
      ],
    },
    promise_label:
      "create or update a task (TaskCreate/TaskUpdate) before doing substantive work — keeps the workflow-gate enforceable",
  },
];

// ---------------------------------------------------------------------
// Session-scoped ledger
// ---------------------------------------------------------------------

/**
 * One tool-call entry, persisted across ALL turns in the same Claude
 * Code session. Cleared only at session end (or explicit
 * `clearSessionLedger`).
 *
 * #114 (2026-05-15) — v0.4.C.1 fix: previously this was a PER-TURN
 * ledger that got cleared by the Stop hook, which caused recap text
 * describing prior-turn work to be flagged as broken promises. Now
 * the ledger accumulates across the whole session so claims like
 * "tests pass" satisfy against any `npm test` from any earlier turn
 * in the same session.
 */
export interface TurnLedgerEntry {
  ts: string;
  tool: string;
  /** Subset of tool_input relevant to reconciliation. */
  input_summary: string;
}

function sessionDir(sessionId: string, dataRoot?: string): string {
  return path.join(resolveDataRoot(dataRoot), "sessions", sessionId);
}

function ledgerPath(sessionId: string, dataRoot?: string): string {
  // Filename kept as `turn-ledger.jsonl` for back-compat with any
  // existing per-turn files on disk; semantics are now session-scoped.
  return path.join(sessionDir(sessionId, dataRoot), "turn-ledger.jsonl");
}

function brokenPromisesPath(sessionId: string, dataRoot?: string): string {
  return path.join(sessionDir(sessionId, dataRoot), "broken-promises.jsonl");
}

/** Called by PreToolUse hook to record what the agent is about to do. */
export async function recordToolCall(
  sessionId: string,
  tool: string,
  inputSummary: string,
  options: { dataRoot?: string } = {},
): Promise<void> {
  const dir = sessionDir(sessionId, options.dataRoot);
  await fs.mkdir(dir, { recursive: true });
  const entry: TurnLedgerEntry = {
    ts: new Date().toISOString(),
    tool,
    input_summary: inputSummary,
  };
  await fs.appendFile(
    ledgerPath(sessionId, options.dataRoot),
    JSON.stringify(entry) + "\n",
    "utf8",
  );
}

/** Read the session-scoped ledger (every tool call so far this session). */
export async function readTurnLedger(
  sessionId: string,
  options: { dataRoot?: string } = {},
): Promise<TurnLedgerEntry[]> {
  try {
    const raw = await fs.readFile(ledgerPath(sessionId, options.dataRoot), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as TurnLedgerEntry);
  } catch {
    return [];
  }
}

/**
 * Clear the session ledger. ONLY called at session end (or by tests).
 * Stop hook does NOT call this anymore — the ledger persists across
 * turns to avoid recap-text false-positives.
 */
export async function clearTurnLedger(
  sessionId: string,
  options: { dataRoot?: string } = {},
): Promise<void> {
  try {
    await fs.rm(ledgerPath(sessionId, options.dataRoot));
  } catch {
    // already gone, fine
  }
}

/**
 * Explicit session-end clear: wipes everything opensquid wrote under
 * this session's directory — turn ledger, broken promises, plus the
 * heartbeat checkpoint and pending marker (#124). Files are removed
 * individually so unrelated files in the session dir survive (in case
 * a future hook drops something else there).
 */
export async function clearSession(
  sessionId: string,
  options: { dataRoot?: string } = {},
): Promise<void> {
  const sessionFiles = [
    ledgerPath(sessionId, options.dataRoot),
    brokenPromisesPath(sessionId, options.dataRoot),
    path.join(sessionDir(sessionId, options.dataRoot), "heartbeat-checkpoint.json"),
    path.join(sessionDir(sessionId, options.dataRoot), "heartbeat-pending.txt"),
  ];
  for (const p of sessionFiles) {
    try {
      await fs.rm(p);
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------

export interface BrokenPromise {
  ts: string;
  claim_id: string;
  claim_label: string;
  matched_text: string;
  reason: string;
}

/**
 * Scan assistant text for claim phrases, reconcile against the ledger,
 * return any unfulfilled promises.
 */
export function reconcile(assistantText: string, ledger: TurnLedgerEntry[]): BrokenPromise[] {
  const broken: BrokenPromise[] = [];
  for (const claim of CLAIM_PATTERNS) {
    let re: RegExp;
    try {
      re = new RegExp(claim.text_regex, "i");
    } catch {
      continue;
    }
    const m = assistantText.match(re);
    if (!m) continue;
    if (hasEvidence(claim.evidence, ledger)) continue;
    broken.push({
      ts: new Date().toISOString(),
      claim_id: claim.id,
      claim_label: claim.promise_label,
      matched_text: m[0],
      reason: `assistant claimed "${m[0]}" but no matching tool call in this turn`,
    });
  }
  return broken;
}

function hasEvidence(ev: ClaimEvidenceShape, ledger: TurnLedgerEntry[]): boolean {
  switch (ev.kind) {
    case "any_tool":
      return ledger.length > 0;
    case "tool_called":
      return ledger.some((e) => e.tool === ev.tool);
    case "bash_contains":
      return ledger.some((e) => e.tool === "Bash" && e.input_summary.includes(ev.needle));
    case "bash_regex": {
      let re: RegExp;
      try {
        re = new RegExp(ev.pattern);
      } catch {
        return true; // bad pattern → fail open, don't false-positive a broken promise
      }
      return ledger.some((e) => e.tool === "Bash" && re.test(e.input_summary));
    }
    case "any_of":
      return ev.options.some((opt) => hasEvidence(opt, ledger));
    case "input_contains":
      return ledger.some((e) => e.tool === ev.tool && e.input_summary.includes(ev.needle));
  }
}

/** Append a broken promise to the session's append-only ledger. */
export async function recordBrokenPromise(
  sessionId: string,
  promise: BrokenPromise,
  options: { dataRoot?: string } = {},
): Promise<void> {
  const dir = sessionDir(sessionId, options.dataRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(
    brokenPromisesPath(sessionId, options.dataRoot),
    JSON.stringify(promise) + "\n",
    "utf8",
  );
}

/** Read all broken promises for a session (used by next turn's hook). */
export async function readBrokenPromises(
  sessionId: string,
  options: { dataRoot?: string } = {},
): Promise<BrokenPromise[]> {
  try {
    const raw = await fs.readFile(brokenPromisesPath(sessionId, options.dataRoot), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as BrokenPromise);
  } catch {
    return [];
  }
}
