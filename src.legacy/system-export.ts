/**
 * `opensquid export / import` — entire ~/.opensquid/ state bundle.
 *
 * Used to back up everything the engine writes (codexes, lessons,
 * memories with .vec sidecars, hooks state under sessions/, project
 * ID cards, engine config) into a single portable archive. Re-import
 * on a fresh machine restores identical state.
 *
 * Format: tar.gz via system `tar` (bsdtar on macOS / Windows 10+,
 * GNU tar on Linux — all support `-czf` / `-xzf`). Reasoning: zero
 * new dependency, deterministic byte layout, easy to inspect via
 * `tar tzf`. Encryption deferred — pass through gpg externally for
 * now (`gpg -c <archive>`).
 *
 * Round-trip semantics:
 * - export writes tar.gz containing the entire ~/.opensquid/ tree
 *   relative to $HOME so paths remain portable across machines
 * - import accepts --merge (default — extracts on top of existing
 *   ~/.opensquid/, last-write-wins per file) or --replace (wipe
 *   ~/.opensquid/ first then extract). Vector index .vec sidecars
 *   carry through; engine rehydrates the in-memory HNSW on next
 *   spawn from those sidecars.
 *
 * Failure modes:
 * - missing tar binary → throw with install-tar hint
 * - existing output path → refuse without --force
 * - tar exit non-zero → propagate stderr
 * - --replace on non-empty ~/.opensquid/ + missing input archive → no
 *   data loss because we extract to a tmp dir first then atomic rename
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export class SystemExportError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "SystemExportError";
  }
}

/** Resolved data root — `LOOP_HOME` env override, else `~/.opensquid/`. */
function dataRoot(): string {
  return process.env.LOOP_HOME ?? path.join(os.homedir(), ".opensquid");
}

/** Default output filename for `export` — timestamped under cwd. */
function defaultOutputPath(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/T/g, "_");
  return path.resolve(`opensquid-${ts}.tar.gz`);
}

export interface ExportOptions {
  /** Output archive path. Defaults to `./opensquid-<timestamp>.tar.gz`. */
  output?: string;
  /** Overwrite existing output path. */
  force?: boolean;
  /** Override the source data root (default: `LOOP_HOME` or `~/.opensquid/`). */
  dataRoot?: string;
}

export interface ExportResult {
  output: string;
  size_bytes: number;
}

export async function exportSystem(opts: ExportOptions = {}): Promise<ExportResult> {
  const root = opts.dataRoot ?? dataRoot();
  const output = opts.output ? path.resolve(opts.output) : defaultOutputPath();

  // Verify the data root exists.
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
      throw new SystemExportError(
        `data root is not a directory: ${root}`,
        "set LOOP_HOME or pass --root to override",
      );
    }
  } catch (err) {
    if (err instanceof SystemExportError) throw err;
    throw new SystemExportError(
      `data root does not exist: ${root}`,
      "nothing to export — opensquid hasn't written any state on this machine yet",
    );
  }

  // Refuse to overwrite an existing output unless --force.
  let outputExists = false;
  try {
    await fs.access(output);
    outputExists = true;
  } catch {
    /* doesn't exist, fine */
  }
  if (outputExists && !opts.force) {
    throw new SystemExportError(
      `output path already exists: ${output}`,
      "pass --force to overwrite, or pick a different --output",
    );
  }

  // tar -czf <output> -C <parent-of-root> <basename-of-root>
  // Bundling by basename keeps the extracted tree at .opensquid/ on
  // import regardless of what the source machine had as $HOME. The -C
  // flag chdirs before reading so the archive doesn't carry absolute
  // paths.
  const parent = path.dirname(root);
  const base = path.basename(root);
  await runTar(["-czf", output, "-C", parent, base]);

  const stat = await fs.stat(output);
  return { output, size_bytes: stat.size };
}

export interface ImportOptions {
  /** Source archive path. */
  input: string;
  /**
   * `merge` (default): extract on top of existing data root, last-write
   * -wins per file. `replace`: wipe data root first then extract.
   */
  mode?: "merge" | "replace";
  /** Override the destination data root. */
  dataRoot?: string;
}

export interface ImportResult {
  input: string;
  data_root: string;
  mode: "merge" | "replace";
}

export async function importSystem(opts: ImportOptions): Promise<ImportResult> {
  const root = opts.dataRoot ?? dataRoot();
  const mode = opts.mode ?? "merge";
  const input = path.resolve(opts.input);

  // Verify the input archive exists + is readable.
  try {
    const stat = await fs.stat(input);
    if (!stat.isFile()) {
      throw new SystemExportError(
        `input is not a file: ${input}`,
        "pass an opensquid export archive (tar.gz)",
      );
    }
  } catch (err) {
    if (err instanceof SystemExportError) throw err;
    throw new SystemExportError(`input archive does not exist: ${input}`, "check the path");
  }

  // Validate the archive looks like an opensquid export by listing
  // contents and looking for the .opensquid/ root entry.
  const list = await tarList(input);
  const hasRoot = list.some((entry) => entry.startsWith(".opensquid/") || entry === ".opensquid");
  if (!hasRoot) {
    throw new SystemExportError(
      `input does not look like an opensquid export (no .opensquid/ entry)`,
      "exports created by `opensquid export` always have a .opensquid/ root",
    );
  }

  // For replace mode: extract to a tmp dir first, then atomic rename
  // over the destination. This way a corrupt input doesn't leave the
  // user with a half-deleted data root.
  if (mode === "replace") {
    const stagingParent = path.join(os.tmpdir(), `opensquid-import-${Date.now()}`);
    await fs.mkdir(stagingParent, { recursive: true });
    try {
      await runTar(["-xzf", input, "-C", stagingParent]);
      const stagedRoot = path.join(stagingParent, path.basename(root));
      // Ensure the staged tree exists.
      await fs.access(stagedRoot);
      // Wipe the destination + atomic-replace.
      await fs.rm(root, { recursive: true, force: true });
      await fs.rename(stagedRoot, root);
    } finally {
      // Best-effort cleanup of the staging parent (it's empty now if
      // the rename succeeded, but may contain orphans on failure).
      await fs.rm(stagingParent, { recursive: true, force: true }).catch(() => undefined);
    }
  } else {
    // Merge: extract directly to the destination's parent. tar will
    // create / overwrite files within .opensquid/. Existing files not
    // in the archive are preserved. Directory must exist.
    await fs.mkdir(path.dirname(root), { recursive: true });
    await runTar(["-xzf", input, "-C", path.dirname(root)]);
  }

  return { input, data_root: root, mode };
}

// ---------------------------------------------------------------------
// tar helpers
// ---------------------------------------------------------------------

function runTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(
          new SystemExportError(
            "tar binary not found on PATH",
            "install tar (preinstalled on macOS / Linux; Windows 10+ ships bsdtar)",
          ),
        );
      } else {
        reject(err);
      }
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new SystemExportError(
            `tar exited with code ${code}`,
            stderr.trim() || "no stderr from tar",
          ),
        );
    });
  });
}

async function tarList(input: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-tzf", input], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(
          stdout
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean),
        );
      } else {
        reject(
          new SystemExportError(
            `tar -tzf exited with code ${code}`,
            stderr.trim() || "no stderr from tar",
          ),
        );
      }
    });
  });
}
