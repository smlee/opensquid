/**
 * YOLO mode — two-level config field (global + per-project override) with a session env override.
 * Precedence: env → project config → global config → legacy marker → OFF. Each test sandboxes its own
 * OPENSQUID_HOME + project dir so it never touches real state.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isYoloMode, setYolo, yoloStatus, yoloMarkerPath } from './yolo.js';

const PRIOR_HOME = process.env.OPENSQUID_HOME;
const PRIOR_ENV = process.env.OPENSQUID_YOLO;

let home: string;
let project: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'osq-yolo-home-'));
  project = await mkdtemp(join(tmpdir(), 'osq-yolo-proj-'));
  await mkdir(join(project, '.opensquid'), { recursive: true }); // project-scope marker
  process.env.OPENSQUID_HOME = home;
  delete process.env.OPENSQUID_YOLO;
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
  if (PRIOR_HOME === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = PRIOR_HOME;
  if (PRIOR_ENV === undefined) delete process.env.OPENSQUID_YOLO;
  else process.env.OPENSQUID_YOLO = PRIOR_ENV;
});

const writeProjectConfig = (obj: unknown) =>
  writeFile(join(project, '.opensquid', 'config.json'), JSON.stringify(obj), 'utf8');

describe('isYoloMode — config resolution', () => {
  it('default (nothing set) → OFF', async () => {
    expect(await isYoloMode(project)).toBe(false);
  });

  it('global ON → a project with NO key inherits it', async () => {
    await setYolo(true, 'global');
    expect(await isYoloMode(project)).toBe(true); // inherited
  });

  it('project key OVERRIDES global (opt-out under global-ON)', async () => {
    await setYolo(true, 'global');
    await setYolo(false, 'project', project);
    expect(await isYoloMode(project)).toBe(false); // project false beats global true
  });

  it('project key OVERRIDES global (opt-in under global-OFF)', async () => {
    await setYolo(false, 'global');
    await setYolo(true, 'project', project);
    expect(await isYoloMode(project)).toBe(true);
  });

  it('env beats both files (force on / force off)', async () => {
    await setYolo(false, 'global');
    await setYolo(false, 'project', project);
    process.env.OPENSQUID_YOLO = '1';
    expect(await isYoloMode(project)).toBe(true);
    process.env.OPENSQUID_YOLO = 'off';
    await setYolo(true, 'project', project);
    expect(await isYoloMode(project)).toBe(false);
  });
});

describe('setYolo — preserves other config keys', () => {
  it('global write keeps foreign top-level keys (e.g. chat_connections) intact', async () => {
    await writeFile(
      join(home, 'config.json'),
      JSON.stringify({
        version: 1,
        foreign_key: '/x',
        chat_connections: { telegram: { bot_token: 't' } },
      }),
      'utf8',
    );
    await setYolo(true, 'global');
    const { global } = await yoloStatus(project);
    expect(global).toBe(true);
    // round-trip the file: foreign keys survive
    const raw = JSON.parse(
      await (await import('node:fs/promises')).readFile(join(home, 'config.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(raw.foreign_key).toBe('/x');
    expect(
      (raw.chat_connections as { telegram?: { bot_token?: string } }).telegram?.bot_token,
    ).toBe('t');
    expect(raw.yolo).toBe(true);
  });

  it('project key absent → undefined (inherit), present → that boolean', async () => {
    expect((await yoloStatus(project)).project).toBeUndefined();
    await writeProjectConfig({ version: 1, yolo: false });
    expect((await yoloStatus(project)).project).toBe(false);
  });
});

describe('legacy marker (deprecated back-compat)', () => {
  it('marker present → ON when no config field set; cleared on a global write', async () => {
    await writeFile(yoloMarkerPath(), 'on\n', 'utf8');
    expect(await isYoloMode(project)).toBe(true); // legacy fallback
    await setYolo(false, 'global'); // migrate: writes global false + removes the marker
    expect(await isYoloMode(project)).toBe(false);
  });
});
