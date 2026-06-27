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
  /**
   * Resolved write path for `block`/`file`; omitted for pure-print `manual`. `env` is THREADED IN (GAC.5) so the
   * XDG-honoring rows (Crush/OpenCode) can resolve `XDG_CONFIG_HOME`; rows that don't need it ignore the 2nd param.
   */
  target?: (home: string, env: NodeJS.ProcessEnv) => string;
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

/**
 * XDG config root — `XDG_CONFIG_HOME` else `$HOME/.config`. Honored by Crush & OpenCode (source-verified: Crush
 * `internal/home/home.go` `Config()`, OpenCode `xdg-basedir@5.1.0`); NOT by Amp (fixed `$HOME/.config`, source-verified
 * to ignore XDG). Resolves correctly on Windows too (`os.homedir()` = `%USERPROFILE%`, XDG rarely set there).
 */
const xdgConfigRoot = (home: string, env: NodeJS.ProcessEnv): string =>
  env.XDG_CONFIG_HOME ?? join(home, '.config');

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
  // amp is fixed at $HOME/.config (source-verified to IGNORE XDG_CONFIG_HOME) — do NOT use xdgConfigRoot here.
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
    // honors XDG_CONFIG_HOME (xdg-basedir@5.1.0) — source-verified.
    target: (h, env) => join(xdgConfigRoot(h, env), 'opencode', 'AGENTS.md'),
  },
  {
    harness: 'goose',
    kind: 'block',
    bin: 'goose',
    dir: join('.config', 'goose'),
    target: (h) => join(h, '.config', 'goose', '.goosehints'),
    // Windows: etcetera native app strategy (author 'Block', app 'goose', '/config') — source-verified.
    winTarget: (h, env) => join(appData(h, env), 'Block', 'goose', 'config', '.goosehints'),
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
  // crush shares ~/.config/AGENTS.md with amp when XDG unset → GAC.4 dedupes by resolved path.
  {
    harness: 'crush',
    kind: 'block',
    bin: 'crush',
    dir: join('.config', 'crush'),
    // honors XDG_CONFIG_HOME (internal/home/home.go Config()) — source-verified. Amp ignores XDG, so under a set
    // XDG_CONFIG_HOME these correctly DIVERGE (both written); when unset they coincide and dedupe.
    target: (h, env) => join(xdgConfigRoot(h, env), 'AGENTS.md'),
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

/**
 * T-project-context (advisory tier) — PROJECT-level rules-file targets, keyed by harness.
 *
 * Additive + separate from REGISTRY (which is GLOBAL-only) so the global path code is
 * untouched. Each entry resolves a path relative to the PROJECT ROOT, with a write
 * `kind`: `block` = a shared file the user may also edit (managed-block + foreign-
 * preserve — AGENTS.md/CLAUDE.md/…); `file` = an opensquid-owned dedicated file in a
 * rules dir (.cursor/rules/opensquid.mdc, …). Paths are from the cited capability
 * matrix (docs/research/per-harness-capability-matrix.md). Harnesses whose PROJECT
 * path isn't authoritatively sourced (pi, hermes) or that need a config entry rather
 * than a file drop (aider) are intentionally OMITTED — no guessing.
 *
 * AGENTS.md sharers (codex/amp/opencode/crush/warp) resolve to the SAME `./AGENTS.md`
 * and dedupe by path at write time (one write, all benefit).
 */
export const PROJECT_RULE_TARGETS: Record<
  string,
  { path: (projectRoot: string) => string; kind: 'block' | 'file' }
> = {
  'claude-code': { path: (p) => join(p, 'CLAUDE.md'), kind: 'block' },
  codex: { path: (p) => join(p, 'AGENTS.md'), kind: 'block' },
  gemini: { path: (p) => join(p, 'GEMINI.md'), kind: 'block' },
  amp: { path: (p) => join(p, 'AGENTS.md'), kind: 'block' },
  opencode: { path: (p) => join(p, 'AGENTS.md'), kind: 'block' },
  crush: { path: (p) => join(p, 'AGENTS.md'), kind: 'block' },
  warp: { path: (p) => join(p, 'AGENTS.md'), kind: 'block' },
  qwen: { path: (p) => join(p, 'QWEN.md'), kind: 'block' },
  goose: { path: (p) => join(p, '.goosehints'), kind: 'block' },
  zed: { path: (p) => join(p, '.rules'), kind: 'block' },
  windsurf: { path: (p) => join(p, '.windsurf', 'rules', 'opensquid.md'), kind: 'file' },
  cursor: { path: (p) => join(p, '.cursor', 'rules', 'opensquid.mdc'), kind: 'file' },
  cline: { path: (p) => join(p, '.clinerules', 'opensquid.md'), kind: 'file' },
  roo: { path: (p) => join(p, '.roo', 'rules', 'opensquid.md'), kind: 'file' },
  kilo: { path: (p) => join(p, '.kilocode', 'rules', 'opensquid.md'), kind: 'file' },
  continue: { path: (p) => join(p, '.continue', 'rules', 'opensquid.md'), kind: 'file' },
  trae: { path: (p) => join(p, '.trae', 'rules', 'opensquid.md'), kind: 'file' },
};

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
          ? r.target(home, env)
          : undefined;
    out.push({ harness: r.harness, kind: r.kind, ...(path ? { path } : {}) });
  }
  return out;
}
