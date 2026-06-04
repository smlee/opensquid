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
 *       models.yaml            ← optional, FOLDED IN (PR-followup)
 *       channels.yaml          ← optional, Phase 2.4+ consumer
 *       notifications.yaml     ← optional, Phase 2.4+ consumer
 *       drift_response.yaml    ← optional, FOLDED IN (PR-followup)
 *       chat_agent.yaml        ← optional, FOLDED IN (WAB.6)
 *       skills/
 *         <skill-name>/skill.yaml
 *
 * This loader is the *only* read path for a pack folder. It does these things:
 *
 *   1. Parse `manifest.yaml` through `parseYamlFile` + the `Manifest` schema —
 *      the four required fields (name/version/scope/goal) plus defaulted rest.
 *   2. Scan `skills/` (if present) for sub-directories containing a
 *      `skill.yaml` and parse each through the `Skill` schema.
 *   3. PR-followup: parse `models.yaml` (if present) → `Pack.models` so the
 *      LLM-primitive resolver can consult pack-declared aliases.
 *   4. PR-followup: parse `drift_response.yaml` (if present) → `Pack.driftResponse`
 *      so the hook dispatcher can resolve per-rule + default policies instead
 *      of hard-coding `block_tool`.
 *
 * Side files `channels.yaml` / `notifications.yaml` remain orthogonal config
 * consumers (per the original spec risk callout 2) — they wire in via the
 * notification router when that subsystem lands. The two folded-in side
 * files above ARE pack-identity-relevant (model aliases shape rule eval;
 * drift policies shape dispatcher output), so they belong on the Pack.
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

import { readdir, stat, readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse as yamlParse } from 'yaml';
import type { z } from 'zod';

import type { Pack } from '../runtime/types.js';

import type { EngineClient } from '../engine/client.js';

import { ChatAgentSchema, type ChatAgentConfig } from './schemas/chat_agent.js';
import { DriftResponseConfig } from './schemas/drift_response.js';
import { Manifest } from './schemas/manifest.js';
import { ModelsConfig } from './schemas/models.js';
import { Skill } from './schemas/skill.js';
import { Team } from './schemas/team.js';
import { getLivingPackVersion } from './living_pack.js';
import { ingestSeedLessons } from './seed_lessons_ingest.js';
import { compileVerifyGates } from './verify_gates_compiler.js';
import { compileGuards } from './guards_compiler.js';
import { compileFlows, type FlowExpansion } from './flows_compiler.js';
import { Fsm, validateFsm } from '../runtime/fsm.js';
import { parseYamlFile } from './yaml.js';

// alias to keep the inline team-load block readable
const fs = { readFile: fsReadFile };

// Local type aliases — `z.ZodType<T>` (the constraint inside `parseYamlFile`)
// erases the input-vs-output distinction Zod tracks, so the inferred `T` ends
// up matching the schema's *input* shape (where `.default(...)` fields are
// optional). `z.infer<typeof Schema>` recovers the post-parse *output* shape —
// where defaults have already been applied and the field types are non-optional.
// We use these throughout the loader so the returned `Pack` and intermediate
// `Skill[]` line up with the runtime types declared in `runtime/types.ts`.
type ManifestOutput = z.infer<typeof Manifest>;
type SkillOutput = z.infer<typeof Skill>;
type ModelsConfigOutput = z.infer<typeof ModelsConfig>;
type DriftResponseConfigOutput = z.infer<typeof DriftResponseConfig>;

// ---------------------------------------------------------------------------
// loadPack — public entry point
//
// Returns a fully-typed `Pack` (runtime shape). `extends` is omitted (not set
// to `undefined`) when the manifest doesn't declare it — `exactOptionalPropertyTypes`
// in tsconfig.json treats `{ extends: undefined }` and `{}` as different types,
// so we conditionally spread to avoid that mismatch.
// ---------------------------------------------------------------------------

