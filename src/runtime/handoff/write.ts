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

import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { readSessionCwd } from '../session_state.js';
import { sessionStateFile } from '../paths.js';

import { sendChat } from '../../chat_daemon/client.js';
import {
  GENERAL_UMBRELLA,
  loadChannelsConfig,
  resolveOutbound,
  resolveUmbrellaForCwd,
} from '../../channels/routing.js';
import { workGraphStore } from '../../workgraph/store.js';
import { resolveActorId } from '../actor_id.js';
import { OPENSQUID_HOME, resolveLocalStoreDir } from '../paths.js';

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

export function memoryMdPathFor(root: string): string {
  return join(homedir(), '.claude', 'projects', encodeProjectPath(root), 'memory', 'MEMORY.md');
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

// ---------------------------------------------------------------------------
// HRA.1 (wg-c34349377f81) — the project-root-scoped in-flight guard for surface
// (b). MEMORY.md is per-project-root, so ONLY a same-root sibling session
// with a fresh tool-ledger may suppress the resume-block splice (a global
// scan would let any other project's live session silently stale this
// project's block — the spec-review correction). Doc/wg/chat are NEVER
// guarded: their redundancy is what makes the skip safe. Fail direction is
// always OPEN (write the block) — unattributable/absent facts never count
// as in-flight. (UCC.2: "root" is the .opensquid marker root, not the chat umbrella.)
// ---------------------------------------------------------------------------

export interface SiblingFact {
  sid: string;
  /** recorded cwd (session_state.readSessionCwd), realpath-canonicalized; null when unattributable. */
  cwd: string | null;
  /** tool-ledger mtime ms, null when absent/unreadable. */
  ledgerMtimeMs: number | null;
}

/** The first OTHER session under THIS project root with a fresh ledger, or null.
 *  freshMs default 10min = the FXK.2 live-session quiet-gap bound (the 340s
 *  audit wait + margin). Pure — all facts injected. */
export function inFlightSibling(args: {
  siblings: SiblingFact[];
  root: string;
  dyingSid: string;
  nowMs: number;
  freshMs?: number;
}): string | null {
  const fresh = args.freshMs ?? 10 * 60_000;
  const root = args.root.endsWith('/') ? args.root : `${args.root}/`;
  for (const s of args.siblings) {
    if (s.sid === args.dyingSid) continue;
    if (s.cwd === null || s.ledgerMtimeMs === null) continue; // unattributable → fail-open
    const cwd = s.cwd.endsWith('/') ? s.cwd : `${s.cwd}/`;
    if (!cwd.startsWith(root)) continue; // other project root → never suppresses
    if (args.nowMs - s.ledgerMtimeMs <= fresh) return s.sid;
  }
  return null;
}

/** realpath-or-identity: a symlink-alias cwd of the project root must still
 *  match the prefix test; unresolvable paths return as-is (fail-open at the
 *  comparison). */
async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/** Exported for the impure-shell test (tmp OPENSQUID_HOME + symlink pin). */
export async function gatherSiblingFacts(): Promise<SiblingFact[]> {
  const dir = join(OPENSQUID_HOME(), 'sessions');
  const out: SiblingFact[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out; // no sessions dir → no siblings → fail-open
  }
  for (const sid of entries) {
    let cwd: string | null = null;
    let ledgerMtimeMs: number | null = null;
    try {
      const recorded = await readSessionCwd(sid);
      cwd = recorded === null ? null : await canonical(recorded);
    } catch {
      /* unattributable */
    }
    try {
      ledgerMtimeMs = (await stat(sessionStateFile(sid, 'tool-ledger'))).mtimeMs;
    } catch {
      /* absent */
    }
    out.push({ sid, cwd, ledgerMtimeMs });
  }
  return out;
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
  const docPath = handoverDocPath(state.root, state.sessionId);

  // (a) the doc — the load-bearing record; a failure here IS a handoff failure.
  const docBody = renderHandoverDoc(state);
  await atomicWrite(
    docPath,
    opts.narrative === undefined ? docBody : spliceNarrative(docBody, opts.narrative),
  );
  outcomes.push({ surface: 'doc', ok: true, detail: docPath });

  // (b) MEMORY.md managed region — absent file → skip (not all hosts run
  // auto-memory). HRA.1: a fresh same-project-root sibling owns the resume
  // block — a dying nested/sibling session must not overwrite the live
  // session's resume surface (observed twice on 2026-06-11 pre-fix).
  const sibling = inFlightSibling({
    siblings: await gatherSiblingFacts(),
    root: await canonical(state.root),
    dyingSid: state.sessionId,
    nowMs: Date.now(),
  });
  if (sibling !== null) {
    outcomes.push({
      surface: 'memory',
      ok: false,
      detail: `skipped: in-flight sibling ${sibling.slice(0, 8)} owns this umbrella's resume block`,
    });
  } else {
    const memPath = memoryMdPathFor(state.root);
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
  }

  // (c) work-graph upsert — stable title key; update-or-create.
  try {
    // T-project-local-state PLS.2: upsert into THIS project's LOCAL store (`<root>/.opensquid/workgraph.db`,
    // resolved from the session's cwd) — the store IS the project's, no namespace binding.
    const dir = await resolveLocalStoreDir(state.cwd);
    const store = workGraphStore({
      dbUrl: `file:${join(dir, 'workgraph.db')}`,
      sourceDir: join(dir, 'store', 'issues'),
      actorId: await resolveActorId(), // WGD.1 — stamp the per-replica id on ops
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
