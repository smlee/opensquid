/**
 * `list_skills` MCP tool — list skills across active packs, optionally
 * filtered to a single pack name.
 *
 * Phase 1: backed by the `loadActivePacks` stub which returns `[]` — so this
 * tool reports "no skills loaded" until Task 1.19's loader lands. The output
 * format is one line per skill, prefixed with the pack name as `pack/skill`
 * so a glance shows ownership without a second `inspect_skill` round-trip.
 *
 * Args:
 *   - `pack` (optional string) — limit to skills owned by this pack. An
 *     unknown pack name is NOT an error: it returns the empty/unknown text
 *     so the MCP client can drive `list_packs` to recover.
 *
 * Imports from: runtime/bootstrap.
 * Imported by: mcp/server.ts (handler map).
 */

import { loadActivePacks } from '../../runtime/bootstrap.js';

export interface ListSkillsArgs {
  pack?: string;
}

export async function handleListSkills(args: ListSkillsArgs): Promise<string> {
  const sessionId = process.env.CLAUDE_SESSION_ID ?? 'unknown';
  const packs = await loadActivePacks(sessionId);
  const filtered = args.pack ? packs.filter((p) => p.name === args.pack) : packs;
  if (filtered.length === 0) {
    if (args.pack) return `no skills loaded (pack "${args.pack}" not active)`;
    return 'no skills loaded';
  }
  const lines: string[] = [];
  for (const p of filtered) {
    for (const s of p.skills) {
      lines.push(`${p.name}/${s.name}`);
    }
  }
  if (lines.length === 0) return 'no skills loaded';
  return lines.join('\n');
}
