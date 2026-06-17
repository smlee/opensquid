/**
 * Side-effect layer for WIZ.3 — file-system writes the chat-setup wizard
 * performs in step (g) after the user confirms the dry-run preview.
 *
 * Split out of `chat_actions.ts` to keep the orchestrator's prompt-driving
 * flow under the LOC budget. This module is the ONLY place that creates
 * directories, writes files, or sets file modes; the orchestrator passes
 * a fully-formed `WritePlan` and never invokes `fs.*` directly.
 *
 * Discipline:
 *   - Atomic writes: tmp file (`<target>.tmp.<pid>.<ts>`) → `fs.rename`.
 *     POSIX `rename(2)` is atomic; if it fails after we've created a tmp,
 *     we unlink the tmp on cleanup so no `.tmp.<pid>` litter remains.
 *   - Backups: before any overwrite, copy the existing file into
 *     `~/.opensquid/backup/<isoTs>/<basename>`. The directory is created
 *     fresh per wizard run (timestamp guarantees uniqueness). If no files
 *     are being replaced the backup dir is still created — outro tells the
 *     user the path either way for symmetry.
 *   - Rollback: on first write failure, copy each backed-up file BACK to
 *     its original location and rethrow. Files that hadn't been written
 *     yet need no rollback (their target is unchanged from the start).
 *   - chmod 0600 on `<OPENSQUID_HOME>/.env` ALWAYS — even when we appended a
 *     single line, the goal is to enforce the secrets-backend invariant.
 *   - YAML serialization via `yaml.stringify` (yaml@2). The schema's Zod
 *     defaults are written explicitly so the file is self-documenting; we
 *     don't omit a key just because it equals its default. Comments are
 *     NOT preserved in models.yaml merges — the wizard owns its alias
 *     block but writes back a fresh document; per-pack chat_agent.yaml
 *     files are always freshly authored.
 *
 * Imports from: node:fs/promises, node:path, yaml.
 * Imported by: src/setup/cli/chat_actions.ts.
 */

import { readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, unlink, writeFile, chmod } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

import { parseDocument, stringify as yamlStringify } from 'yaml';

import type { ChatAgentConfig } from '../../packs/schemas/chat_agent.js';
import { ModelsConfig, type ModelAlias } from '../../packs/schemas/models.js';

import type { ModelsState } from './chat_state.js';

// ---------------------------------------------------------------------------
// Plan shape — what the orchestrator hands to executePlan() after the user
// confirms. Each entry is a single file write; the executor decides backup
// + tmp + rename based on whether the target exists.
// ---------------------------------------------------------------------------

export type WriteAction =
  | { kind: 'create_or_replace'; path: string; content: string; mode?: number }
  | { kind: 'append'; path: string; appendBlock: string; mode?: number };

export interface WritePlan {
  /** Absolute path to ~/.opensquid/backup/<isoTs>/ — created during execute. */
  backupDir: string;
  actions: WriteAction[];
}

// ---------------------------------------------------------------------------
// YAML helpers — exported so the orchestrator can render the dry-run preview
// from the same bytes that get written.
// ---------------------------------------------------------------------------

/**
 * Merge a new fast_chat alias into the existing models map (or create the
 * map fresh). Preserves all unrelated aliases verbatim.
 */
export function buildModelsYaml(existing: ModelsConfig, fastChatAlias: ModelAlias): string {
  const next: Record<string, ModelAlias> = { ...existing, fast_chat: fastChatAlias };
  return yamlStringify(next, { indent: 2 });
}

/**
 * Serialize a chat_agent.yaml document. Optional fields are omitted when
 * they equal the schema default to keep the file terse; required fields
 * (default_model) are always present.
 */
export function buildChatAgentYaml(cfg: ChatAgentConfig): string {
  // Shape the output object preserving insertion order for human readers.
  const out: Record<string, unknown> = { default_model: cfg.default_model };
  if (cfg.system_prompt !== undefined && cfg.system_prompt.length > 0) {
    out.system_prompt = cfg.system_prompt;
  }
  if (cfg.skills.length > 0) out.skills = cfg.skills;
  if (cfg.disable_builtins.length > 0) out.disable_builtins = cfg.disable_builtins;
  if (cfg.max_tool_iterations !== 8) out.max_tool_iterations = cfg.max_tool_iterations;
  if (cfg.max_tokens !== 1024) out.max_tokens = cfg.max_tokens;
  return yamlStringify(out, { indent: 2 });
}

/**
 * Minimal `~/.opensquid/channels.json` seed (`ChannelsConfig` v1 — routing.ts
 * schema; `telegram` optional on UmbrellaRow, target arrives by manual edit).
 * Pure; schema-shaped.
 */
export function buildChannelsSeedJson(umbrellaId: string, memberPath: string): string {
  return `${JSON.stringify({ v: 1, umbrellas: [{ id: umbrellaId, members: [memberPath] }] }, null, 2)}\n`;
}

/**
 * The user-scope `active.json` (`{ packs: string[] }` — discovery.ts schema).
 * The ONE owner of merge+dedupe+serialize; pure (deterministic in inputs).
 */
