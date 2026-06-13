/**
 * Derive a claim's audience from the GDC env markers the gate already trusts (the same
 * `AGENT_ENV_MARKERS` as `setup/cli/gate.ts`: CLAUDECODE / CODEX_THREAD_ID / AI_AGENT). The audience
 * is stamped at claim time, NEVER taken from caller input — so it reflects the actual harness that
 * ran the claim. (GR.1 of the gated-ralph loop; the work-graph-item instance of the claim/audience
 * pattern from wg-c34349377f81.)
 *
 * Imported by: src/mcp/tools/workgraph.ts.
 */
import type { ClaimAudience } from './types.js';

export function claimAudience(env: NodeJS.ProcessEnv = process.env): ClaimAudience {
  const claude = env.CLAUDECODE;
  if (claude !== undefined && claude !== '') return { source: 'claudecode', version: claude };
  const codex = env.CODEX_THREAD_ID;
  if (codex !== undefined && codex !== '') return { source: 'codex', threadId: codex };
  return { source: 'unknown' };
}
