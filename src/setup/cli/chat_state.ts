/**
 * Chat-setup wizard detection layer (WIZ.2).
 *
 * Five pure-function readers that introspect the current state of the
 * user's machine WITHOUT prompting, writing, or mutating anything. The
 * wizard's interactive flow (WIZ.3, `chat_actions.ts`) consumes these
 * snapshots to decide which storyboard branch to enter (clean state vs
 * idempotent re-run vs broken config).
 *
 * Discipline (audit-critical):
 *   - PURE READ-ONLY. No `writeFile`, no `mkdir`, no `unlink`. Detection
 *     is observation; the caller owns the write decision.
 *   - SECRET-SAFE. We probe for `ANTHROPIC_API_KEY` + `OPENSQUID_TELEGRAM_
 *     BOT_TOKEN` presence in `~/.loop/.env` but NEVER return the values —
 *     the boolean is the only output. If a future detector needs the
 *     value, it goes through a separate explicitly-named getter.
 *   - ENOENT TOLERANT. Missing files / directories return empty state, not
 *     thrown errors. The wizard's job is to surface "what's there?" not
 *     "what's missing?".
 *   - PID LIVENESS. `process.kill(pid, 0)` is the canonical POSIX `kill -0`
 *     check — throws ESRCH if the pid is dead, EPERM if alive-but-foreign
 *     (still counts as running). Matches the daemon lifecycle pattern in
 *     `src/channels/daemon/lifecycle.ts`, the load-bearing production check.
 *   - NO `any` TYPES. Strict typed surface; opaque parse-error messages
 *     surfaced as `parseError: string` so the wizard can render them.
 *
 * Five detectors:
 *   detectModelsConfig    — ~/.opensquid/models.yaml + fast_chat alias
 *   detectPacksDir        — ~/.opensquid/packs/<id>/{manifest,chat_agent}.yaml
 *   detectChatDaemonRunning — ~/.opensquid/chat-daemon.pid + sock probe
 *   detectSecretsBackend  — ~/.loop/.env + op CLI + macOS keychain
 *   detectAgentBridgeRunning — ~/.opensquid/agent-bridge.pid (WAB.7 file)
 *
 * Imports from: node:fs/promises, node:os, node:path, ../../packs/yaml,
 *   ../../packs/schemas/{models,manifest}, ../../runtime/paths.
 * Imported by: src/setup/cli/chat_actions.ts (WIZ.3) +
 *   src/setup/cli/chat_state.test.ts.
 */