export interface LoadPackDeps {
  /**
   * Optional engine client. When present, DOG.3 seed_lessons are ingested
   * fire-and-forget via `engine.lessonCreate`. Absent (test path, engine
   * not yet handshaked) → seeds are stored on `Pack.seedLessons` but not
   * ingested; next loadPack with `deps.engine` will UPSERT them.
   */
  engine?: EngineClient;
}

export async function loadPack(dir: string, deps?: LoadPackDeps): Promise<Pack> {
  const manifestPath = join(dir, 'manifest.yaml');
  const { data } = await parseYamlFile(manifestPath, Manifest);
  // Re-cast to the schema's output type (see ManifestOutput comment above).
  const manifest = data as ManifestOutput;

  const skillsDir = join(dir, 'skills');
  const skills = await loadSkillsDir(skillsDir);

  // DOG.3 — compile verify_gates -> synthetic skill `<pack>/verify`. Errors
  // throw loudly with offending gate name so pack authors get clear feedback.
  if (manifest.verify_gates.length > 0) {
    const compileResult = compileVerifyGates(manifest.name, manifest.verify_gates);
    if (!compileResult.ok) {
      const details = compileResult.errors.map((e) => `${e.gateName}: ${e.message}`).join('; ');
      throw new Error(`pack ${manifest.name}: verify_gates compile errors: ${details}`);
    }
    if (compileResult.skill.rules.length > 0) {
      skills.push(compileResult.skill);
    }
  }

  // T-PACK-FSM-STANDARDIZATION slice B — compile guards -> synthetic skill
  // `<pack>/guards` (the reusable detect→verdict gate template). Same fail-loud
  // contract as verify_gates: a bad `when` expression throws with the guard
  // name. Empty-rule skills are filtered to keep dispatcher noise low.
  if (manifest.guards.length > 0) {
    const guardsResult = compileGuards(manifest.name, manifest.guards);
    if (!guardsResult.ok) {
      const details = guardsResult.errors.map((e) => `${e.guardName}: ${e.message}`).join('; ');
      throw new Error(`pack ${manifest.name}: guards compile errors: ${details}`);
    }
    if (guardsResult.skill.rules.length > 0) {
      skills.push(guardsResult.skill);
    }
  }

  // DOG.5 — read living-pack version triple from LP.1's version.json. Pure
  // file read; null when pack isn't user-installed.
  const livingVersion = await getLivingPackVersion(manifest.name);

  // DOG.3 — ingest seed_lessons (fire-and-forget; engine may be absent in
  // tests). Per-seed failures are LOGGED, never thrown; loadPack never
  // fails for engine-availability reasons.
  if (deps?.engine !== undefined && manifest.seed_lessons.length > 0) {
    const engine = deps.engine;
    void ingestSeedLessons(
      manifest.name,
      manifest.version,
      manifest.seed_lessons,
      engine,
      dir,
    ).then(
      (r) => {
        if (r.failed.length > 0) {
          console.warn(
            `opensquid pack ${manifest.name}: seed-ingest had ${String(r.failed.length)} failures (engine reachable?):`,
            r.failed,
          );
        }
      },
      (e: unknown) => {
        console.warn(
          `opensquid pack ${manifest.name}: seed-ingest pipeline blew up:`,
          e instanceof Error ? e.message : String(e),
        );
      },
    );
  }

  // chat_agent.yaml — WAB.6 chat-agent binding side-file. OPTIONAL: absence
  // (ENOENT) is the bind-time signal for "fall back to built-in defaults in
  // pack_binding.ts". Any other read/parse error surfaces verbatim — a
  // malformed `chat_agent.yaml` is a configuration bug, not a missing file.
  const chatAgent = await loadOptionalChatAgent(join(dir, 'chat_agent.yaml'));

  // models.yaml — PR-followup model-alias side-file. OPTIONAL: absence
  // (ENOENT) means the pack ships no abstract aliases and the model
  // resolver should fall back to env-var + user-level config only. Any
  // other read/parse error surfaces verbatim — a malformed `models.yaml`
  // is a configuration bug, not a missing file.
  const models = await loadOptionalModels(join(dir, 'models.yaml'));

  // drift_response.yaml — PR-followup drift-policy side-file. OPTIONAL:
  // absence (ENOENT) means the runtime dispatcher should fall back to its
  // Phase 1 conservative default (`block_tool`) — preserves pre-PR-followup
  // behavior for packs that don't ship the file. Same parse-error contract.
  const driftResponse = await loadOptionalDriftResponse(join(dir, 'drift_response.yaml'));

  // fsm.yaml — T-PACK-FSM-STANDARDIZATION slice A2 pack-lifecycle FSM side-file.
  // OPTIONAL: absence (ENOENT) → the pack declares no lifecycle FSM (undefined).
  // When present it MUST be a valid total-transition FSM — validateFsm errors
  // (a transition targeting an undeclared state, etc.) throw at load with the
  // offending detail, so a malformed lifecycle is a loud config bug, not a
  // silently-ignored file.
  // T-FC2 — compile `flows:` templates into an FSM fragment, merged into the
  // fsm.yaml machine BEFORE validateFsm so totality holds on the expanded FSM.
  // Fail loud on an unknown template / bad params (mirrors guards compile above).
  const flowsResult = compileFlows(manifest.name, manifest.flows);
  if (!flowsResult.ok) {
    throw new Error(flowsResult.errors.join('; '));
  }
  const fsm = await loadOptionalFsm(join(dir, 'fsm.yaml'), flowsResult.expansion);

  // MM.1 (2026-05-30) — team.yaml existence check for profession-mode packs.
  // `usage: profession | both` REQUIRES team.yaml declaring ≥1 SubagentRole.
  // MM.2 (2026-05-30) extends this: actually LOAD + parse the team.yaml so
  // the dispatcher's profession-directive validator can validate against it
  // without re-reading at dispatch time.
  let team: Team | undefined;
  if (manifest.usage === 'profession' || manifest.usage === 'both') {
    const teamPath = join(dir, 'team.yaml');
    try {
      await stat(teamPath);
    } catch {
      throw new Error(
        `pack ${manifest.name}: usage: ${manifest.usage} REQUIRES team.yaml at ${teamPath} declaring ≥1 SubagentRole (none found)`,
      );
    }
    try {
      const raw = await fs.readFile(teamPath, 'utf8');
      const parsed = yamlParse(raw) as unknown;
      team = Team.parse(parsed);
    } catch (e) {
      throw new Error(
        `pack ${manifest.name}: team.yaml at ${teamPath} failed to parse — ${String(e)}`,
      );
    }
  }

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
    // IDF.1 (2026-05-30) — fold the 3 new optional manifest fields into the
    // runtime Pack. `foundation` stays optional (undefined when manifest
    // omits); `activationScope` + `detectedBy` always present via Zod
    // defaults applied at parse time.
    activationScope: manifest.activation_scope,
    detectedBy: manifest.detected_by,
    ...(manifest.foundation !== undefined ? { foundation: manifest.foundation } : {}),
    // MM.1 (2026-05-30) — kind/usage/includes always present via Zod defaults
    // (focused / active / []).
    kind: manifest.kind,
    usage: manifest.usage,
    includes: manifest.includes,
    // MM.2 — loaded team.yaml (present iff usage is profession | both).
    ...(team !== undefined ? { team } : {}),
    // DOG.3 — manifest schema-sugar blocks hoisted onto runtime Pack so
    // downstream consumers (audit-trail surface, future fixture sync)
    // can read without re-parsing manifest YAML.
    seedLessons: manifest.seed_lessons,
    verifyGates: manifest.verify_gates,
    guards: manifest.guards,
    // DOG.5 — living-pack version triple from LP.1's version.json (if
    // user-installed). Built-in packs without a personal_revision dir
    // get undefined here.
    ...(livingVersion !== null ? { livingVersion } : {}),
    ...(manifest.extends !== undefined ? { extends: manifest.extends } : {}),
    ...(chatAgent !== undefined ? { chatAgent } : {}),
    ...(models !== undefined ? { models } : {}),
    ...(driftResponse !== undefined ? { driftResponse } : {}),
    ...(fsm !== undefined ? { fsm } : {}),
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
// loadOptionalModels — read + validate `models.yaml` if present.
//
// PR-followup: same ENOENT-as-absent contract as `loadOptionalChatAgent`.
// Absent file → `undefined`. Parse/schema errors propagate verbatim via
// `parseYamlFile`'s path-bearing error messages so the user can blame the
// right file + alias. Re-cast to the schema's output type so defaults (e.g.
// `args: []`, `description: ''`) are visible to the runtime.
// ---------------------------------------------------------------------------

async function loadOptionalModels(path: string): Promise<ModelsConfigOutput | undefined> {
  try {
    const { data } = await parseYamlFile(path, ModelsConfig);
    return data as ModelsConfigOutput;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// loadOptionalDriftResponse — read + validate `drift_response.yaml` if present.
//
// PR-followup: same ENOENT-as-absent contract. The schema is `.strict()` so a
// typo at the top level (e.g. `defualt:`) fails loudly — important for a
// safety-critical file. Absent file → `undefined`; the dispatcher then falls
// back to the Phase 1 conservative `block_tool` default in code (NOT the
// schema's `block_tool` default — that only fires when the file IS present
// but omits the field). Keeping the two paths separate means "no file at all"
// is a distinct signal from "file present with explicit defaults" — useful
// for the setup-UI diagnostic ("pack X declares no drift_response policy").
// ---------------------------------------------------------------------------

async function loadOptionalDriftResponse(
  path: string,
): Promise<DriftResponseConfigOutput | undefined> {
  try {
    const { data } = await parseYamlFile(path, DriftResponseConfig);
    return data as DriftResponseConfigOutput;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// loadOptionalFsm — read + validate `fsm.yaml` if present (slice A2).
//
// ENOENT → `undefined` (the pack declares no lifecycle FSM). The `Fsm` zod
// schema validates shape; `validateFsm` then enforces TOTALITY (every
// transition lands on a declared state, initial is declared). A validation
// failure throws a path-bearing error so an invalid lifecycle is loud at load
// — never a silently-ignored machine. parseYamlFile threads the file path into
// shape/parse errors; we prefix totality errors with the path ourselves.
// ---------------------------------------------------------------------------

async function loadOptionalFsm(
  path: string,
  flowExpansion?: FlowExpansion,
): Promise<Fsm | undefined> {
  let fsm: Fsm | undefined;
  try {
    const { data } = await parseYamlFile(path, Fsm);
    fsm = data as Fsm;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') fsm = undefined;
    else throw e;
  }
  if (fsm === undefined) {
    // FC.2: flows AUGMENT a base FSM — a `flows:` block with no fsm.yaml has
    // nothing to merge into, which is a loud config bug, not a silent no-op.
    if (
      flowExpansion !== undefined &&
      (flowExpansion.states.length > 0 || flowExpansion.transitions.length > 0)
    ) {
      throw new Error(`${path}: flows: declared but no fsm.yaml to merge into`);
    }
    return undefined;
  }
  // FC.2: merge the compiled flow fragment (dedup states, append transitions)
  // BEFORE validateFsm so totality is checked on the EXPANDED machine.
  if (flowExpansion !== undefined) {
    const states = [...fsm.states];
    for (const s of flowExpansion.states) if (!states.includes(s)) states.push(s);
    fsm = { ...fsm, states, transitions: [...fsm.transitions, ...flowExpansion.transitions] };
  }
  const errors = validateFsm(fsm);
  if (errors.length > 0) {
    throw new Error(`${path}: invalid FSM — ${errors.join('; ')}`);
  }
  return fsm;
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
