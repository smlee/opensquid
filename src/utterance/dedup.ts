/**
 * Auto-classifier dedup helpers.
 *
 * Two layers:
 *   1. Per-session bloom-style hash set in
 *      `<data-root>/sessions/<id>/auto-classified-hashes.jsonl`
 *      — fast cross-turn filter for trivial repeats within a session.
 *   2. Hybrid-search pre-write check via the engine — catches semantic
 *      near-duplicates across sessions.
 *
 * Both layers are advisory. A miss is "we double-write a memory";
 * cheap to accept compared to blocking the auto-classifier path.
 */

import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { resolveDataRoot } from "../codex/store.js";

function hashesPath(sessionId: string, dataRoot?: string): string {
  return path.join(
    resolveDataRoot(dataRoot),
    "sessions",
    sessionId,
    "auto-classified-hashes.jsonl",
  );
}

/** Stable hash for an utterance + kind + tool tuple. Whitespace-collapsed, lowercased. */
export function utteranceFingerprint(args: {
  kind: string;
  text: string;
  suggested_tool: string;
}): string {
  const normalized = `${args.kind}|${args.suggested_tool}|${args.text.trim().toLowerCase().replace(/\s+/g, " ")}`;
  return crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

/** Load the per-session hash set. Returns empty Set on any error. */
export async function loadSessionHashes(
  sessionId: string,
  options: { dataRoot?: string } = {},
): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(hashesPath(sessionId, options.dataRoot), "utf8");
    return new Set(
      raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/** Append a fingerprint to the session's hash set (fire-and-forget). */
export async function recordSessionHash(
  sessionId: string,
  fingerprint: string,
  options: { dataRoot?: string } = {},
): Promise<void> {
  const p = hashesPath(sessionId, options.dataRoot);
  try {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.appendFile(p, fingerprint + "\n", "utf8");
  } catch {
    // dedup is best-effort; don't propagate
  }
}

/**
 * Hybrid-search pre-check — calls the engine's `recall` to see if a
 * semantically similar memory already exists. Returns true if we
 * should SKIP the write.
 *
 * Caller passes the engine-client `searchMemory` function so we don't
 * tightly couple this module to the engine client class.
 */
export interface HybridSearchFn {
  (args: {
    query: string;
    limit?: number;
    mode?: "semantic" | "text" | "hybrid";
    min_similarity?: number;
  }): Promise<{ results: Array<{ score: number; source?: string }> }>;
}

export async function isSemanticallyDuplicate(
  description: string,
  searchMemory: HybridSearchFn,
  options: { minSimilarity?: number; bothBoost?: boolean } = {},
): Promise<boolean> {
  const minSim = options.minSimilarity ?? 0.85;
  try {
    const result = await searchMemory({
      query: description,
      mode: "hybrid",
      limit: 3,
      min_similarity: minSim,
    });
    if (!result?.results) return false;
    // High-similarity hit OR "source: both" hit (semantic + text both matched).
    return result.results.some(
      (r) => r.score >= minSim || (options.bothBoost !== false && r.source === "both"),
    );
  } catch {
    // engine unreachable → don't block the write
    return false;
  }
}
