/**
 * Engine bridge for the auto-classify detached subprocess.
 *
 * The detached subprocess spawned by the Stop hook runs in its own
 * Node process, so it spins up its own `OpenSquidEngine` (which spawns
 * its own `loop-engine serve` child). We narrow the engine API to the
 * two RPCs auto-classify actually uses — `memory.create` (for
 * auto-memorize) and `memory.search` (for cross-session dedup).
 *
 * The lazy singleton + `shutdownAutoClassifyEngine()` ensure we don't
 * leak the engine subprocess after the auto-classify run completes.
 */

import { OpenSquidEngine } from "../engine-client.js";
import { detectOrigin } from "../origin.js";

let _engine: OpenSquidEngine | null = null;

function engine(): OpenSquidEngine {
  if (!_engine) _engine = new OpenSquidEngine();
  return _engine;
}

/**
 * NOTE: lifecycle is owned by the CLI dispatcher in `src/index.ts` —
 * the dispatcher wraps `runAutoClassifyHook` in a try/finally that
 * calls `shutdownAutoClassifyEngine()` regardless of which engine
 * methods were actually invoked (#112-audit finding 2: prior version
 * leaked the engine subprocess on the search-only path because
 * shutdown lived inside `createMemory` only).
 */
export async function createMemory(args: {
  description: string;
  content: string;
}): Promise<{ memory_id?: string }> {
  const origin = detectOrigin();
  const result = await engine().createMemory({
    description: args.description,
    content: args.content,
    authored_by: "agent",
    origin,
  });
  const memoryId =
    (result as unknown as { memory_id?: string; id?: string }).memory_id ??
    (result as unknown as { id?: string }).id;
  return { memory_id: memoryId };
}

export async function searchMemoryHybrid(args: {
  query: string;
  limit?: number;
  mode?: "semantic" | "text" | "hybrid";
  min_similarity?: number;
}): Promise<{ results: Array<{ score: number; source?: string }> }> {
  const result = await engine().searchMemory({
    query: args.query,
    limit: args.limit ?? 3,
    mode: args.mode ?? "hybrid",
    min_similarity: args.min_similarity,
  });
  // Normalize the engine response shape to what dedup expects.
  const hits =
    (
      result as unknown as {
        results?: Array<{ score?: number; similarity?: number; source?: string }>;
      }
    ).results ?? [];
  return {
    results: hits.map((h) => ({
      score: h.score ?? h.similarity ?? 0,
      source: h.source,
    })),
  };
}

/**
 * Tear down the lazily-spawned engine. Called automatically after
 * `createMemory` resolves (the subprocess has no other work after
 * write). Idempotent; safe to call multiple times.
 */
export async function shutdownAutoClassifyEngine(): Promise<void> {
  if (!_engine) return;
  try {
    _engine.shutdown();
  } catch {
    // engine may already be down
  }
  _engine = null;
}
