/**
 * `opensquid codex <subcommand>` — codex management CLI.
 *
 * Subcommands:
 *   install <path>   — read codex.yaml at <path>, validate, copy into
 *                      ~/.opensquid/codexes/<id>/
 *   list             — list all installed codex ids
 *   remove <id>      — uninstall a codex (filesystem only — engine
 *                      seeded lessons are retired separately)
 *   doctor [<id>]    — report install status; with id, show one codex
 *
 * Engine seeding integration (calling engine.lesson.create with
 * authored_by: Pack(<id>)) happens at activation time via the
 * orchestrator (O3), not here. This CLI is filesystem-only.
 *
 * Source kinds in v0.4:
 *   - local path (relative or absolute) — implemented here
 *   - git URL          — deferred to O3 (clone-then-install)
 *   - http URL         — deferred to O3
 *   - foreign format   — deferred to O3 (LLM-mediated conversion)
 *   - --from "<desc>"  — deferred to O3 (LLM-generated)
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { appendPromotedLessonToClaudeMd } from "../claude-md.js";
import { OpenSquidEngine } from "../engine-client.js";
import {
  CodexStoreError,
  codexDir,
  codexesDir,
  getCodex,
  installCodex,
  listCodexes,
  removeCodex,
  resolveDataRoot,
} from "./store.js";
import { parseCodexYaml } from "./parse.js";
import { type Codex, type CodexSeedLesson, isCompositeCodex, isFocusedCodex } from "./types.js";

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

export class CodexCliError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "CodexCliError";
  }
}

// ---------------------------------------------------------------------
// Source loaders
// ---------------------------------------------------------------------

/**
 * Read + parse codex.yaml from a local directory or file path.
 * Returns the parsed codex + the resolved root directory of the source.
 */
async function loadCodexFromPath(source: string): Promise<{ codex: Codex; sourceRoot: string }> {
  const abs = path.resolve(source);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new CodexCliError(
      `source path not found: ${abs}`,
      "pass a directory containing codex.yaml, or a path to codex.yaml directly",
    );
  }

  let manifestPath: string;
  let sourceRoot: string;
  if (stat.isDirectory()) {
    manifestPath = path.join(abs, "codex.yaml");
    sourceRoot = abs;
  } else {
    manifestPath = abs;
    sourceRoot = path.dirname(abs);
  }

  let content: string;
  try {
    content = await fs.readFile(manifestPath, "utf8");
  } catch {
    throw new CodexCliError(
      `codex.yaml not found at ${manifestPath}`,
      "the source must contain codex.yaml at the root",
    );
  }

  let codex: Codex;
  try {
    codex = parseCodexYaml(content);
  } catch (err) {
    throw new CodexCliError(
      `codex.yaml validation failed: ${err instanceof Error ? err.message : String(err)}`,
      "check the manifest against opensquid v0.6 codex schema",
    );
  }

  return { codex, sourceRoot };
}

/**
 * Recursively copy a directory tree, preserving relative structure.
 * Skips the source codex.yaml (we wrote a canonical version already).
 * Used to bring lesson markdown bodies + companion files into the
 * canonical codex storage directory.
 */
async function copyCodexContent(sourceRoot: string, destRoot: string): Promise<void> {
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  await fs.mkdir(destRoot, { recursive: true });
  for (const entry of entries) {
    // Skip the source manifest — installCodex already wrote a canonical one.
    if (entry.name === "codex.yaml") continue;
    const src = path.join(sourceRoot, entry.name);
    const dst = path.join(destRoot, entry.name);
    if (entry.isDirectory()) {
      await fs.cp(src, dst, { recursive: true });
    } else if (entry.isFile()) {
      await fs.copyFile(src, dst);
    }
    // Symlinks / specials silently skipped — codexes shouldn't have them.
  }
}

// ---------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------

interface CliOptions {
  rootDir?: string;
  force?: boolean;
  /** Skip seeding lessons into the engine (filesystem-only install). */
  skipSeed?: boolean;
  /**
   * Optional override for the CLAUDE.md auto-publish target. Defaults to
   * `~/.claude/CLAUDE.md` via `defaultClaudeMdPath()` in claude-md.ts.
   * Tests inject a tmp path here. CLI users have no flag for this — they
   * always write to the canonical global path.
   */
  claudeMdPath?: string;
  /**
   * Skip the CLAUDE.md auto-publish step. Tests use this to isolate the
   * engine-seed path from the CLAUDE.md write path. CLI users have no
   * flag — auto-publish always runs.
   */
  skipClaudeMdPublish?: boolean;
}

