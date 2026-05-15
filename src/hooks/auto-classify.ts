/**
 * `opensquid hook auto-classify` — DETACHED subprocess entrypoint
 * spawned by the Stop hook to run the LLM classifier off the critical
 * path of the agent's response.
 *
 * Argv shape: `node dist/index.js hook auto-classify <session-id> <transcript-path>`
 *
 * Flow:
 *   1. Read the user's last utterance from the transcript JSONL.
 *   2. Call the LLM classifier (Ollama by default).
 *   3. Dedup against per-session hash set + cross-session semantic
 *      search.
 *   4. Apply the auto-vs-surface policy:
 *        - memorize @ high confidence  → auto-execute + surface as FYI
 *        - memorize @ medium/low       → surface only
 *        - remember (lesson candidate) → surface only (wedge invariant)
 *        - update_memory               → surface only
 *   5. Write surviving candidates to
 *      `<data-root>/sessions/<id>/auto-classify-candidates.jsonl` —
 *      `UserPromptSubmit` reads this next turn.
 *
 * Exit 0 always. Failures are logged to a per-session file and
 * silenced from stdio.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { resolveDataRoot } from "../codex/store.js";
import { classifyWithLLM, type ClassifiedUtterance } from "../utterance/llm-classifier.js";
import {
  isSemanticallyDuplicate,
  loadSessionHashes,
  recordSessionHash,
  utteranceFingerprint,
  type HybridSearchFn,
} from "../utterance/dedup.js";
import { readLastUserText } from "./transcript.js";

export type AutoClassifyAction = "auto-memorized" | "surfaced" | "skipped-duplicate";

export interface AutoClassifyCandidate {
  ts: string;
  kind: ClassifiedUtterance["kind"];
  text: string;
  confidence: ClassifiedUtterance["confidence"];
  reasoning: string;
  suggested_tool: ClassifiedUtterance["suggested_tool"];
  suggested_args: ClassifiedUtterance["suggested_args"];
  action_taken: AutoClassifyAction;
  /** When auto-memorized: the memory id returned by the engine. */
  memory_id?: string;
}

export interface AutoClassifyDeps {
  classify?: typeof classifyWithLLM;
  searchMemory?: HybridSearchFn;
  createMemory?: (args: {
    description: string;
    content: string;
  }) => Promise<{ memory_id?: string }>;
  /** Disable LLM call entirely (used by tests). */
  disabled?: boolean;
}

export interface AutoClassifyOptions {
  dataRoot?: string;
  /** "off" | "surface" | "hybrid" (default) | "auto". */
  mode?: string;
}

/**
 * Main entrypoint. Argv-shaped; if `sessionId` / `transcriptPath` are
 * not provided, falls back to argv[3] / argv[4].
 */
export async function runAutoClassifyHook(
  sessionId?: string,
  transcriptPath?: string,
  deps: AutoClassifyDeps = {},
  options: AutoClassifyOptions = {},
): Promise<void> {
  const sid = sessionId ?? process.argv[3];
  const tpath = transcriptPath ?? process.argv[4];
  if (!sid || !tpath) return;

  const mode = options.mode ?? process.env.OPENSQUID_AUTO_CLASSIFY ?? "hybrid";
  if (mode === "off") return;

  const userText = await readLastUserText(tpath);
  if (!userText.trim()) return;

  const classify = deps.classify ?? classifyWithLLM;
  const response = deps.disabled ? { utterances: [] } : await classify(userText);
  if (response.utterances.length === 0) return;

  // Injection guard (#112-audit finding 6): if the user's text smells
  // like JSON-shaped prompt-injection, refuse to auto-memorize. We
  // still surface for review so the agent sees what was attempted, but
  // never write to memory.
  const userLooksLikeInjection = INJECTION_MARKERS.some((m) => userText.includes(m));

  // Dedup layer 1: per-session bloom filter.
  const sessionHashes = await loadSessionHashes(sid, { dataRoot: options.dataRoot });

  // Collect candidates + their fingerprints in memory first. We
  // record the hash ONLY after appendCandidates resolves — otherwise a
  // mid-loop disk error would record the hash but silently drop the
  // candidate (#112-audit finding 3).
  const pendingHashes: string[] = [];
  const candidates: AutoClassifyCandidate[] = [];

  for (const u of response.utterances) {
    const fp = utteranceFingerprint({
      kind: u.kind,
      text: u.text,
      suggested_tool: u.suggested_tool,
    });
    if (sessionHashes.has(fp)) {
      // Already seen in this session — skip silently.
      continue;
    }

    // Apply per-item caps + injection guard on the LLM-emitted strings.
    const safe = sanitizeArgs(u);

    let action = decideAction({ ...u, suggested_args: safe }, mode);
    if (userLooksLikeInjection && action === "auto-memorized") {
      // Downgrade auto-memorize to surface when the user message
      // looks like a prompt-injection attempt.
      action = "surfaced";
    }

    if (action === "auto-memorized") {
      // Dedup layer 2: cross-session semantic check before writing.
      let duplicate = false;
      if (deps.searchMemory) {
        duplicate = await isSemanticallyDuplicate(safe.description, deps.searchMemory);
      }
      if (duplicate) {
        candidates.push(toCandidate({ ...u, suggested_args: safe }, "skipped-duplicate"));
        pendingHashes.push(fp);
        continue;
      }

      let memoryId: string | undefined;
      if (deps.createMemory) {
        try {
          const result = await deps.createMemory({
            description: safe.description,
            content: safe.content,
          });
          memoryId = result.memory_id;
        } catch {
          // Engine failed — downgrade to surface so we don't lose the candidate.
          candidates.push(toCandidate({ ...u, suggested_args: safe }, "surfaced"));
          pendingHashes.push(fp);
          continue;
        }
      }
      candidates.push({
        ...toCandidate({ ...u, suggested_args: safe }, "auto-memorized"),
        memory_id: memoryId,
      });
    } else {
      candidates.push(toCandidate({ ...u, suggested_args: safe }, action));
    }
    pendingHashes.push(fp);
  }

  if (candidates.length === 0) return;

  // Write candidates FIRST (one per appendFile call — small payloads
  // are atomic on POSIX, multi-candidate batches were not — #112-audit
  // finding 4). Only after the write resolves do we record hashes so
  // a write failure doesn't silently silence the next attempt.
  for (const c of candidates) {
    await appendCandidates(sid, [c], { dataRoot: options.dataRoot });
  }
  for (const fp of pendingHashes) {
    await recordSessionHash(sid, fp, { dataRoot: options.dataRoot });
  }
}

