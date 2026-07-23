/**
 * Neutral host-hook timing policy. Both Claude-shaped and Codex-shaped writers
 * project this value; neither adapter owns or duplicates the reviewer margin.
 */

// Twenty seconds above the pack's ten-minute inner reviewer timeout so the
// reviewer returns a readable verdict/failure before the host kills the hook.
export const PRETOOLUSE_HOOK_TIMEOUT_S = 620;