async function cmdInstall(args: string[], opts: CliOptions): Promise<void> {
  const source = args[0];
  if (!source) {
    throw new CodexCliError(
      "usage: opensquid codex install <path>",
      "pass a directory containing codex.yaml",
    );
  }
  const { codex, sourceRoot } = await loadCodexFromPath(source);
  const { id, path: destDir } = await installCodex(codex, opts);
  // Composite codexes have no companion content; skip the copy.
  if (isFocusedCodex(codex)) {
    await copyCodexContent(sourceRoot, destDir);
  }
  console.log(`[opensquid codex install] installed ${id} v${codex.version} at ${destDir}`);

  // v0.4: seed lessons into the engine's lesson store so recall surfaces
  // them. Composite codexes have no own lessons — the includes are
  // independent installs (recursive install is a future enhancement).
  if (isFocusedCodex(codex) && codex.seed_lessons && codex.seed_lessons.length > 0) {
    if (opts.skipSeed) {
      console.log(
        `  [seed skipped] ${codex.seed_lessons.length} lesson(s) — pass --no-seed to skip`,
      );
      return;
    }
    await seedLessonsIntoEngine(codex.seed_lessons, codex.id, destDir, opts);
  }
}

/**
 * Iterate the codex's seed lessons and seed each into the engine's
 * lesson store at `promoted` status via `lesson.create` with
 * `authored_by: "pack"` + `seed_as_promoted: true`. The engine treats
 * Pack provenance as user-equivalent (codex install = user authorship).
 */
/**
 * Append a single seeded lesson's one-line summary to the user's
 * CLAUDE.md `opensquid-rules` block. Exported for direct unit testing
 * — covers the auto-publish behavior without spawning the real engine.
 *
 * Returns true if a new line was appended, false if it was an idempotent
 * no-op (lesson id already present, or rules block missing). Failure is
 * non-fatal and logged to stderr — CLAUDE.md is downstream display, not
 * source of truth.
 */
export async function publishSeededLessonToClaudeMd(
  args: {
    /** The engine-assigned `les-...` id for the seeded lesson. */
    engineLessonId: string | undefined;
    /** Human-readable description (typically `${trigger} (codex:${codexId})`). */
    description: string;
    /** ISO timestamp; defaults to now if engine doesn't return one. */
    createdAt: string;
    /** Codex-local lesson id, used only for error logging context. */
    codexLessonId: string;
  },
  options: { target?: string } = {},
): Promise<boolean> {
  if (!args.engineLessonId) return false;
  try {
    const writeResult = await appendPromotedLessonToClaudeMd(
      {
        id: args.engineLessonId,
        description: args.description,
        promoted_at: args.createdAt,
      },
      { target: options.target },
    );
    return writeResult?.appended ?? false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [claude-md publish failed] ${args.codexLessonId}: ${msg}`);
    return false;
  }
}

async function seedLessonsIntoEngine(
  seedLessons: CodexSeedLesson[],
  codexId: string,
  codexDestDir: string,
  opts: CliOptions = {},
): Promise<void> {
  const engine = new OpenSquidEngine();
  let ok = 0;
  let failed = 0;
  let published = 0;
  try {
    for (const lesson of seedLessons) {
      try {
        const bodyPath = path.join(codexDestDir, lesson.body_path);
        const body = await fs.readFile(bodyPath, "utf8");
        const trigger =
          typeof lesson.trigger === "string"
            ? lesson.trigger
            : (lesson.trigger.prescriptive_form ?? lesson.trigger.intent);
        const result = await engine.createLesson({
          description: `${trigger} (codex:${codexId})`,
          body,
          authored_by: "pack",
          pack_id: codexId,
          seed_as_promoted: true,
        });
        ok++;

        // #116: auto-publish to CLAUDE.md so the promoted-lesson tier
        // stays visible to the agent's system prompt without a recall
        // round-trip. Mirrors the `lesson.promote` MCP tool's behavior.
        if (!opts.skipClaudeMdPublish) {
          const wasAppended = await publishSeededLessonToClaudeMd(
            {
              engineLessonId: (result as unknown as { id?: string }).id,
              description: `${trigger} (codex:${codexId})`,
              createdAt:
                (result as unknown as { created_at?: string }).created_at ??
                new Date().toISOString(),
              codexLessonId: lesson.id,
            },
            { target: opts.claudeMdPath },
          );
          if (wasAppended) published++;
        }
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [seed failed] ${lesson.id}: ${msg}`);
      }
    }
  } finally {
    engine.shutdown();
  }
  console.log(
    `  [seeded] ${ok}/${seedLessons.length} lesson(s) into engine as promoted` +
      (failed > 0 ? ` (${failed} failed)` : "") +
      (published > 0 ? `; ${published} appended to CLAUDE.md` : ""),
  );
}

