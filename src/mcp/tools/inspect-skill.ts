/**
 * `inspect_skill` MCP tool — show a specific skill's rules + load mode +
 * load conditions + (when wired) drift-response policy.
 *
 * Output is plain text (not JSON) so the MCP client renders it in-line
 * without secondary formatting. Sections are separated by blank lines and
 * labelled with capitalized headers, matching how Anthropic plugin SKILL.md
 * files read — the goal is fast human triage from a Claude Code thread.
 *
 * Phase 1: relies on `loadActivePacks` stub (Task 1.19 fills it). Returns a
 * "not found" message when the pack or skill isn't active. Drift-response
 * policy is reported as `(not declared)` because Task 1.19 wires the pack
 * manifest's `drift_response:` section into the runtime — until then there
 * is no per-pack policy to surface.
 *
 * Args:
 *   - `pack` (required string)
 *   - `skill` (required string)
 *
 * Imports from: runtime/bootstrap.
 * Imported by: mcp/server.ts (handler map).
 */

import { loadActivePacks } from '../../runtime/bootstrap.js';
import type { Rule, Skill } from '../../runtime/types.js';

export interface InspectSkillArgs {
  pack: string;
  skill: string;
}

function formatRule(rule: Rule): string {
  if (rule.kind === 'destination_check') {
    // Phase 4: destination_check rules don't have a process step list — they
    // fire via the dedicated `check_destination` primitive on the scheduler
    // tick. Surface the interval + model alias so MCP triage shows the
    // periodic firing cadence at a glance.
    return [
      `  - id: ${rule.id} (${rule.kind})`,
      `    every: ${String(rule.interval.every_n_tool_calls)} tool calls`,
      `    model: ${rule.model_alias}`,
    ].join('\n');
  }
  const stepLines = rule.process.map((step, i) => `    ${i}. ${step.call}`);
  return `  - id: ${rule.id} (${rule.kind})\n${stepLines.join('\n')}`;
}

function formatSkill(packName: string, skill: Skill): string {
  const whenToLoad = skill.when_to_load.length === 0 ? '(none)' : String(skill.when_to_load.length);
  const unloadsWhen =
    skill.unloads_when.length === 0 ? '(none)' : String(skill.unloads_when.length);
  const rulesBlock =
    skill.rules.length === 0 ? '  (no rules)' : skill.rules.map(formatRule).join('\n');
  return [
    `Pack: ${packName}`,
    `Skill: ${skill.name}`,
    `Load mode: ${skill.load}`,
    `When-to-load conditions: ${whenToLoad}`,
    `Unloads-when conditions: ${unloadsWhen}`,
    `Drift response: (not declared)`,
    ``,
    `Rules:`,
    rulesBlock,
  ].join('\n');
}

export async function handleInspectSkill(args: InspectSkillArgs): Promise<string> {
  const sessionId = process.env.CLAUDE_SESSION_ID ?? 'unknown';
  const packs = await loadActivePacks(sessionId);
  const pack = packs.find((p) => p.name === args.pack);
  if (!pack) return `pack "${args.pack}" not active`;
  const skill = pack.skills.find((s) => s.name === args.skill);
  if (!skill) return `skill "${args.skill}" not found in pack "${args.pack}"`;
  return formatSkill(pack.name, skill);
}