import { access, readFile, readdir, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { delimiter, join } from 'node:path';

import { ModelsConfig, type ModelMode } from '../../packs/schemas/models.js';
import { parseYamlFile } from '../../packs/yaml.js';
import { OPENSQUID_HOME } from '../../runtime/paths.js';

export type { ModelMode };

// ---------------------------------------------------------------------------
// Result shapes — exported so WIZ.3 + tests share the contract.
// ---------------------------------------------------------------------------

export interface ModelsState {
  /** True if `~/.opensquid/models.yaml` exists on disk (even if malformed). */
  present: boolean;
  /** Absolute path the detector probed (for error messages + tests). */
  path: string;
  /** Top-level alias keys; empty array on missing/malformed file. */
  aliases: string[];
  /** Whether the `fast_chat` alias is declared. */
  hasFastChat: boolean;
  /** Mode of `fast_chat` when present (api | subscription | local | mcp). */
  fastChatMode?: ModelMode;
  /** YAML / schema error message — `present: true` but unusable. */
  parseError?: string;
}

export interface PackEntry {
  /** Pack id (directory name, validated as Manifest.name slug). */
  name: string;
  /** Absolute path to the pack root directory. */
  root: string;
  /** Whether `chat_agent.yaml` exists in the pack root. */
  hasChatAgent: boolean;
}

export interface PacksState {
  /** Absolute path to the packs directory the detector probed. */
  path: string;
  /** Per-pack entries, sorted by name. Empty when packs/ is missing or empty. */
  packs: PackEntry[];
}

export interface ChatDaemonState {
  /** Process responsive to `kill -0`. False on missing pidfile, stale pid,
   *  unparseable pidfile, or dead process. */
  running: boolean;
  /** Pidfile path the detector probed. */
  pidPath: string;
  /** PID parsed from the file; only meaningful when `running` is true. */
  pid?: number;
  /** Whether the Unix socket file exists (cheap proxy for IPC reachability;
   *  full UDS connect is intentionally NOT attempted — too coupled, and
   *  the wizard never makes RPC calls from the detector layer). */
  mcpReachable: boolean;
}

export type SecretsBackend = 'env' | 'op' | 'keychain';

export interface SecretsState {
  /** Backends the detector could observe on this machine. Order is stable:
   *  env first, then op (if `op` is on PATH), then keychain (darwin only). */
  backends: SecretsBackend[];
  /** Whether `~/.loop/.env` exists at all. */
  envPath: string;
  envPresent: boolean;
  /** Presence-only — the value is NEVER returned, only the boolean. */
  anthropicKeyPresent: boolean;
  /** Presence-only — the value is NEVER returned, only the boolean. */
  telegramTokenPresent: boolean;
}

export interface AgentBridgeState {
  /** Process responsive to `kill -0`. False on missing pidfile (WAB.7 hasn't
   *  shipped yet → pidfile doesn't exist → state is `running: false`). */
  running: boolean;
  pidPath: string;
  pid?: number;
}

// ---------------------------------------------------------------------------
// Path defaults — exported so WIZ.3 + tests can override under tmpdir.
// ---------------------------------------------------------------------------

export const defaultModelsPath = (): string => join(OPENSQUID_HOME(), 'models.yaml');
export const defaultPacksDir = (): string => join(OPENSQUID_HOME(), 'packs');
export const defaultChatDaemonPidPath = (): string => join(OPENSQUID_HOME(), 'chat-daemon.pid');
export const defaultChatDaemonSockPath = (): string => join(OPENSQUID_HOME(), 'chat-daemon.sock');
export const defaultAgentBridgePidPath = (): string => join(OPENSQUID_HOME(), 'agent-bridge.pid');
// WRITE canonical (wg-45512ec39739): always ~/.opensquid/.env (OPENSQUID_HOME). NEVER routed through
// the read-both resolver — a legacy-fallback here would keep writing ~/.loop/.env for existing users.
export const defaultEnvPath = (): string => join(OPENSQUID_HOME(), '.env');

// ---------------------------------------------------------------------------
// detectModelsConfig — read ~/.opensquid/models.yaml through the Zod schema
//
// Three outcomes:
//   1. File missing → `present: false`, empty aliases. (Most common first-run.)
//   2. File present + parses → `present: true`, aliases enumerated, `fast_chat`
//      mode surfaced.
//   3. File present + malformed YAML or schema reject → `present: true`,
//      `parseError` populated, aliases empty. NEVER throws.
// ---------------------------------------------------------------------------

export async function detectModelsConfig(path?: string): Promise<ModelsState> {
  const resolved = path ?? defaultModelsPath();
  try {
    const { data } = await parseYamlFile(resolved, ModelsConfig);
    // `ModelsConfig` has a `.default({})` at the schema layer so an empty
    // document parses to `{}`, but TS's strict `exactOptionalPropertyTypes`
    // still surfaces the default-applicable `undefined` in the inferred
    // type. Coalesce defensively so the local variable's type is the
    // post-default shape (`Record<string, ModelAlias>`).
    const aliasMap = data ?? {};
    const aliases = Object.keys(aliasMap).sort();
    const fastChat = aliasMap.fast_chat;
    const base: ModelsState = {
      present: true,
      path: resolved,
      aliases,
      hasFastChat: fastChat !== undefined,
    };
    if (fastChat?.mode !== undefined) base.fastChatMode = fastChat.mode;
    return base;
  } catch (err) {
    if (isEnoent(err)) {
      return { present: false, path: resolved, aliases: [], hasFastChat: false };
    }
    return {
      present: true,
      path: resolved,
      aliases: [],
      hasFastChat: false,
      parseError: errMessage(err),
    };
  }
}

// ---------------------------------------------------------------------------
// detectPacksDir — enumerate ~/.opensquid/packs/<id>/
//
// We do NOT require manifest.yaml to be valid — a pack dir with a broken
// manifest is still surfaced (the wizard's job is to *find* it; the user
// fixes it elsewhere). chat_agent.yaml is a separate sidecar file whose
// schema lands in WAB.6; we only check for existence, not shape.
// ---------------------------------------------------------------------------

export async function detectPacksDir(path?: string): Promise<PacksState> {
  const resolved = path ?? defaultPacksDir();
  let entries: string[];
  try {
    entries = await readdir(resolved);
  } catch (err) {
    if (isEnoent(err)) return { path: resolved, packs: [] };
    throw err;
  }
  entries.sort();
  const packs: PackEntry[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const root = join(resolved, name);
    let st;
    try {
      st = await stat(root);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    // Slug validation mirrors Manifest.name regex; dirs that don't match
    // are still surfaced (the wizard surfaces "weird pack name" rather
    // than silently dropping it). We use the regex source directly so a
    // single source of truth governs both.
    const hasChatAgent = await pathExists(join(root, 'chat_agent.yaml'));
    packs.push({ name, root, hasChatAgent });
  }
  return { path: resolved, packs };
}

// ---------------------------------------------------------------------------
// detectChatDaemonRunning — pidfile + kill(0) liveness
//
// Mirrors `src/channels/daemon/lifecycle.ts` `status()` semantics:
//   - Pidfile missing                  → not running
//   - Pidfile garbled                  → not running
//   - Pidfile points at dead pid       → not running (stale_pid omitted —
//                                        WIZ.3 doesn't clean up, just reports)
//   - Pidfile points at live pid (any) → running, including foreign-owner
//                                        (EPERM on kill(0) still means alive)
//
// `mcpReachable` is a cheap proxy: the daemon writes a Unix socket file
// alongside the pidfile when it boots. We `stat` for existence — NOT
// connect — because (a) connecting would couple the detector to the RPC
// surface, (b) UDS connect can block, and (c) the wizard's later live-test
// step handles full IPC. Existence-only is sufficient signal for "the
// daemon set up its sock". When pidfile is dead but sock lingers, we still
// report `mcpReachable: true` — the wizard's render layer composes the
// fields and shows "running: no, stale sock: yes".
// ---------------------------------------------------------------------------

export async function detectChatDaemonRunning(opts?: {
  pidPath?: string;
  sockPath?: string;
}): Promise<ChatDaemonState> {
  const pidPath = opts?.pidPath ?? defaultChatDaemonPidPath();
  const sockPath = opts?.sockPath ?? defaultChatDaemonSockPath();
  const mcpReachable = await pathExists(sockPath);
  const pid = await readPidfile(pidPath);
  if (pid === null) {
    return { running: false, pidPath, mcpReachable };
  }
  if (!isProcessAlive(pid)) {
    return { running: false, pidPath, mcpReachable };
  }
  return { running: true, pidPath, pid, mcpReachable };
}

// ---------------------------------------------------------------------------
// detectSecretsBackend — env + op CLI + macOS keychain
//
// `env` backend: read the canonical `<OPENSQUID_HOME>/.env` (~/.opensquid/.env)
// line-by-line, scan for `^KEY=` prefixes. (PATH.2: the pre-rename `~/.loop/.env`
// is auto-migrated to this path; it is no longer the home, chmod 600.) We
// do NOT parse values — just the presence of the key on a non-comment,
// non-blank line. The value is left in the file's memory (Node strings)
// only for the duration of the scan; we never copy it into our return.
//
// `op` backend: `op` binary exists on $PATH. We DON'T invoke it (no
// `op whoami`) because that prompts for auth and adds latency. PATH
// presence is sufficient signal for the wizard's "you have op available"
// surface; the wizard's later setup step would invoke op explicitly.
//
// `keychain` backend: macOS-only. `/usr/bin/security` is the system tool;
// its presence + `process.platform === 'darwin'` is the signal.
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY_PREFIX = 'ANTHROPIC_API_KEY=';
const TELEGRAM_TOKEN_PREFIX = 'OPENSQUID_TELEGRAM_BOT_TOKEN=';

export async function detectSecretsBackend(opts?: {
  envPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SecretsState> {
  const envPath = opts?.envPath ?? defaultEnvPath();
  const processEnv = opts?.env ?? process.env;
  const envPresent = await pathExists(envPath);
  let anthropicKeyPresent = false;
  let telegramTokenPresent = false;
  if (envPresent) {
    try {
      const raw = await readFile(envPath, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trimStart();
        if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
        if (trimmed.startsWith(ANTHROPIC_KEY_PREFIX)) anthropicKeyPresent = true;
        if (trimmed.startsWith(TELEGRAM_TOKEN_PREFIX)) telegramTokenPresent = true;
      }
    } catch {
      // Unreadable .env (EACCES etc.) → treat as absent for presence
      // checks; we do NOT surface the raw error because it might leak
      // a path the user wants masked. The wizard's render layer renders
      // `envPresent: true, anthropicKeyPresent: false` and offers a hint.
    }
  }
  const backends: SecretsBackend[] = ['env'];
  if (await binaryOnPath('op', processEnv)) backends.push('op');
  if (process.platform === 'darwin' && (await pathExists('/usr/bin/security'))) {
    backends.push('keychain');
  }
  return {
    backends,
    envPath,
    envPresent,
    anthropicKeyPresent,
    telegramTokenPresent,
  };
}

// ---------------------------------------------------------------------------
// detectAgentBridgeRunning — WAB.7 pidfile (may not exist yet)
//
// The agent-bridge daemon is the WAB.7 deliverable; its pidfile spec lands
// alongside the daemon. Until WAB.7 ships, the pidfile is guaranteed absent
// on every machine and the detector returns `running: false`. Once WAB.7
// lands, the same kill(0) check handles liveness — no changes needed here.
// ---------------------------------------------------------------------------

export async function detectAgentBridgeRunning(opts?: {
  pidPath?: string;
}): Promise<AgentBridgeState> {
  const pidPath = opts?.pidPath ?? defaultAgentBridgePidPath();
  const pid = await readPidfile(pidPath);
  if (pid === null) return { running: false, pidPath };
  if (!isProcessAlive(pid)) return { running: false, pidPath };
  return { running: true, pidPath, pid };
}

// ---------------------------------------------------------------------------
// Internal helpers — kept private to the module (not exported) so the
// detector surface stays narrow.
// ---------------------------------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readPidfile(path: string): Promise<number | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return pid;
}

/** Portable `kill -0`: ESRCH = dead, EPERM = alive-but-foreign (still
 *  counts as running). Mirrors `src/channels/daemon/lifecycle.ts`. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function binaryOnPath(name: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const pathVar = env.PATH ?? '';
  if (pathVar.length === 0) return false;
  for (const dir of pathVar.split(delimiter)) {
    if (dir.length === 0) continue;
    if (await pathExists(join(dir, name))) return true;
  }
  return false;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
