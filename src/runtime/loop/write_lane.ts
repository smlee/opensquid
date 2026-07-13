/**
 * write_lane — the LANE MODEL (the #33 successor to advance-action detection).
 *
 * Each FSM stage declares a `writes:` path-glob allowlist in `pack.yaml` (behavior-as-data): the ONLY paths a
 * mutating file-write may target while that stage is current. This module is the pure decision layer the host
 * (`v2_supply.ts`) consults on every tool call:
 *
 *   - a stage with NO lane (`writes` absent/empty) → INERT: the check produces no decision (all writes pass);
 *   - a read (or any non-mutating call) → never blocks (reads are always safe — the design's "reads never block");
 *   - a mutating call with no single extractable file path (a `Bash` mutation) → NOT lane-checked here (the
 *     orchestrator guard owns shell mutations; the lane governs the file-editor tools);
 *   - a mutating file-write whose target is IN the lane → allowed;
 *   - a mutating file-write whose target is OUT of the lane → the blockable case (`outOfLane: true`).
 *
 * This REPLACES the hard-coded `PRE_RESEARCH_REGEX` advance detection: "is this the scope-advance write" becomes
 * "does this write target the scope stage's declared lane" — the same question, now data-driven per pack.
 *
 * Imports from: minimatch, ../guard/orchestrator_guard (isMutatingCall — the ONE mutating-call classifier).
 * Imported by:  ./v2_supply.ts (buildGuardCtx is_advance + the enforceOnly lane block).
 */
import { minimatch } from 'minimatch';

import { toolMatches } from '../../integrations/pi/tool_aliases.js';
import { isMutatingCall } from '../guard/orchestrator_guard.js';

function isFileWriteTool(tool: string): boolean {
  return toolMatches(tool, /^(Write|Edit|NotebookEdit)$/);
}

/**
 * The single file path a file-editor tool targets, or `null` when the call has no such path. `apply_patch` is
 * normalized to a synthetic `Write` with `file_path` upstream (pre-tool-use.ts), so it too reaches here as a
 * `Write`. A `Bash` mutation (`sed -i`, `>`) has no single `file_path` → `null` (governed by the orchestrator
 * guard, not the lane).
 */
export function extractWritePath(tool: string, args: Record<string, unknown>): string | null {
  if (!isFileWriteTool(tool)) return null;
  const a = args as { file_path?: unknown; notebook_path?: unknown };
  const fp = typeof a.file_path === 'string' ? a.file_path : a.notebook_path;
  return typeof fp === 'string' && fp.length > 0 ? fp : null;
}

/**
 * True when `path` matches any lane glob. Globs are repo-relative (`docs/research/*pre-research*`); a live tool
 * call may present an ABSOLUTE path (`/repo/docs/research/…`), so each glob is matched both directly AND under a
 * `**​/` anchor so a repo-relative lane matches an absolute path at any depth. Empty globs → matches nothing.
 * `{ dot: true }` so dotfiles/dot-dirs (`.opensquid/…`) are matchable.
 */
export function matchesLane(path: string, globs: readonly string[]): boolean {
  return globs.some(
    (g) => minimatch(path, g, { dot: true }) || minimatch(path, `**/${g}`, { dot: true }),
  );
}

export interface LaneVerdict {
  /** True only when the lane produced a real decision: the stage declares a lane AND this is a mutating file-write. */
  checked: boolean;
  /** The target file path (null when the call is not a single-path file-write). */
  path: string | null;
  /** True when a CHECKED write falls OUTSIDE the declared lane — the blockable case. */
  outOfLane: boolean;
}

const INERT: LaneVerdict = { checked: false, path: null, outOfLane: false };

/**
 * Evaluate a tool call against a stage's declared write-lane. Pure + total — see the module header for the five
 * cases. The caller decides whether to block (automation enforcement lives in the host, not here); actor
 * identity does not exempt a selected pack's lane. This function only classifies the write against that lane.
 */
export function evaluateLane(
  writes: readonly string[] | undefined,
  tool: string,
  args: Record<string, unknown>,
): LaneVerdict {
  if (writes === undefined || writes.length === 0) return INERT; // no lane declared → INERT (all writes pass)
  if (!isMutatingCall(tool, args)) return INERT; // reads never block
  const path = extractWritePath(tool, args);
  if (path === null) return INERT; // a Bash mutation → orchestrator guard's concern, not the lane
  return { checked: true, path, outOfLane: !matchesLane(path, writes) };
}

/** The block message shown when a write falls outside the current stage's lane. */
export function laneBlockMessage(stage: string, path: string, writes: readonly string[]): string {
  return (
    `🦑 [write-lane] the ${stage} stage may write only: ${writes.join(', ')} — ` +
    `"${path}" is out of lane. Stay in this stage's lane, or advance the flow to the stage that owns this path.`
  );
}
