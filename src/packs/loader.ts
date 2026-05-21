/**
 * Pack folder loader — turn a directory on disk into a typed `Pack`.
 *
 * Authoritative source: `docs/opensquid-real-design.md` §"Pack format" folder
 * layout + Task 2.3 of `docs/tasks/phase-2-pack-format.md`.
 *
 * A pack on disk looks like:
 *
 *     my-pack/
 *       manifest.yaml          ← required
 *       models.yaml            ← optional, Phase 2.4+ consumer
 *       channels.yaml          ← optional, Phase 2.4+ consumer
 *       notifications.yaml     ← optional, Phase 2.4+ consumer
 *       drift_response.yaml    ← optional, Phase 2.4+ consumer
 *       skills/
 *         <skill-name>/skill.yaml
 *
 * This loader is the *only* read path for a pack folder. It does two things:
 *
 *   1. Parse `manifest.yaml` through `parseYamlFile` + the `Manifest` schema —
 *      the four required fields (name/version/scope/goal) plus defaulted rest.
 *   2. Scan `skills/` (if present) for sub-directories containing a
 *      `skill.yaml` and parse each through the `Skill` schema.
 *
 * Side files (models / channels / notifications / drift_response) are
 * intentionally NOT folded into the returned `Pack` — they belong to
 * orthogonal config consumers (per spec risk callout 2). Phase 2.4+ wires
 * them in via separate loaders so the runtime can compose models + channels
 * + drift response independently from the pack identity.
 *
 * Error surface: every failure flows through `parseYamlFile`, which already
 * threads the source path into both YAML-parse and Zod-validation error
 * messages. The loader just propagates — no extra wrapping needed at this
 * layer. (A structured `PackLoadError` may land in a later task when the
 * setup UI needs to localize messages.)
 *
 * Imports from: node:fs/promises, node:path, schemas/, yaml.ts, runtime/types.
 * Imported by: setup/, runtime bootstrap (Phase 2.4+), test fixtures.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { z } from 'zod';

import type { Pack } from '../runtime/types.js';

import { ChatAgentSchema, type ChatAgentConfig } from './schemas/chat_agent.js';
import { Manifest } from './schemas/manifest.js';
import { Skill } from './schemas/skill.js';
import { parseYamlFile } from './yaml.js';

// Local type aliases — `z.ZodType<T>` (the constraint inside `parseYamlFile`)
// erases the input-vs-output distinction Zod tracks, so the inferred `T` ends
// up matching the schema's *input* shape (where `.default(...)` fields are
// optional). `z.infer<typeof Schema>` recovers the post-parse *output* shape —
// where defaults have already been applied and the field types are non-optional.
// We use these throughout the loader so the returned `Pack` and intermediate
// `Skill[]` line up with the runtime types declared in `runtime/types.ts`.
type ManifestOutput = z.infer<typeof Manifest>;
type SkillOutput = z.infer<typeof Skill>;

// ---------------------------------------------------------------------------
// loadPack — public entry point
//
// Returns a fully-typed `Pack` (runtime shape). `extends` is omitted (not set
// to `undefined`) when the manifest doesn't declare it — `exactOptionalPropertyTypes`
// in tsconfig.json treats `{ extends: undefined }` and `{}` as different types,
// so we conditionally spread to avoid that mismatch.
// ---------------------------------------------------------------------------

export async function loadPack(dir: string): Promise<Pack> {
  const manifestPath = join(dir, 'manifest.yaml');
  const { data } = await parseYamlFile(manifestPath, Manifest);
  // Re-cast to the schema's output type (see ManifestOutput comment above).
  const manifest = data as ManifestOutput;

  const skillsDir = join(dir, 'skills');
  const skills = await loadSkillsDir(skillsDir);

  // chat_agent.yaml — WAB.6 chat-agent binding side-file. OPTIONAL: absence
  // (ENOENT) is the bind-time signal for "fall back to built-in defaults in
  // pack_binding.ts". Any other read/parse error surfaces verbatim — a
  // malformed `chat_agent.yaml` is a configuration bug, not a missing file.
  const chatAgent = await loadOptionalChatAgent(join(dir, 'chat_agent.yaml'));

  return {
    name: manifest.name,
    version: manifest.version,
    scope: manifest.scope,
    goal: manifest.goal,
    description: manifest.description,
    requires: manifest.requires,
    conflicts: manifest.conflicts,
    evolves: manifest.evolves,
    skills,
    ...(manifest.extends !== undefined ? { extends: manifest.extends } : {}),
    ...(chatAgent !== undefined ? { chatAgent } : {}),
  };
}

// ---------------------------------------------------------------------------
// loadOptionalChatAgent — read + validate `chat_agent.yaml` if present.
//
// ENOENT → returns `undefined` (the side-file is OPTIONAL per the WAB.6 spec
// — packs that don't ship one fall back to built-in defaults in
// `pack_binding.ts`). Any other error (YAML parse, schema validation, EACCES)
// propagates verbatim via `parseYamlFile`'s path-bearing error messages so
// the caller can blame the right file + field.
// ---------------------------------------------------------------------------

async function loadOptionalChatAgent(path: string): Promise<ChatAgentConfig | undefined> {
  try {
    const { data } = await parseYamlFile(path, ChatAgentSchema);
    return data as ChatAgentConfig;
  } catch (e) {
    // Node's readFile throws ENOENT as `NodeJS.ErrnoException`. parseYamlFile
    // forwards the underlying error (it wraps YAML + Zod errors but does NOT
    // wrap fs errors), so we test the code on the raw exception.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// loadSkillsDir — scan skills/ for sub-directories with skill.yaml
//
// Behavior notes:
//   - ENOENT on the skills/ directory itself → `[]` (skills/ is optional).
//   - Entries are SORTED alphabetically before processing. `readdir` order is
//     filesystem-dependent — APFS isn't guaranteed alphabetical, ext4 + tmpfs
//     return insertion order. Sorting is what makes load order deterministic
//     across host OSes (spec risk callout 1).
//   - Non-directory entries (stray README.md, .DS_Store, etc.) are silently
//     skipped — only sub-directories with their own `skill.yaml` count.
//   - Symlinks: `stat` follows symlinks by default, so a `skills/foo → /abs/path`
//     symlink whose target is a directory is loaded. This is intentional —
//     documented behavior so users can compose packs by symlinking shared
//     skills (spec risk callout 3).
// ---------------------------------------------------------------------------

async function loadSkillsDir(skillsDir: string): Promise<SkillOutput[]> {
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }

  // Deterministic ordering — see header comment above.
  entries.sort();

  const skills: SkillOutput[] = [];
  for (const e of entries) {
    const skillDir = join(skillsDir, e);
    const st = await stat(skillDir);
    if (!st.isDirectory()) continue;

    const skillYaml = join(skillDir, 'skill.yaml');
    const { data } = await parseYamlFile(skillYaml, Skill);
    // Re-cast to the schema's output type (see ManifestOutput comment above).
    skills.push(data as SkillOutput);
  }
  return skills;
}
