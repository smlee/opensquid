/**
 * `opensquid project <subcommand>` — project identity CLI.
 *
 * Subcommands:
 *   init [--id <name>]   — create `.opensquid/project.json` at cwd
 *                          (refuses to overwrite without --force)
 *   info                 — print the resolved project + state
 *   list                 — list registered projects from the global
 *                          registry
 *   prune                — sweep registry for entries whose
 *                          `last_seen_path` no longer exists; mark
 *                          them as deleted
 */
import * as crypto from "node:crypto";
import * as path from "node:path";

import {
  applyResolution,
  findProjectCard,
  loadRegistry,
  pruneDeleted,
  resolveProject,
  writeProjectCard,
  type ProjectCard,
} from "./project.js";

export class ProjectCliError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "ProjectCliError";
  }
}

interface CliOptions {
  /** Custom id for `init`. */
  id?: string;
  /** Force-overwrite existing card on `init`. */
  force?: boolean;
}

function parseFlags(argv: string[]): { args: string[]; opts: CliOptions } {
  const args: string[] = [];
  const opts: CliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") {
      opts.force = true;
    } else if (a === "--id" && argv[i + 1]) {
      opts.id = argv[++i];
    } else {
      args.push(a);
    }
  }
  return { args, opts };
}

async function cmdInit(opts: CliOptions): Promise<void> {
  const cwd = process.cwd();
  const existing = await findProjectCard(cwd);
  if (existing && !opts.force) {
    throw new ProjectCliError(
      `project card already exists at ${existing.cardPath}`,
      "use --force to overwrite, or run `opensquid project info` to inspect",
    );
  }

  // If `--id` not passed, use the suggested default (git basename or cwd).
  const resolved = await resolveProject(cwd);
  const suggestedId =
    resolved.kind === "new" ? resolved.suggested_id : (existing?.card.id ?? "project");
  const id = opts.id ?? suggestedId;

  // Build the card directly so we can honor force without going through
  // applyResolution's no-clobber pathway.
  const card: ProjectCard = {
    version: 1,
    id,
    uuid: existing?.card.uuid ?? crypto.randomUUID(),
    created_at: existing?.card.created_at ?? new Date().toISOString(),
  };
  await writeProjectCard(cwd, card, { force: !!existing });
  // Register / refresh in the global registry.
  await applyResolution(cwd, await resolveProject(cwd), { autoCreate: false });

  console.log(`[opensquid project init] wrote ${path.join(cwd, ".opensquid", "project.json")}`);
  console.log(`  id:   ${card.id}`);
  console.log(`  uuid: ${card.uuid}`);
}

async function cmdInfo(): Promise<void> {
  const cwd = process.cwd();
  const resolved = await resolveProject(cwd);
  switch (resolved.kind) {
    case "known": {
      const projectRoot = path.dirname(path.dirname(resolved.cardPath));
      console.log(`[opensquid project info] state: KNOWN`);
      console.log(`  id:           ${resolved.card.id}`);
      console.log(`  uuid:         ${resolved.card.uuid}`);
      console.log(`  created_at:   ${resolved.card.created_at}`);
      console.log(`  project root: ${projectRoot}`);
      console.log(`  card:         ${resolved.cardPath}`);
      return;
    }
    case "moved": {
      const projectRoot = path.dirname(path.dirname(resolved.cardPath));
      console.log(`[opensquid project info] state: MOVED`);
      console.log(`  id:           ${resolved.card.id}`);
      console.log(`  uuid:         ${resolved.card.uuid}`);
      console.log(`  moved from:   ${resolved.from_path}`);
      console.log(`  now at:       ${projectRoot}`);
      console.log(`  hint: run \`opensquid project init --force\` or any memorize call`);
      console.log(`        to update the registry's last-seen path.`);
      return;
    }
    case "new": {
      console.log(`[opensquid project info] state: NEW (no card found)`);
      console.log(`  suggested id: ${resolved.suggested_id}`);
      console.log(`  hint: run \`opensquid project init [--id NAME]\` to claim this dir`);
      return;
    }
  }
}

async function cmdList(): Promise<void> {
  const reg = await loadRegistry();
  const entries = Object.entries(reg.projects);
  if (entries.length === 0) {
    console.log(`[opensquid project list] no projects registered yet`);
    return;
  }
  // Stable ordering: active first by last_seen_at desc, then deleted.
  entries.sort(([, a], [, b]) => {
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return b.last_seen_at.localeCompare(a.last_seen_at);
  });
  console.log(`[opensquid project list] ${entries.length} registered:`);
  for (const [uuid, entry] of entries) {
    const tag = entry.status === "active" ? "  " : "× ";
    console.log(`${tag}${entry.id.padEnd(28)} ${entry.last_seen_path}`);
    console.log(`    uuid=${uuid}  last_seen=${entry.last_seen_at}`);
  }
}

async function cmdPrune(): Promise<void> {
  const res = await pruneDeleted();
  if (res.swept === 0) {
    console.log(`[opensquid project prune] no stale entries`);
    return;
  }
  console.log(
    `[opensquid project prune] marked ${res.swept} entr${res.swept === 1 ? "y" : "ies"} as deleted: ${res.removed_ids.join(", ")}`,
  );
}

export type ProjectCliCmd = "init" | "info" | "list" | "prune";

export async function runProjectCli(cmd: ProjectCliCmd, argv: string[]): Promise<void> {
  const { opts } = parseFlags(argv);
  switch (cmd) {
    case "init":
      await cmdInit(opts);
      return;
    case "info":
      await cmdInfo();
      return;
    case "list":
      await cmdList();
      return;
    case "prune":
      await cmdPrune();
      return;
  }
}
