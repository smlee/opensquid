/**
 * Anchor this MCP server process to the host-declared project dir.
 *
 * The spawn cwd of a stdio MCP server is HOST-controlled: Claude spawns with
 * cwd == CLAUDE_PROJECT_DIR (observed 7/7 live servers, 2026-06-10), codex
 * (and any other host) makes no such guarantee. Every cwd-derived behavior in
 * this process — recall-scope namespace resolution (rag/scope.ts), umbrella
 * routing fallback (chat-bridge-server.ts) — must not depend on the host's
 * choice, so the convention is normalized once at the process boundary: chdir
 * to CLAUDE_PROJECT_DIR when the host declares it.
 *
 * Fail-loud contract: a bad dir throws (ENOENT/ENOTDIR) → startup death the
 * host reports, never a silently wrong memory namespace.
 *
 * Imports from: nothing (node globals only).
 * Imported by: mcp/server.ts, mcp/chat-bridge-server.ts (first call in main()).
 */

/** chdir to CLAUDE_PROJECT_DIR when set; no-op when unset/empty; throws on a bad dir. */
export function anchorProcessToProjectDir(): void {
  const dir = process.env.CLAUDE_PROJECT_DIR;
  if (dir === undefined || dir === '') return;
  process.chdir(dir);
}