export function buildActiveJson(existing: string[], packId: string): string {
  return `${JSON.stringify({ packs: [...new Set([...existing, packId])] }, null, 2)}\n`;
}

/**
 * PT.1 — reciprocal of `buildActiveJson`: serialize `existing` minus `packId`.
 * Pure; same "ONE owner of serialize" role. No-op (identity, minus the entry)
 * when `packId` is absent.
 */
export function removeFromActiveJson(existing: string[], packId: string): string {
  return `${JSON.stringify({ packs: existing.filter((p) => p !== packId) }, null, 2)}\n`;
}

/**
 * PT.1 — tolerant read of a scope root's `active.json` pack-name list. ENOENT →
 * `[]` (absent scope is empty, mirrors `discoverActivePacks` discovery.ts:218);
 * a JSON PARSE error THROWS with the path (never silently overwrite a file we
 * couldn't parse — it may hold packs we'd drop, discovery.ts:213-214); a parsed
 * object with a non-array `packs` → `[]`.
 */
export async function readActivePackNames(scopeRoot: string): Promise<string[]> {
  const path = join(scopeRoot, 'active.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`opensquid: failed to parse ${path} as JSON: ${(e as Error).message}`);
  }
  const packs = (parsed as { packs?: unknown }).packs;
  return Array.isArray(packs) ? packs.filter((p): p is string => typeof p === 'string') : [];
}

/**
 * The `.opensquid/project.json` card (paths.ts ProjectCard schema).
 * GENUINELY pure — deterministic in its inputs, byte-pinnable in tests; the
 * uuid is minted at the ORCHESTRATOR (which owns create-if-absent), not here.
 */
export function buildProjectCardJson(id: string, uuid: string): string {
  return `${JSON.stringify({ version: 1, id, uuid }, null, 2)}\n`;
}

/**
 * Build the `KEY=value` line(s) appended to ~/.opensquid/.env. We trim trailing
 * whitespace on the prior file (if any) and prepend a newline so the new
 * block is line-separated from prior content.
 */
export function buildEnvAppendBlock(entries: { key: string; value: string }[]): string {
  const body = entries.map((e) => `${e.key}=${e.value}`).join('\n');
  return `${body}\n`;
}

// ---------------------------------------------------------------------------
// pathExists — local helper (we deliberately don't import chat_state's
// helpers; this module stays self-contained for write-side concerns).
// ---------------------------------------------------------------------------

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    // Other errors (EACCES etc.) — treat as "exists, but we'll fail later
    // when we try to back it up"; surfacing here would mask the real cause.
    return true;
  }
}

