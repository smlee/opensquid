/**
 * T-CODEX-HOST-SHELL CHS.1 — `opensquid setup wizard codex-hooks`.
 *
 * Writes the user-layer `~/.codex/hooks.json` with opensquid's five hook
 * entries (NO SessionEnd — codex's Stop is turn-scoped; see the writer
 * module header). Create-or-merge idempotent, backup before rewrite,
 * absolute bin paths. ACTIVATION REQUIRES TRUST: codex excludes non-managed
 * hooks until the user reviews + trusts them via `/hooks` in codex — the
 * outro says exactly that (no silent activation; the git boundary gates
 * remain the backstop enforcement either way).
 *
 * Imports from: commander, node:fs, node:fs/promises, node:os, node:path,
 *   ../wizard/codex-hooks-writer.js.
 * Imported by: src/cli.ts (registration beside the hooks wizard).
 */

import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  type CodexHooksFile,
  projectCodexHooks,
  resolveHookBinDir,
} from '../wizard/codex-hooks-writer.js';

export interface CodexHooksCliDeps {
  /** Test injection — the codex home dir (default `~/.codex`). */
  codexDir?: string;
  /** Test injection — the hook-bin dir (default `resolveHookBinDir()`). */
  binDir?: string;
  out?: (line: string) => void;
}

async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function backupThenWrite(path: string, content: string): Promise<void> {
  try {
    await copyFile(path, `${path}.bak-${new Date().toISOString().slice(0, 10)}`);
  } catch {
    /* ENOENT — nothing to back up */
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

export async function runCodexHooksWizard(deps: CodexHooksCliDeps = {}): Promise<void> {
  const out = deps.out ?? ((l: string): void => void process.stdout.write(`${l}\n`));
  const codexDir = deps.codexDir ?? join(homedir(), '.codex');
  if (!existsSync(codexDir)) {
    out('~/.codex not found — codex is not installed on this machine; nothing written.');
    return;
  }
  let binDir: string;
  try {
    binDir = deps.binDir ?? resolveHookBinDir();
  } catch (e) {
    out(`cancelled: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  const codexHooksPath = join(codexDir, 'hooks.json');
  const current = await readJsonOr<CodexHooksFile>(codexHooksPath, {});
  const { next, added, replaced, preserved } = projectCodexHooks({ current, binDir });
  await backupThenWrite(codexHooksPath, `${JSON.stringify(next, null, 2)}\n`);
  out(
    `codex hooks written to ${codexHooksPath}: ${String(added)} added, ${String(
      replaced,
    )} replaced, ${String(preserved)} foreign group(s) preserved.`,
  );
  out('ACTIVATION REQUIRES TRUST: open `codex`, run `/hooks`, review and trust the');
  out('opensquid entries — codex excludes untrusted hooks by design. The git');
  out('boundary gates remain enforcing either way.');
}

/** Register `wizard codex-hooks` under the existing wizard subgroup. */
export function registerCodexHooksWizard(wizard: Command, deps: CodexHooksCliDeps = {}): void {
  wizard
    .command('codex-hooks')
    .description(
      "Write opensquid's hook entries into ~/.codex/hooks.json (codex host shell; trust via /hooks in codex)",
    )
    .action(async () => {
      await runCodexHooksWizard(deps);
    });
}
