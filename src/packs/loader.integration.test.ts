/**
 * Integration test for PR-followup: end-to-end load of a pack that ships
 * both `models.yaml` AND `drift_response.yaml`, then verify the loaded
 * `Pack` exposes the fields the runtime consumers (`functions/llm.ts` +
 * `runtime/hooks/dispatch.ts`) will read.
 *
 * Fixture mirrors the shape of `sangmin-personal-rules` (PR-shipped pack
 * with one fast_classifier alias + per-rule drift_response overrides
 * including `block_tool` for `v1-publish-detector` and `model-name-detector`)
 * but is fully self-contained under a tmpdir so it doesn't reach into
 * `~/.opensquid/codexes/` (test isolation + CI safety).
 *
 * The live verification step from the PR-followup spec (Part 2 §4 —
 * `v1-publish-detector`'s per-rule `block_tool` resolves through the new
 * code path) is exercised here at the data layer; the dispatcher-side
 * resolution is exercised in `runtime/hooks/dispatch.test.ts` updates.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadPack } from './loader.js';

describe('loadPack integration — pack with both models.yaml + drift_response.yaml (PR-followup)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'opensquid-pr-followup-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads a sangmin-personal-rules-shaped pack with both side files folded in', async () => {
    // manifest.yaml — minimal valid (4 required fields).
    await writeFile(
      join(dir, 'manifest.yaml'),
      [
        'name: integration-fixture',
        'version: 0.1.0',
        'scope: project',
        'goal: PR-followup live integration',
      ].join('\n') + '\n',
      'utf8',
    );

    // models.yaml — single fast_classifier alias, subscription+cli mode.
    // Matches the one-alias shape that PR-shipped pack lands on (codex side
    // intentionally leaves cli/args/model blank for the user to fill).
    await writeFile(
      join(dir, 'models.yaml'),
      [
        'fast_classifier:',
        '  description: integration fixture classifier',
        '  mode: subscription',
        '  impl: cli',
      ].join('\n') + '\n',
      'utf8',
    );

    // drift_response.yaml — mirror the PR pack: default notify_and_pause +
    // per-rule overrides for v1-publish-detector + model-name-detector
    // (`block_tool`) plus gray-area + informational tiers.
    await writeFile(
      join(dir, 'drift_response.yaml'),
      [
        'default: notify_and_pause',
        'per_rule:',
        '  v1-publish-detector: block_tool',
        '  model-name-detector: block_tool',
        '  compile-distribution-locks: notify_and_pause',
        '  pause-prompt-extended: warn',
        '  stale-cite-detector: warn',
        'corrective_skills: {}',
      ].join('\n') + '\n',
      'utf8',
    );

    // skills/ stays empty — this fixture exercises the side-file loaders;
    // skill-side rule walking is covered by `dispatch.test.ts`.

    const pack = await loadPack(dir);

    // ----- models.yaml verification -----
    expect(pack.models).toBeDefined();
    const fastClassifier = pack.models?.fast_classifier;
    expect(fastClassifier).toBeDefined();
    expect(fastClassifier?.mode).toBe('subscription');
    expect(fastClassifier?.impl).toBe('cli');
    expect(fastClassifier?.description).toBe('integration fixture classifier');
    // Schema-defaulted fields.
    expect(fastClassifier?.args).toEqual([]);

    // ----- drift_response.yaml verification -----
    expect(pack.driftResponse).toBeDefined();
    expect(pack.driftResponse?.default).toBe('notify_and_pause');
    // The headline PR-followup verification: per-rule `block_tool` for
    // v1-publish-detector is now in the loaded Pack and ready for the
    // dispatcher to consume.
    expect(pack.driftResponse?.per_rule['v1-publish-detector']).toBe('block_tool');
    expect(pack.driftResponse?.per_rule['model-name-detector']).toBe('block_tool');
    expect(pack.driftResponse?.per_rule['compile-distribution-locks']).toBe('notify_and_pause');
    expect(pack.driftResponse?.per_rule['pause-prompt-extended']).toBe('warn');
    expect(pack.driftResponse?.per_rule['stale-cite-detector']).toBe('warn');
    // Unknown rule id falls through to `?? default`.
    expect(pack.driftResponse?.per_rule['unknown-rule']).toBeUndefined();
    expect(pack.driftResponse?.corrective_skills).toEqual({});
  });

  it('loads a pack with neither models.yaml nor drift_response.yaml (both undefined)', async () => {
    // Sanity check the absence path — confirms the loader does not invent
    // empty side-file objects when the files are absent.
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: bare-pack', 'version: 0.1.0', 'scope: workflow', 'goal: bare'].join('\n') + '\n',
      'utf8',
    );
    await mkdir(join(dir, 'skills'), { recursive: true });

    const pack = await loadPack(dir);
    expect(pack.models).toBeUndefined();
    expect(pack.driftResponse).toBeUndefined();
  });

  it('loads a pack with only models.yaml (driftResponse stays undefined)', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: models-only', 'version: 0.1.0', 'scope: workflow', 'goal: models only'].join('\n') +
        '\n',
      'utf8',
    );
    await writeFile(
      join(dir, 'models.yaml'),
      ['fast_classifier:', '  mode: subscription', '  impl: cli'].join('\n') + '\n',
      'utf8',
    );

    const pack = await loadPack(dir);
    expect(pack.models?.fast_classifier?.mode).toBe('subscription');
    expect(pack.driftResponse).toBeUndefined();
  });

  it('loads a pack with only drift_response.yaml (models stays undefined)', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: drift-only', 'version: 0.1.0', 'scope: workflow', 'goal: drift only'].join('\n') +
        '\n',
      'utf8',
    );
    await writeFile(
      join(dir, 'drift_response.yaml'),
      ['default: warn', 'per_rule:', '  some-rule: block_tool'].join('\n') + '\n',
      'utf8',
    );

    const pack = await loadPack(dir);
    expect(pack.models).toBeUndefined();
    expect(pack.driftResponse?.default).toBe('warn');
    expect(pack.driftResponse?.per_rule['some-rule']).toBe('block_tool');
  });
});