async function cmdList(_args: string[], opts: CliOptions): Promise<void> {
  const ids = await listCodexes(opts);
  if (ids.length === 0) {
    console.log(`[opensquid codex list] no codexes installed at ${codexesDir(opts.rootDir)}`);
    return;
  }
  console.log(`[opensquid codex list] ${ids.length} installed at ${codexesDir(opts.rootDir)}:`);
  for (const id of ids) {
    try {
      const codex = await getCodex(id, opts);
      const kindLabel = isCompositeCodex(codex) ? "composite" : "focused";
      const foundation = isFocusedCodex(codex)
        ? summarizeFoundation(codex)
        : `includes ${(codex as { includes?: { id: string }[] }).includes?.length ?? 0}`;
      console.log(`  • ${id} v${codex.version}  [${kindLabel}]  ${foundation}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  • ${id}  [broken: ${msg}]`);
    }
  }
}

async function cmdRemove(args: string[], opts: CliOptions): Promise<void> {
  const id = args[0];
  if (!id) {
    throw new CodexCliError("usage: opensquid codex remove <id>");
  }
  const removed = await removeCodex(id, opts);
  if (removed) {
    console.log(`[opensquid codex remove] removed ${id}`);
  } else {
    console.log(`[opensquid codex remove] ${id} was not installed — no-op`);
  }
}

async function cmdDoctor(args: string[], opts: CliOptions): Promise<void> {
  const root = resolveDataRoot(opts.rootDir);
  const id = args[0];
  if (id) {
    try {
      const codex = await getCodex(id, opts);
      console.log(`[opensquid codex doctor] ${id}`);
      console.log(`  version:  ${codex.version}`);
      console.log(`  kind:     ${codex.kind ?? "focused"}`);
      console.log(`  location: ${codexDir(id, opts.rootDir)}`);
      if (isFocusedCodex(codex)) {
        console.log(`  foundation: ${summarizeFoundation(codex)}`);
        console.log(`  detected_by: ${(codex.detected_by ?? []).length} signal(s)`);
        console.log(`  seed_lessons: ${(codex.seed_lessons ?? []).length}`);
        console.log(`  verify_gates: ${(codex.verify_gates ?? []).length}`);
      }
      return;
    } catch (err) {
      if (err instanceof CodexStoreError && err.code === "NOT_FOUND") {
        console.log(`[opensquid codex doctor] ${id} is not installed`);
        return;
      }
      throw err;
    }
  }
  const ids = await listCodexes(opts);
  console.log(`[opensquid codex doctor] root: ${root}`);
  console.log(`  installed: ${ids.length}`);
  for (const cid of ids) {
    console.log(`  • ${cid}`);
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function summarizeFoundation(codex: Codex): string {
  if (!isFocusedCodex(codex) || !codex.foundation) return "(none)";
  const parts: string[] = [];
  const f = codex.foundation;
  if (f.tools && f.tools.length > 0) {
    parts.push(`tools=[${f.tools.map((t) => t.name).join(",")}]`);
  }
  if (f.domains && f.domains.length > 0) {
    parts.push(`domains=[${f.domains.join(",")}]`);
  }
  if (f.methodologies && f.methodologies.length > 0) {
    parts.push(`methodologies=[${f.methodologies.join(",")}]`);
  }
  return parts.length === 0 ? "(empty)" : parts.join(" ");
}

function parseFlags(argv: string[]): { args: string[]; opts: CliOptions } {
  const args: string[] = [];
  const opts: CliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") {
      opts.force = true;
    } else if (a === "--no-seed") {
      opts.skipSeed = true;
    } else if (a === "--root" && argv[i + 1]) {
      opts.rootDir = argv[++i];
    } else {
      args.push(a);
    }
  }
  return { args, opts };
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

export type CodexCliCmd = "install" | "list" | "remove" | "doctor";

export async function runCodexCli(cmd: CodexCliCmd, argv: string[]): Promise<void> {
  const { args, opts } = parseFlags(argv);
  switch (cmd) {
    case "install":
      await cmdInstall(args, opts);
      return;
    case "list":
      await cmdList(args, opts);
      return;
    case "remove":
      await cmdRemove(args, opts);
      return;
    case "doctor":
      await cmdDoctor(args, opts);
      return;
  }
}
