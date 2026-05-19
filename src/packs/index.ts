/**
 * Packs: multi-file pack format loader, manifest resolution, and schema
 * validation for the bundled YAML schemas.
 *
 * Imports from: functions/ (for validation), runtime/ types only.
 * Imported by: runtime/, setup/, mcp/.
 */

export * from './schemas/index.js';

// YAML parser layer (Task 2.2) — single load boundary for pack-config YAML.
// `parseYamlFile<T>` validates with a Zod schema and returns both the parsed
// data + the underlying `Document.Parsed` for comment-preserving writeback.
export { parseYamlFile, parseYamlString, serializeYamlDocument } from './yaml.js';
export type { ParsedYaml } from './yaml.js';
