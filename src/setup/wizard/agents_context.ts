/**
 * GAC.1 — locate + load the shipped global agent-context baseline.
 *
 * opensquid ships a domain-neutral anti-drift baseline (`context/AGENTS.md`) that `opensquid setup wizard hooks`
 * auto-installs into every detected popular harness (GAC.4). This module is the single source of truth for the
 * asset path + its loaded body. The asset ships from a DEDICATED `context/` dir (NOT `claude-skills/`, which
 * `skill-installer.ts` scans for the `/packs` skill).
 *
 * Imported by: src/setup/wizard/install_agents_context.ts (GAC.4).
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// dist/setup/wizard/agents_context.js → ../../.. = the package root (mirrors read_rubric.ts PKG_ROOT).
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Absolute path to the shipped baseline asset. */
export const AGENTS_ASSET = join(PKG_ROOT, 'context', 'AGENTS.md');

/** The baseline body (trimmed) — the content opensquid installs into each harness. */
export async function loadAgentsBaseline(): Promise<string> {
  return (await readFile(AGENTS_ASSET, 'utf8')).trim();
}
