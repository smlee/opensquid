/**
 * `list_packs` MCP tool — newline-separated list of currently active packs.
 *
 * Phase 1: `loadActivePacks` is a stub returning `[]` (Task 1.19 wires the
 * real loader). This tool therefore reports "no packs loaded" until that
 * lands. The shape stays stable: when the loader fills in, the same text-
 * formatting code consumes real `Pack[]` values.
 *
 * Inputs: none.
 * Output: text content. Either `no packs loaded` (Phase 1 stub case) or
 * one pack name per line. Pack names only — version + scope + goal stay
 * inside `inspect_skill` so this tool stays glanceable in the MCP client.
 *
 * Imports from: runtime/bootstrap.
 * Imported by: mcp/server.ts (handler map).
 */

import { loadActivePacks } from '../../runtime/bootstrap.js';

export async function handleListPacks(): Promise<string> {
  const sessionId = process.env.CLAUDE_SESSION_ID ?? 'unknown';
  const packs = await loadActivePacks(sessionId);
  if (packs.length === 0) return 'no packs loaded';
  return packs.map((p) => p.name).join('\n');
}
