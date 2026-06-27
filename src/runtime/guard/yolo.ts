/**
 * YOLO mode — the explicit, user-set setting that moves the Safety floor's `dangerous` tier from block → warn
 * (the call PROCEEDS but is surfaced + recorded as a drift). It NEVER affects the `hardline` tier: `rm -rf`,
 * substrate DELETE, and `.env` exfil always `halt`, regardless of this setting (enforced in `checkSafety`,
 * not here).
 *
 * Two-level config field `"yolo": boolean`, global + project, with a session env override:
 *   - GLOBAL  `<home>/.opensquid/config.json` `"yolo"` — the default carried by every project.
 *   - PROJECT `<project>/.opensquid/config.json` `"yolo"` — overrides global FOR THAT PROJECT when the key is
 *     present (so a project can opt OUT of a global-ON, or opt IN under a global-OFF). A project with no
 *     `yolo` key INHERITS global.
 *   - env `OPENSQUID_YOLO` (`1`/`on` … or `0`/`off`) — a session/CI override that beats both files.
 *
 * Resolution precedence (per cwd): env → project → global → legacy marker → OFF. "Key present" semantics are
 * load-bearing: `undefined` (key absent) means INHERIT, while `false` is an explicit opt-out.
 *
 * Both config writes preserve every other top-level key (read-modify-write) so `engine_bin` / `chat_connections`
 * are never clobbered. The legacy `<home>/.opensquid/yolo` marker is still READ (deprecated back-compat) and is
 * removed the next time global YOLO is written.
 *
 * FAIL-SAFE: any read error ⇒ that source contributes nothing; an all-miss resolves OFF (full enforcement).
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { OPENSQUID_HOME, resolveProjectScopeRoot } from '../paths.js';

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);
const FALSY = new Set(['0', 'false', 'off', 'no']);

export type YoloScope = 'global' | 'project';

/** Global config path (`<home>/.opensquid/config.json`). */
function globalConfigPath(): string {
  return join(OPENSQUID_HOME(), 'config.json');
}

/** Project config path (`<project>/.opensquid/config.json`), or null when cwd has no project scope. */
async function projectConfigPath(cwd: string): Promise<string | null> {
  const root = await resolveProjectScopeRoot(cwd);
  return root === null ? null : join(root, 'config.json');
}

/** Read the `yolo` boolean from a config.json. `undefined` when the file/key is absent or not a boolean. */
async function readYoloField(path: string | null): Promise<boolean | undefined> {
  if (path === null) return undefined;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    return typeof parsed.yolo === 'boolean' ? parsed.yolo : undefined;
  } catch {
    return undefined; // missing / malformed → contributes nothing
  }
}

/** Session env override: present → boolean (truthy/falsy token), absent/unrecognized → undefined. */
function envYolo(): boolean | undefined {
  const v = process.env.OPENSQUID_YOLO?.trim().toLowerCase();
  if (v === undefined || v === '') return undefined;
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return undefined;
}

/** The legacy marker path (`<home>/.opensquid/yolo`) — deprecated; superseded by the global config field. */
export function yoloMarkerPath(): string {
  return join(OPENSQUID_HOME(), 'yolo');
}

/** Deprecated back-compat: presence of the legacy marker = global ON. */
async function legacyMarkerOn(): Promise<boolean> {
  try {
    await readFile(yoloMarkerPath(), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Is YOLO mode ON for `cwd`? Precedence: env → project config → global config → legacy marker → OFF.
 * A project's `yolo` key (when present) overrides global; absent → inherit global.
 */
export async function isYoloMode(cwd: string = process.cwd()): Promise<boolean> {
  const env = envYolo();
  if (env !== undefined) return env;
  const project = await readYoloField(await projectConfigPath(cwd));
  if (project !== undefined) return project;
  const global = await readYoloField(globalConfigPath());
  if (global !== undefined) return global;
  return legacyMarkerOn();
}

/** Read-modify-write the `yolo` field into a config.json, PRESERVING every other top-level key. */
async function writeYoloField(path: string, on: boolean): Promise<void> {
  let obj: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (typeof parsed === 'object' && parsed !== null) obj = parsed as Record<string, unknown>;
  } catch {
    /* new / malformed file → start fresh (and re-seed version below) */
  }
  if (obj.version === undefined) obj.version = 1;
  obj.yolo = on;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

export interface YoloSetResult {
  scope: YoloScope;
  path: string;
  on: boolean;
}

/**
 * Set YOLO at GLOBAL or PROJECT scope (writes the config `yolo` field). Run by the USER's CLI — not an agent
 * tool call. A global write also clears the deprecated legacy marker (one-time migration).
 */
export async function setYolo(
  on: boolean,
  scope: YoloScope,
  cwd: string = process.cwd(),
): Promise<YoloSetResult> {
  if (scope === 'project') {
    const root = (await resolveProjectScopeRoot(cwd)) ?? join(cwd, '.opensquid');
    const path = join(root, 'config.json');
    await writeYoloField(path, on);
    return { scope, path, on };
  }
  const path = globalConfigPath();
  await writeYoloField(path, on);
  await rm(yoloMarkerPath(), { force: true }); // migrate away from the legacy marker
  return { scope, path, on };
}

export interface YoloStatus {
  /** The resolved effective value for `cwd`. */
  on: boolean;
  env: boolean | undefined;
  project: boolean | undefined;
  global: boolean | undefined;
}

/** Resolved YOLO status + per-source breakdown (for `opensquid yolo status`). */
export async function yoloStatus(cwd: string = process.cwd()): Promise<YoloStatus> {
  const env = envYolo();
  const project = await readYoloField(await projectConfigPath(cwd));
  const global = await readYoloField(globalConfigPath());
  const legacy = await legacyMarkerOn();
  return { on: env ?? project ?? global ?? legacy, env, project, global };
}
