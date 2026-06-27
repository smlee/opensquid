/** YOLO mode — env-wins toggle (env `OPENSQUID_YOLO` or the persistent marker), fail-safe OFF. */
import { rm } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isYoloMode, setYoloMarker, yoloMarkerPath } from './yolo.js';

const ENV = process.env.OPENSQUID_YOLO;
beforeEach(() => {
  delete process.env.OPENSQUID_YOLO;
});
afterEach(async () => {
  await rm(yoloMarkerPath(), { force: true });
  if (ENV === undefined) delete process.env.OPENSQUID_YOLO;
  else process.env.OPENSQUID_YOLO = ENV;
});

describe('isYoloMode', () => {
  it('default (no env, no marker) → OFF (fail-safe to full enforcement)', async () => {
    expect(await isYoloMode()).toBe(false);
  });

  it('env OPENSQUID_YOLO truthy → ON (1/true/on/yes)', async () => {
    for (const v of ['1', 'true', 'on', 'YES']) {
      process.env.OPENSQUID_YOLO = v;
      expect(await isYoloMode()).toBe(true);
    }
  });

  it('env present but falsy → OFF', async () => {
    process.env.OPENSQUID_YOLO = '0';
    expect(await isYoloMode()).toBe(false);
  });

  it('marker on → ON; marker off (removed) → OFF', async () => {
    await setYoloMarker(true);
    expect(await isYoloMode()).toBe(true);
    await setYoloMarker(false);
    expect(await isYoloMode()).toBe(false);
  });

  it('env wins over a missing marker (env ON, no marker → ON)', async () => {
    process.env.OPENSQUID_YOLO = '1';
    await setYoloMarker(false);
    expect(await isYoloMode()).toBe(true);
  });
});
