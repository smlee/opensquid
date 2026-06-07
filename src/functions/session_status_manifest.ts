/**
 * session_status_manifest (T-SESSION-STATUS-MANIFEST) — ONE consolidated
 * "what is opensquid connected to" report, surfaced on every session begin
 * (startup + resume) via the SessionStart hook's
 * `hookSpecificOutput.additionalContext` (the user-visible channel).
 *
 * Supersedes the fragmented per-subsystem session-start injects: instead of
 * `check_chat_connection` (chat only) + `check_flow_health` (flow only, and
 * silent when healthy) reporting separately, this primitive emits a single,
 * ALWAYS-shown block with five sections so the user sees the full connection
 * picture every start/resume:
 *
 *   📋 opensquid — session connections
 *   • Chat:    telegram topic N (umbrella X) — receiver attached ✅ / no receiver 🔌
 *   • Flow:    gates active ✅ / INACTIVE ⛔ — <problems> (preserves the F3 signal)
 *   • Packs:   loaded names + count
 *   • Daemon:  always-on chat-daemon reachable ✅ / down 🔌
 *   • Engine:  loop-engine memory up ✅ / down 🔌
 *
 * DRY: the Flow section reuses `flowEnforcementProblems` (the exact detection
 * behind `check_flow_health`). Chat/Packs/Daemon/Engine are composed from the
 * shared library functions. (Track-2 cleanup: when the session attaches to the
 * daemon as the live receiver, `check_chat_connection`/`check_flow_health` — now
 * registered-but-unwired — retire in favor of this manifest.)
 *
 * Fail-quiet, NEVER throws (a SessionStart hook must exit 0): each section is
 * independently guarded — one probe failing degrades to "<section>: unknown"
 * and never blanks the others. Engine/daemon probes NEVER spawn (daemon = ping
 * an existing UDS; engine = sock-exists + pid-alive), so a status read cannot
 * start a subsystem.
 *
 * Imports from: node:fs, node:fs/promises, node:path, zod, ../channels/routing.js,
 *   ../chat_daemon/client.js, ../runtime/chat/live_session_lease.js,
 *   ../runtime/paths.js, ../runtime/result.js, ../runtime/bootstrap.js,
 *   ./check_flow_health.js.
 * Imported by: src/runtime/bootstrap.ts (registry wiring).
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { loadChannelsConfig, resolveOutbound, resolveUmbrellaForCwd } from '../channels/routing.js';
import { pingDaemon } from '../chat_daemon/client.js';
import { loadActivePacks } from '../runtime/bootstrap.js';
import { isLeaseFresh, readLease } from '../runtime/chat/live_session_lease.js';
import { OPENSQUID_HOME, umbrellaLiveSessionLease } from '../runtime/paths.js';
import { ok } from '../runtime/result.js';

import { flowEnforcementProblems } from './check_flow_health.js';
import type { FunctionDef } from './registry.js';

const NoArgs = z.object({}).strict();

interface ManifestResult {
  kind: 'inject_context';
  content: string;
}

interface OpensquidConfig {
  chat?: { session_start_check?: string };
  chat_connections?: {
    telegram?: { bot_token?: string };
    slack?: unknown;
    discord?: unknown;
  };
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Chat section: configured channel + whether a live receiver is attached. */
async function chatStatusLine(cwd: string): Promise<string> {
  const config = (await readJson<OpensquidConfig>(join(OPENSQUID_HOME(), 'config.json'))) ?? {};
  if (config.chat?.session_start_check === 'off') return 'Chat: status checks off (config)';

  const channels = await loadChannelsConfig();
  const umbrellaId = channels === null ? null : resolveUmbrellaForCwd(channels, cwd);
  if (umbrellaId === null || channels === null) return 'Chat: not wired (umbrella unresolved)';

  const tokenPresent =
    typeof config.chat_connections?.telegram?.bot_token === 'string' &&
    config.chat_connections.telegram.bot_token.length > 0;
  const tg = resolveOutbound(channels, umbrellaId);
  if (tg !== null && tokenPresent) {
    const topic = tg.topic_id !== undefined ? ` topic ${String(tg.topic_id)}` : '';
    const attached = isLeaseFresh(await readLease(umbrellaLiveSessionLease(umbrellaId)));
    return attached
      ? `Chat: telegram${topic} (umbrella ${umbrellaId}) — live receiver attached ✅`
      : `Chat: telegram${topic} (umbrella ${umbrellaId}) — NO live receiver 🔌 (start \`opensquid chat watch\`)`;
  }
  if (
    config.chat_connections?.slack !== undefined ||
    config.chat_connections?.discord !== undefined
  )
    return `Chat: non-telegram platform configured for umbrella ${umbrellaId} (run \`opensquid setup\`)`;
  return `Chat: not wired for umbrella ${umbrellaId} (run \`opensquid setup\`)`;
}

