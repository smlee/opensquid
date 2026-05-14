/**
 * Origination metadata auto-detection — v0.4 Phase 1.
 *
 * Builds the `MemoryOrigin` block opensquid attaches to every
 * `memorize` call. The engine treats it as opaque-ish data (typed
 * struct with all-optional fields); the wedge gate consumes
 * `session_id` for v0.4+ multi-session reproducibility scoring.
 *
 * Detection priority per field:
 *
 * - `host`           — `OPENSQUID_HOST` env (explicit override) ->
 *                      `claude-code` heuristic (CLAUDE_CODE_* / ANTHROPIC_*
 *                      env presence) -> `unknown`.
 * - `session_id`     — `CLAUDE_SESSION_ID` env -> fallback opaque
 *                      `sha1(start_time + pid)[:8]` (stable per
 *                      process, not per conversation — documented).
 * - `model`          — `OPENSQUID_MODEL` env -> `ANTHROPIC_MODEL` env ->
 *                      undefined (omitted).
 * - `cwd_basename`   — `path.basename(process.cwd())` always.
 * - `written_at`     — `new Date().toISOString()` always.
 *
 * Privacy invariant (mirrors engine-side docs): NEVER emit full file
 * paths, raw transcript content, or user identity. `session_id` is
 * opaque — the raw transcript path is hashed before truncation.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";

import type { MemoryOrigin } from "./engine-client.js";

/**
 * Process-lifetime fallback session id. Computed once at module load
 * so all memorize calls from one opensquid subprocess share the same
 * id when no host-provided id is available.
 */
const FALLBACK_SESSION_ID = computeFallbackSessionId();

function computeFallbackSessionId(): string {
  const seed = `${Date.now()}.${process.pid}.${Math.random()}`;
  return createHash("sha1").update(seed).digest("hex").slice(0, 8);
}

function detectHost(): string {
  if (process.env.OPENSQUID_HOST) return process.env.OPENSQUID_HOST;
  // Claude Code exposes a handful of CLAUDE_* env vars when it spawns
  // an MCP child. Probe for any of them as a soft signal.
  if (
    process.env.CLAUDE_CODE_VERSION ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.env.CLAUDE_SESSION_ID
  ) {
    return "claude-code";
  }
  return "unknown";
}

function detectSessionId(): string {
  const raw = process.env.CLAUDE_SESSION_ID?.trim();
  if (raw) {
    // Hash + truncate so the on-disk id is opaque (not the raw UUID
    // visible elsewhere on the system). Privacy invariant.
    return createHash("sha1").update(raw).digest("hex").slice(0, 8);
  }
  return FALLBACK_SESSION_ID;
}

function detectModel(): string | undefined {
  return (
    process.env.OPENSQUID_MODEL?.trim() ||
    process.env.ANTHROPIC_MODEL?.trim() ||
    undefined
  );
}

function detectCwdBasename(): string {
  return path.basename(process.cwd());
}

/**
 * Build a `MemoryOrigin` block describing the current opensquid
 * process. Called once per `memorize`; cheap (env reads + base
 * conversions). Returns a typed object with all detected fields
 * populated; absent fields stay `undefined` so engine-side
 * `skip_serializing_if = "Option::is_none"` keeps the on-disk YAML
 * tight.
 */
export function detectOrigin(): MemoryOrigin {
  const origin: MemoryOrigin = {
    host: detectHost(),
    session_id: detectSessionId(),
    cwd_basename: detectCwdBasename(),
    written_at: new Date().toISOString(),
  };
  const model = detectModel();
  if (model) origin.model = model;
  return origin;
}

/**
 * Test seam: re-export the stable fallback session id so suites can
 * assert determinism across calls within one process.
 */
export function fallbackSessionId(): string {
  return FALLBACK_SESSION_ID;
}