async function atomicWriteText(path: string, value: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${String(process.pid)}.${String(Date.now())}`;
  try {
    await writeFile(tmp, value, 'utf8');
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (err) {
    // Best-effort tmp cleanup; if unlink fails the rename already failed
    // and the caller will see the original error.
    try {
      await unlink(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// executePlan — the single side-effecting entry point.
//
// Flow:
//   1. mkdir -p backupDir
//   2. For each action whose target exists, copy target → backup dir.
//   3. For each action, compute final content (read+append for append; write
//      for create_or_replace) and atomic-rename.
//   4. On any failure: restore from backup, rethrow.
//
// Returns: { written: string[]; backedUp: string[] } so the orchestrator
// can render the success outro.
// ---------------------------------------------------------------------------

export interface ExecuteResult {
  written: string[];
  backedUp: string[];
}

export async function executePlan(plan: WritePlan): Promise<ExecuteResult> {
  await mkdir(plan.backupDir, { recursive: true });
  const backedUp: { original: string; backup: string }[] = [];
  for (const action of plan.actions) {
    if (await pathExists(action.path)) {
      const backupPath = join(plan.backupDir, basename(action.path));
      await copyFile(action.path, backupPath);
      backedUp.push({ original: action.path, backup: backupPath });
    }
  }

  const written: string[] = [];
  try {
    for (const action of plan.actions) {
      const finalContent = await materializeContent(action);
      await atomicWriteText(action.path, finalContent, action.mode);
      written.push(action.path);
    }
  } catch (err) {
    // Rollback: restore every backed-up original. Anything we wrote BEFORE
    // the failure gets reverted; anything we hadn't written yet stays at
    // its pre-wizard state already.
    for (const b of backedUp) {
      try {
        await copyFile(b.backup, b.original);
      } catch {
        /* best-effort; surfaced via rethrow below */
      }
    }
    throw err;
  }

  return { written, backedUp: backedUp.map((b) => b.backup) };
}

// ---------------------------------------------------------------------------
// Plan assembly + dry-run preview rendering
// ---------------------------------------------------------------------------

export interface PlanInput {
  homeDir: string;
  envPath: string;
  modelsState: ModelsState;
  fastChatAlias: ModelAlias;
  apiKey: string | null;
  storeKey: boolean;
  packId: string;
  packRoot: string;
  chatAgent: ChatAgentConfig;
  createPackManifest: boolean;
  customPromptPath?: string;
  customPromptBody?: string;
  /** T-FIX-FIRST-RUN-SETUP A: mint .opensquid/project.json when the FULL
   *  resolution (env, then cwd-walk) found no project identity. Orchestrator-
   *  gated: an env uuid or an existing card suppresses this input entirely —
   *  suppression IS the idempotency; buildPlan never decides. */
  projectCard?: { path: string; id: string; uuid: string };
  /** FRS.B: write user-scope active.json on EXPLICIT consent (the activation
   *  prompt + the plan confirm both gate it — no silent install). Raw
   *  existing list from the orchestrator; buildActiveJson owns the merge. */
  activatePack?: { path: string; existing: string[]; packId: string };
  /** FRS.C: seed minimal channels.json ONLY when the file does not exist
   *  (existence-checked at the orchestrator — a present-but-malformed live
   *  config is the doctor's territory, never the wizard's). */
  channelsSeed?: { path: string; umbrellaId: string; memberPath: string };
}

export function buildPlan(input: PlanInput): WritePlan {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(input.homeDir, 'backup', iso);
  const actions: WriteAction[] = [];
  const existing: ModelsConfig = input.modelsState.present
    ? readModelsSync(input.modelsState.path)
    : {};
  actions.push({
    kind: 'create_or_replace',
    path: input.modelsState.path,
    content: buildModelsYaml(existing, input.fastChatAlias),
  });
  if (input.apiKey !== null && input.storeKey) {
    actions.push({
      kind: 'append',
      path: input.envPath,
      appendBlock: buildEnvAppendBlock([{ key: 'ANTHROPIC_API_KEY', value: input.apiKey }]),
      mode: 0o600,
    });
  }
  if (input.createPackManifest) {
    actions.push({
      kind: 'create_or_replace',
      path: join(input.packRoot, 'manifest.yaml'),
      content: `name: ${input.packId}\nversion: 0.0.1\nscope: project\ngoal: starter chat-agent pack (configured via opensquid setup chat)\n`,
    });
  }
  if (input.projectCard !== undefined) {
    actions.push({
      kind: 'create_or_replace',
      path: input.projectCard.path,
      content: buildProjectCardJson(input.projectCard.id, input.projectCard.uuid),
    });
  }
  if (input.activatePack !== undefined) {
    actions.push({
      kind: 'create_or_replace',
      path: input.activatePack.path,
      content: buildActiveJson(input.activatePack.existing, input.activatePack.packId),
    });
  }
  if (input.channelsSeed !== undefined) {
    actions.push({
      kind: 'create_or_replace',
      path: input.channelsSeed.path,
      content: buildChannelsSeedJson(input.channelsSeed.umbrellaId, input.channelsSeed.memberPath),
    });
  }
  actions.push({
    kind: 'create_or_replace',
    path: join(input.packRoot, 'chat_agent.yaml'),
    content: buildChatAgentYaml(input.chatAgent),
  });
  if (input.customPromptPath !== undefined && input.customPromptBody !== undefined) {
    actions.push({
      kind: 'create_or_replace',
      path: join(input.packRoot, input.customPromptPath),
      content: `${input.customPromptBody}\n`,
    });
  }
  return { backupDir, actions };
}

/**
 * Sync re-parse of models.yaml at plan-build time. Detector already gated
 * on parseError; ENOENT / mid-flight write race falls back to `{}`, the
 * dry-run preview then shows only our new alias and user can back out.
 */
function readModelsSync(path: string): ModelsConfig {
  try {
    const raw = readFileSync(path, 'utf8');
    const doc = parseDocument(raw, { strict: true });
    const parsed = ModelsConfig.safeParse(doc.toJSON() ?? {});
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * Render the dry-run preview. Masks every `=value` segment of an append
 * block to `=…<last4>` so secret-shaped writes never display in clear.
 */
export function renderPlanPreview(plan: WritePlan): string {
  const lines: string[] = ['Ready to write. Review the plan:', ''];
  for (let i = 0; i < plan.actions.length; i += 1) {
    const action = plan.actions[i];
    if (action === undefined) continue;
    const verb = action.kind === 'append' ? 'APPEND' : 'CREATE_OR_REPLACE';
    lines.push(`${String(i + 1)}. ${action.path}  [${verb}]`);
    if (action.kind === 'append') {
      const masked = action.appendBlock.replace(
        /=([^\n]+)/g,
        (_m, v: string) => `=…${v.slice(-4)}`,
      );
      lines.push(`     ${masked.trim()}`);
    } else {
      const split = action.content.split('\n');
      lines.push(`     ${split.slice(0, 8).join('\n     ')}`);
      if (split.length > 8) lines.push('     ...');
    }
    lines.push('');
  }
  lines.push('Backups of overwritten files will be saved to:');
  lines.push(`  ${plan.backupDir}`);
  return lines.join('\n');
}

async function materializeContent(action: WriteAction): Promise<string> {
  if (action.kind === 'create_or_replace') return action.content;
  // append — read prior, ensure trailing newline before appending.
  let prior = '';
  try {
    prior = await readFile(action.path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const sep = prior.length === 0 || prior.endsWith('\n') ? '' : '\n';
  return `${prior}${sep}${action.appendBlock}`;
}
