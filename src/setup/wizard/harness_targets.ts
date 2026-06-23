/**
 * GAC.3 — the curated 20-harness registry + detection.
 *
 * The orchestrator's universal floor (`context/AGENTS.md`) is installed into every DETECTED popular harness. This
 * module is the data-driven registry (each row's target/load path cited in the pre-research,
 * `docs/research/T-global-agent-context-pre-research-2026-06-22.md`) + `detectHarnessTargets`, which resolves the
 * installed rows to their write targets. Three write-kinds: `block` (managed block in a text context file via
 * GAC.2), `file` (a dedicated `opensquid.md` in a rules dir), `manual` (no writable home file → printed by GAC.4).
 *
 * DETECT is best-effort + re-runnable: a row is installed iff its `bin` is on PATH OR its `dir` exists (or it is
 * `alwaysOffer`, for marker-less manual rows like Trae/Warp). Binary names are CONVENTION (each harness's CLI
 * command); the correctness-bearing claim is the cited TARGET path.
 *
 * Imported by: src/setup/wizard/install_agents_context.ts (GAC.4).
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';

export type Kind = 'block' | 'file' | 'manual';

export interface HarnessRow {
  harness: string;
  kind: Kind;
  /** binary-on-PATH detect (convention; soft signal). */
  bin?: string;
  /** config dir/file detect, relative to home. */
  dir?: string;
  /** resolved write path for `block`/`file`; omitted for pure-print `manual`. */
  target?: (home: string) => string;
  /**
   * Windows-only write path (GAC.5), used iff `platform === 'win32'`. `env` is THREADED IN (not read from
   * `process.env` inside the closure) so `%APPDATA%` is injectable for deterministic tests on POSIX CI.
   */
  winTarget?: (home: string, env: NodeJS.ProcessEnv) => string;
  /** manual rows with no probe-able marker (Trae/Warp) — always printed. */
  alwaysOffer?: boolean;
}

/** Windows roaming app-data root — `%APPDATA%`, falling back to its conventional location under `home`. */
const appData = (home: string, env: NodeJS.ProcessEnv): string =>
  env.APPDATA ?? join(home, 'AppData', 'Roaming');

/** The 20-row USER-VETTED registry (paths cited in the pre-research). */
export const REGISTRY: HarnessRow[] = [
  {
    harness: 'claude-code',
    kind: 'block',
    bin: 'claude',
    dir: '.claude',
    target: (h) => join(h, '.claude', 'CLAUDE.md'),
  },
  {
    harness: 'codex',
    kind: 'block',
    bin: 'codex',
    dir: '.codex',
    target: (h) => join(h, '.codex', 'AGENTS.md'),
  },
  {
    harness: 'gemini',
    kind: 'block',
    bin: 'gemini',
    dir: '.gemini',
    target: (h) => join(h, '.gemini', 'GEMINI.md'),
  },
  {
    harness: 'windsurf',
    kind: 'block',
    dir: join('.codeium', 'windsurf'),
    target: (h) => join(h, '.codeium', 'windsurf', 'memories', 'global_rules.md'),
  },
  { harness: 'amp', kind: 'block', bin: 'amp', target: (h) => join(h, '.config', 'AGENTS.md') },
  {
    harness: 'zed',
    kind: 'block',
    bin: 'zed',
    dir: join('.config', 'zed'),
    target: (h) => join(h, '.config', 'zed', 'AGENTS.md'),
    winTarget: (h, env) => join(appData(h, env), 'Zed', 'AGENTS.md'),
  },
  {
    harness: 'opencode',
    kind: 'block',
    bin: 'opencode',
    dir: join('.config', 'opencode'),
    target: (h) => join(h, '.config', 'opencode', 'AGENTS.md'),
  },
  {
    harness: 'goose',
    kind: 'block',
    bin: 'goose',
    dir: join('.config', 'goose'),
    target: (h) => join(h, '.config', 'goose', '.goosehints'),
    winTarget: (h, env) => join(appData(h, env), 'goose', '.goosehints'),
  },
  {
    harness: 'pi',
    kind: 'block',
    bin: 'pi',
    dir: '.pi',
    target: (h) => join(h, '.pi', 'agent', 'AGENTS.md'),
  },
  {
    harness: 'qwen',
    kind: 'block',
    bin: 'qwen',
    dir: '.qwen',
    target: (h) => join(h, '.qwen', 'QWEN.md'),
  },
  // crush shares ~/.config/AGENTS.md with amp → GAC.4 dedupes by resolved path.
  {
    harness: 'crush',
    kind: 'block',
    bin: 'crush',
    dir: join('.config', 'crush'),
    target: (h) => join(h, '.config', 'AGENTS.md'),
  },
  {
    harness: 'cline',
    kind: 'file',
    dir: join('Documents', 'Cline'),
    target: (h) => join(h, 'Documents', 'Cline', 'Rules', 'opensquid.md'),
  },
  {
    harness: 'roo',
    kind: 'file',
    dir: '.roo',
    target: (h) => join(h, '.roo', 'rules', 'opensquid.md'),
  },
  {
    harness: 'kilo',
    kind: 'file',
    dir: '.kilocode',
    target: (h) => join(h, '.kilocode', 'rules', 'opensquid.md'),
  },
  { harness: 'cursor', kind: 'manual', dir: '.cursor' },
  { harness: 'continue', kind: 'manual', dir: '.continue' },
  { harness: 'aider', kind: 'manual', bin: 'aider', dir: '.aider.conf.yml' },
  { harness: 'hermes', kind: 'manual', dir: '.hermes' },
  { harness: 'trae', kind: 'manual', alwaysOffer: true },
  { harness: 'warp', kind: 'manual', alwaysOffer: true },
];

export interface ResolvedTarget {
  harness: string;
  kind: Kind;
  /** absolute write path for block/file; undefined for manual. */
  path?: string;
}

const exists = async (p: string): Promise<boolean> =>
  access(p)
    .then(() => true)
    .catch(() => false);

/**
 * Resolve the installed registry rows to write targets. `hasBinary` is injected (testability): a name → on-PATH.
 * A row is included iff `alwaysOffer`, OR its `bin` is on PATH, OR its `dir` exists under `home`.
 */
export async function detectHarnessTargets(
  home: string,
  hasBinary: (name: string) => Promise<boolean>,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedTarget[]> {
  const out: ResolvedTarget[] = [];
  for (const r of REGISTRY) {
    const installed =
      r.alwaysOffer === true ||
      (r.bin !== undefined && (await hasBinary(r.bin))) ||
      (r.dir !== undefined && (await exists(join(home, r.dir))));
    if (!installed) continue;
    const path =
      platform === 'win32' && r.winTarget
        ? r.winTarget(home, env)
        : r.target
          ? r.target(home)
          : undefined;
    out.push({ harness: r.harness, kind: r.kind, ...(path ? { path } : {}) });
  }
  return out;
}