// ---------------------------------------------------------------------
// Per-item sanitization (#112-audit findings 6 + 10)
// ---------------------------------------------------------------------

/** Hard caps on LLM-emitted strings to limit prompt-injection payload size. */
const MAX_DESCRIPTION = 200;
const MAX_CONTENT = 800;

/**
 * Smells-like-injection markers the classifier might try to bypass via.
 * If the USER's utterance contains any of these, we refuse to auto-
 * memorize — only surface for review.
 */
const INJECTION_MARKERS = [
  '"utterances"',
  '"suggested_tool"',
  '"suggested_args"',
  "Ignore prior instructions",
  "Ignore all previous instructions",
];

function sanitizeArgs(u: ClassifiedUtterance): ClassifiedUtterance["suggested_args"] {
  const description = (u.suggested_args.description ?? "").slice(0, MAX_DESCRIPTION).trim();
  const content = (u.suggested_args.content ?? "").slice(0, MAX_CONTENT).trim();
  return { description, content };
}

/**
 * Policy:
 *   - mode="auto"    → memorize @ any confidence → auto-memorized; everything else surfaced.
 *   - mode="hybrid"  → memorize @ high confidence → auto-memorized; rest surfaced.
 *   - mode="surface" → everything surfaced.
 *   - lesson candidates (`remember`) and `update_memory` are ALWAYS surfaced — wedge invariant.
 */
export function decideAction(u: ClassifiedUtterance, mode: string): AutoClassifyAction {
  if (u.suggested_tool !== "memorize") return "surfaced";
  if (mode === "surface") return "surfaced";
  if (mode === "auto") return "auto-memorized";
  // hybrid (default)
  return u.confidence === "high" ? "auto-memorized" : "surfaced";
}

function toCandidate(u: ClassifiedUtterance, action: AutoClassifyAction): AutoClassifyCandidate {
  return {
    ts: new Date().toISOString(),
    kind: u.kind,
    text: u.text,
    confidence: u.confidence,
    reasoning: u.reasoning,
    suggested_tool: u.suggested_tool,
    suggested_args: u.suggested_args,
    action_taken: action,
  };
}

// ---------------------------------------------------------------------
// Candidate file IO
// ---------------------------------------------------------------------

function candidatesPath(sessionId: string, dataRoot?: string): string {
  return path.join(
    resolveDataRoot(dataRoot),
    "sessions",
    sessionId,
    "auto-classify-candidates.jsonl",
  );
}

export async function appendCandidates(
  sessionId: string,
  candidates: AutoClassifyCandidate[],
  options: { dataRoot?: string } = {},
): Promise<void> {
  const p = candidatesPath(sessionId, options.dataRoot);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const payload = candidates.map((c) => JSON.stringify(c)).join("\n") + "\n";
  await fs.appendFile(p, payload, "utf8");
}

export async function readCandidates(
  sessionId: string,
  options: { dataRoot?: string } = {},
): Promise<AutoClassifyCandidate[]> {
  try {
    const raw = await fs.readFile(candidatesPath(sessionId, options.dataRoot), "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as AutoClassifyCandidate);
  } catch {
    return [];
  }
}

export async function clearCandidates(
  sessionId: string,
  options: { dataRoot?: string } = {},
): Promise<void> {
  try {
    await fs.rm(candidatesPath(sessionId, options.dataRoot));
  } catch {
    // already gone
  }
}
