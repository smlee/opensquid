/**
 * MCP: server entrypoint and tool registration that exposes the runtime to
 * Claude Code and other MCP hosts.
 *
 * The actual server lives in `server.ts` (wired as the `opensquid-mcp` bin
 * in package.json). Tool handlers live under `tools/`. This re-export gives
 * downstream importers a stable public surface — they get the handler types
 * without depending on the server's stdio plumbing.
 *
 * Imports from: anything in src/ (top of the dependency tree alongside setup/).
 * Imported by: nothing in src/.
 */

export { handleInspectSkill } from './tools/inspect-skill.js';
export type { InspectSkillArgs } from './tools/inspect-skill.js';
export { handleListPacks } from './tools/list-packs.js';
export { handleListSkills } from './tools/list-skills.js';
export type { ListSkillsArgs } from './tools/list-skills.js';
export { handleReadState } from './tools/read-state.js';
export type { ReadStateArgs } from './tools/read-state.js';
export { handleReadViolations } from './tools/read-violations.js';
