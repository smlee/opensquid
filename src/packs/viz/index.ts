/**
 * PV.1 — pack-format-v2 visualization + round-trip (T-pack-viz §PV.1).
 *
 * `toDot`/`toMermaid` render a PackV2 FSM (the loop, the structural test — they compile-first, so an
 * invalid pack throws); `fromDot` recovers it (LOSSLESS via the embedded `// __osq_pack:` comment, else a
 * stub SKELETON from the visual graph); `fromMermaid` recovers a skeleton. Generated from the SOURCE pack,
 * so the round-trip target is an editable PackV2.
 */
import { type PackV2, PackV2 as PackV2Schema } from '../schemas/pack_v2.js';
import { compilePackV2 } from '../compile_v2.js';

import { emitDot } from './to_dot.js';
import { emitMermaid } from './to_mermaid.js';
import { extractPackComment, skeletonFromGraph } from './from_dot.js';
import { skeletonFromMermaid } from './from_mermaid.js';

/** PackV2 → DOT (visible FSM + the lossless `// __osq_pack:` comment). Throws on an invalid pack (compile-first). */
export function toDot(pack: PackV2): string {
  compilePackV2(pack); // validateFsm — an invalid pack cannot be visualized
  return emitDot(pack);
}

/** PackV2 → Mermaid flowchart (viz). Throws on an invalid pack (compile-first). */
export function toMermaid(pack: PackV2): string {
  compilePackV2(pack);
  return emitMermaid(pack);
}

/**
 * DOT → PackV2. LOSSLESS when the `// __osq_pack:` comment is present (the round-trip of `toDot`); otherwise
 * a stub SKELETON reconstructed from the visual graph. Either way validated through `PackV2.parse` (fail-loud).
 */
export function fromDot(dot: string): PackV2 {
  const embedded = extractPackComment(dot);
  return PackV2Schema.parse(embedded ?? skeletonFromGraph(dot));
}

/** Mermaid → a PackV2 SKELETON (Partial) — the FSM structure to fill in (Mermaid carries no config). */
export function fromMermaid(mmd: string): Partial<PackV2> {
  return skeletonFromMermaid(mmd);
}

export type { PackV2 };
