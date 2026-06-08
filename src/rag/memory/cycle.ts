/**
 * `derived_from` cycle + depth detection for memory compression (retire-Rust RES-4a; port of
 * engine/src/engine/memory/cycle.rs). Walks each predecessor's `derived_from` chain with an
 * iterative DFS that tracks the CURRENT PATH (not all-visited), so legitimate diamond DAGs (the
 * same ancestor reachable via two branches) don't false-positive as cycles. A back-edge onto the
 * current path is a true cycle; exceeding the depth cap is treated the same (CompressionCycleError).
 * The walk loads parents lazily; an absent predecessor is skipped (compress() validates existence).
 *
 * Imports from: nothing (pure — takes a parent-lookup fn).
 * Imported by: src/rag/memory/compress.ts.
 */

/** Depth cap for the derived_from chain walk (engine compress.rs COMPRESSION_MAX_CHAIN_DEPTH). */
export const COMPRESSION_MAX_CHAIN_DEPTH = 16;

export class CompressionCycleError extends Error {
  constructor(public readonly chain: string[]) {
    super(`compression cycle or over-depth in derived_from chain: ${chain.join(' -> ')}`);
    this.name = 'CompressionCycleError';
  }
}

/**
 * Throw `CompressionCycleError` if any `derived_from` chain rooted at `rootIds` contains a cycle or
 * exceeds the depth cap; resolve otherwise. `getDerivedFrom(id)` returns the parent ids, or `null`
 * when the memory is absent (skipped).
 */
export async function detectCycleInWindow(
  getDerivedFrom: (id: string) => Promise<string[] | null>,
  rootIds: string[],
): Promise<void> {
  for (const root of rootIds) {
    // Iterative DFS; each frame carries the path from the root so cycle detection is per-path
    // (diamonds OK) and the depth cap is the path length.
    const stack: { id: string; path: string[] }[] = [{ id: root, path: [root] }];
    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame === undefined) break;
      const { id, path } = frame;
      if (path.length > COMPRESSION_MAX_CHAIN_DEPTH) throw new CompressionCycleError(path);
      const parents = await getDerivedFrom(id);
      if (parents === null) continue; // absent predecessor — skip (existence is compress()'s job)
      for (const parent of parents) {
        if (path.includes(parent)) throw new CompressionCycleError([...path, parent]); // back-edge on current path = cycle
        stack.push({ id: parent, path: [...path, parent] });
      }
    }
  }
}
