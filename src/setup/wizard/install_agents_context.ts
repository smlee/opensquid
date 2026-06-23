/**
 * GAC.4 — install the global agent-context baseline into every detected harness.
 *
 * Orchestrates GAC.1–3: load the shipped baseline (`agents_context`), detect installed harnesses
 * (`harness_targets`), and dispatch per write-kind — `block` → `writeManagedBlock` (GAC.2), `file` → a dedicated
 * `opensquid.md`, `manual` → collected for the caller to PRINT. DEDUPES by resolved target path so Amp + Crush
 * (both `~/.config/AGENTS.md`) yield ONE write. Wired into `setup/cli/hooks.ts` (the `wizard hooks` step), opt-out
 * via `--no-agents`.
 *
 * Imported by: src/setup/cli/hooks.ts.
 */
import { access, constants, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { loadAgentsBaseline } from './agents_context.js';
import { detectHarnessTargets } from './harness_targets.js';
import { BLOCK_BEGIN, BLOCK_END, writeManagedBlock } from './managed_block.js';

/** Is `name` an executable on PATH? POSIX scan (macOS/Linux this track; Windows variants deferred). */
export async function hasBinaryOnPath(name: string): Promise<boolean> {
  for (const dir of (process.env.PATH ?? '').split(':').filter((d) => d.length > 0)) {
    try {
      await access(join(dir, name), constants.X_OK);
      return true;
    } catch {
      /* next dir */
    }
  }
  return false;
}

export interface InstallReport {
  written: { harness: string; path: string; result: string }[];
  /** harnesses with no auto-writable target — the caller prints these for the user to paste. */
  manual: { harness: string; block: string }[];
}

/**
 * Auto-install the baseline into every detected harness. `block` → managed block; `file` → dedicated `opensquid.md`;
 * `manual` → collected for printing. Dedupes by resolved target path (Amp+Crush → one `~/.config/AGENTS.md`).
 */
export async function installAgentsContext(
  home: string,
  hasBinary: (name: string) => Promise<boolean>,
): Promise<InstallReport> {
  const body = await loadAgentsBaseline();
  const targets = await detectHarnessTargets(home, hasBinary);
  const report: InstallReport = { written: [], manual: [] };
  const doneTargets = new Set<string>();
  for (const t of targets) {
    if (t.kind === 'manual' || t.path === undefined) {
      report.manual.push({ harness: t.harness, block: `${BLOCK_BEGIN}\n${body}\n${BLOCK_END}` });
      continue;
    }
    if (doneTargets.has(t.path)) {
      report.written.push({ harness: t.harness, path: t.path, result: 'deduped' });
      continue;
    }
    doneTargets.add(t.path);
    if (t.kind === 'block') {
      report.written.push({
        harness: t.harness,
        path: t.path,
        result: await writeManagedBlock(t.path, body),
      });
    } else {
      // 'file' — write our own dedicated file (no managed block needed).
      await mkdir(dirname(t.path), { recursive: true });
      await writeFile(t.path, `${body}\n`);
      report.written.push({ harness: t.harness, path: t.path, result: 'file' });
    }
  }
  return report;
}