/** Flow section: reuse the exact check_flow_health detection (DRY). */
async function flowStatusLine(sessionId: string): Promise<string> {
  const problems = await flowEnforcementProblems(sessionId);
  if (problems.length === 0) return 'Flow gates: active ✅';
  return (
    `Flow gates: INACTIVE ⛔ — ${problems.join('; ')}. ` +
    'Run `opensquid setup` then RESTART this session (hooks wire only at session start).'
  );
}

/** Packs section: the active pack names + count. */
async function packsStatusLine(sessionId: string): Promise<string> {
  const packs = await loadActivePacks(sessionId);
  const names = packs.map((p) => p.name);
  return names.length === 0
    ? 'Packs: none loaded'
    : `Packs (${String(names.length)}): ${names.join(', ')}`;
}

/** Daemon section: ping the always-on chat-daemon (no spawn). */
async function daemonStatusLine(): Promise<string> {
  const up = await pingDaemon(500);
  return up ? 'Daemon: chat-daemon reachable ✅' : 'Daemon: chat-daemon down 🔌';
}

/** Engine section: NON-spawning liveness — sock exists AND pid is alive. */
async function engineStatusLine(): Promise<string> {
  const home = OPENSQUID_HOME();
  if (!existsSync(join(home, 'loop-engine.sock'))) return 'Engine/memory: down 🔌 (no socket)';
  const pidText = (await readFile(join(home, 'loop-engine.pid'), 'utf8').catch(() => '')).trim();
  const pid = Number.parseInt(pidText, 10);
  if (!Number.isInteger(pid) || pid <= 0) return 'Engine/memory: down 🔌 (no pid)';
  try {
    process.kill(pid, 0);
    return 'Engine/memory: loop-engine up ✅';
  } catch {
    return 'Engine/memory: down 🔌 (stale pid)';
  }
}

/** Per-section hard ceiling — keeps the whole manifest under ~1s even if a probe
 *  hangs. The non-daemon probes (chat/flow/packs) do unbounded readFile/loadActivePacks;
 *  without this a hung fs/engine read would wedge Promise.all and defeat the
 *  "SessionStart must exit 0" guarantee. */
const SECTION_TIMEOUT_MS = 800;

/** Run a section probe with a hard timeout, degrading any throw OR hang to
 *  "<label>: unknown" — a SessionStart manifest must never block (or hang) session
 *  begin. (pingDaemon is already bounded to 500ms; this bounds the rest.) */
function safeSection(label: string, probe: () => Promise<string>): Promise<string> {
  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve(`${label}: unknown (timed out)`), SECTION_TIMEOUT_MS);
    timer.unref();
    probe().then(resolve, () => resolve(`${label}: unknown`));
  });
}

export const SessionStatusManifest: FunctionDef<z.input<typeof NoArgs>, ManifestResult | null> = {
  name: 'session_status_manifest',
  argSchema: NoArgs,
  durable: false,
  memoizable: false,
  costEstimateMs: 30,
  execute: async (_args, ctx) => {
    const cwd =
      ctx.event.kind === 'session_start' ? (ctx.event.cwd ?? process.cwd()) : process.cwd();
    const sessionId = ctx.sessionId;
    const sections = await Promise.all([
      safeSection('Chat', () => chatStatusLine(cwd)),
      safeSection('Flow gates', () => flowStatusLine(sessionId)),
      safeSection('Packs', () => packsStatusLine(sessionId)),
      safeSection('Daemon', () => daemonStatusLine()),
      safeSection('Engine/memory', () => engineStatusLine()),
    ]);
    const content = ['📋 opensquid — session connections', ...sections.map((s) => `• ${s}`)].join(
      '\n',
    );
    return ok({ kind: 'inject_context' as const, content });
  },
};
