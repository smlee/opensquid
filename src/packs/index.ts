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

// Pack folder loader (Task 2.3) — read a directory on disk into a typed `Pack`.
// Reads `manifest.yaml` + scans `skills/<name>/skill.yaml`. Side-files
// (models/channels/notifications/drift_response) live in separate consumers.
export { loadPack } from './loader.js';

// Function-reference validation (Task 2.4) — confirm every `process[*].call`
// resolves to a registered primitive. Returns issues (with optional typo
// suggestions); never throws so the orchestrator can collect across packs.
export { validatePackFunctions } from './validate_functions.js';
export type { ValidationIssue } from './validate_functions.js';

// Skill-name uniqueness validation (Task 2.5) — run at load-orchestrator time
// over every loaded pack; surfaces collisions without auto-resolving per
// design doc §"Conflict resolution policy".
export { validateUniqueSkillNames } from './validate_uniqueness.js';
export type { UniquenessIssue } from './validate_uniqueness.js';

// Scope-precedence pack ordering (Task 5.1) — stable sort by scope index
// (universal → domain → specialty → workflow → project) then alphabetical
// by name. Pure function consumed by the load-orchestrator.
export { sortPacksByScope } from './load_order.js';

// `extends:` mechanism (Task 5.2) — layer a child pack over a parent pack
// with child-wins-on-collision semantics, plus a cycle detector for the
// `extends:` chain. Validation-layer companion to the load orchestrator.
export { applyExtends, detectExtendsCycle } from './apply_extends.js';
