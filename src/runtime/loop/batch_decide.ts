// T2.14 — batch-vs-isolate deterministic decision (pre-research §3).
//
// A PURE two-axis read over the work-graph edges — zero LLM, deterministic (same input → identical plan):
//   axis-1 (parallel vs sequential) = independence: an issue with NO unmet `blocks` blocker runs in parallel;
//           a blocked issue is sequential (it runs after its blocker).
//   axis-2 (batch) = "related": independent leaf SIBLINGS sharing a `parent-child`/`discovered-from` parent are
//           grouped into one run. "small / low-risk" is explicitly OUT — there is no deterministic signal for it
//           (it would require an LLM judgement), so it is not part of this gate.
//
// Output is consumed by the T2.9 EXECUTE loop driver (onPhasesComplete → batchDecide → dispatch the next run-group),
// NOT a pre-existing durable batch path.

export interface Edge {
  from: string;
  to: string;
  type: string;
}

export interface BatchPlan {
  parallel: string[];
  sequential: string[];
  batches: string[][];
}

export function batchDecide(issueIds: string[], edges: Edge[]): BatchPlan {
  const blockedBy = new Map<string, number>(issueIds.map((i) => [i, 0]));
  for (const e of edges)
    if (e.type === 'blocks') blockedBy.set(e.to, (blockedBy.get(e.to) ?? 0) + 1);
  // axis-1: independent (no unmet blocker) → parallel; blocked → sequential (after its blocker)
  const parallel = issueIds.filter((i) => (blockedBy.get(i) ?? 0) === 0);
  const sequential = issueIds.filter((i) => (blockedBy.get(i) ?? 0) > 0);
  // axis-2: batch = independent siblings sharing a parent-child/discovered-from parent
  const parentOf = new Map<string, string>();
  for (const e of edges)
    if (e.type === 'parent-child' || e.type === 'discovered-from') parentOf.set(e.to, e.from);
  const byParent = new Map<string, string[]>();
  for (const i of parallel) {
    const p = parentOf.get(i);
    if (p) {
      const g = byParent.get(p) ?? [];
      g.push(i);
      byParent.set(p, g);
    }
  }
  const batches = [...byParent.values()].filter((g) => g.length > 1); // siblings → one run
  return { parallel, sequential, batches };
}
