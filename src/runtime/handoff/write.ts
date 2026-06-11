/**
 * T-AUTO-HANDOFF — the four surface writers.
 *
 * (a) handover doc: atomic tmp+rename at a STABLE per-session path (idempotent
 *     rewrites — re-running a handoff updates, never accumulates).
 * (b) MEMORY.md: marker-delimited managed region ONLY (the settings-writer
 *     `@opensquid` marker contract applied to a doc) — bytes outside the
 *     markers are never touched; absent file → surface skipped.
 * (c) work-graph: upsert one `handoff-<sid8>` issue (stable title key).
 * (d) chat: best-effort daemon `send` — a down daemon NEVER fails the handoff.
 *
 * Imports from: node:fs/promises, node:os, node:path, ./collect.js,
 *   ./render.js, ../paths.js, ../../workgraph/store.js,
 *   ../../chat_daemon/client.js.
 * Imported by: handoff/index.ts.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { sendChat } from '../../chat_daemon/client.js';
import {
  GENERAL_UMBRELLA,
  loadChannelsConfig,
  resolveOutbound,
  resolveUmbrellaForCwd,
} from '../../channels/routing.js';
import { workGraphStore } from '../../workgraph/store.js';
import { OPENSQUID_HOME } from '../paths.js';

import { handoverDocPath, type HandoffState } from './collect.js';
import {
  renderChatDigest,
  renderHandoverDoc,
  renderResumeBlock,
  renderWgDigest,
  spliceNarrative,
} from './render.js';

export const HANDOFF_BEGIN = '<!-- opensquid:handoff:begin -->';
export const HANDOFF_END = '<!-- opensquid:handoff:end -->';

export interface SurfaceOutcome {
  surface: 'doc' | 'memory' | 'workgraph' | 'chat';
  ok: boolean;
  detail: string;
}

/** `/`→`-` — the EXISTING auto-memory dir naming convention (doctor.ts:36-38;
 *  deliberately a duplicated one-liner there too — no cli↔runtime import edge). */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, '-');
}

export function memoryMdPathFor(umbrellaRoot: string): string {
  return join(
    homedir(),
    '.claude',
    'projects',
    encodeProjectPath(umbrellaRoot),
    'memory',
    'MEMORY.md',
  );
}

/** Replace the managed region; insert after the first H1 when absent; prepend
 *  when no H1. Bytes outside the markers are NEVER touched. */
export function spliceResumeBlock(memoryMd: string, block: string): string {
  const wrapped = `${HANDOFF_BEGIN}\n${block}\n${HANDOFF_END}`;
  const b = memoryMd.indexOf(HANDOFF_BEGIN);
  const e = memoryMd.indexOf(HANDOFF_END);
  if (b !== -1 && e !== -1 && e > b) {
    return `${memoryMd.slice(0, b)}${wrapped}${memoryMd.slice(e + HANDOFF_END.length)}`;
  }
  const m = /^# .*$/m.exec(memoryMd);
  if (m?.index !== undefined) {
    const at = m.index + m[0].length;
    return `${memoryMd.slice(0, at)}\n\n${wrapped}${memoryMd.slice(at)}`;
  }
  return `${wrapped}\n\n${memoryMd}`;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${String(process.pid)}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

export interface WriteHandoffResult {
  docPath: string;
  outcomes: SurfaceOutcome[];
}

export async function writeHandoffSurfaces(
  state: HandoffState,
  opts: { narrative?: string } = {},
): Promise<WriteHandoffResult> {
  const outcomes: SurfaceOutcome[] = [];
  const docPath = handoverDocPath(state.umbrellaRoot, state.sessionId);

  // (a) the doc — the load-bearing record; a failure here IS a handoff failure.
  const docBody = renderHandoverDoc(state);
  await atomicWrite(
    docPath,
    opts.narrative === undefined ? docBody : spliceNarrative(docBody, opts.narrative),
  );
  outcomes.push({ surface: 'doc', ok: true, detail: docPath });

  // (b) MEMORY.md managed region — absent file → skip (not all hosts run auto-memory).
  const memPath = memoryMdPathFor(state.umbrellaRoot);
  try {
    const current = await readFile(memPath, 'utf8');
    await atomicWrite(memPath, spliceResumeBlock(current, renderResumeBlock(state)));
    outcomes.push({ surface: 'memory', ok: true, detail: memPath });
  } catch (e) {
    outcomes.push({
      surface: 'memory',
      ok: false,
      detail: `skipped: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // (c) work-graph upsert — stable title key; update-or-create.
  try {
    const store = workGraphStore({
      dbUrl: `file:${join(OPENSQUID_HOME(), 'workgraph.db')}`,
      sourceDir: join(OPENSQUID_HOME(), 'store', 'issues'),
    });
    await store.init();
    const title = `handoff-${state.sessionId.slice(0, 8)}`;
    const existing = (await store.listIssues()).find((i) => i.title === title);
    if (existing !== undefined) {
      await store.updateIssue(existing.id, { body: renderWgDigest(state) });
    } else {
      await store.createIssue({ title, body: renderWgDigest(state) });
    }
    outcomes.push({ surface: 'workgraph', ok: true, detail: title });
  } catch (e) {
    outcomes.push({
      surface: 'workgraph',
      ok: false,
      detail: `skipped: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // (d) chat — best-effort notification; daemon down / no binding → note,
  // never fail. The daemon's send RPC needs the `telegram:<chat_id>` wire
  // form (live spike finding: 'project:telegram' is an MCP-bridge shorthand,
  // not a daemon channel) — resolve via channels.json like the bridge does.
  try {
    const cfg = await loadChannelsConfig();
    if (cfg === null) throw new Error('no channels.json — chat surface skipped');
    const umbrella = resolveUmbrellaForCwd(cfg, state.cwd) ?? GENERAL_UMBRELLA;
    const tg = resolveOutbound(cfg, umbrella);
    if (tg === null) throw new Error(`umbrella '${umbrella}' has no telegram binding`);
    const result = await sendChat({
      channel: `telegram:${tg.chat_id}`,
      text: renderChatDigest(state),
      ...(tg.topic_id !== undefined ? { threadId: String(tg.topic_id) } : {}),
    });
    outcomes.push({ surface: 'chat', ok: true, detail: JSON.stringify(result).slice(0, 120) });
  } catch (e) {
    outcomes.push({
      surface: 'chat',
      ok: false,
      detail: `skipped: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  return { docPath, outcomes };
}
