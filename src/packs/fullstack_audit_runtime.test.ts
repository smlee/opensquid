import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { dispatchCachedAudit } from '../functions/cached_audit.js';
import { readAuditTelemetryTail } from '../runtime/loop/audit_telemetry.js';
import { readTaskAuditCache } from '../runtime/loop/task_audit_cache.js';

const PACK_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packs',
  'builtin',
  'fullstack-flow',
);

let home: string;
let priorHome: string | undefined;
let priorModels: string | undefined;
let priorProject: string | undefined;
let priorItem: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  priorModels = process.env.OPENSQUID_MODELS_CONFIG_INLINE;
  priorProject = process.env.OPENSQUID_PROJECT_ROOT;
  priorItem = process.env.OPENSQUID_ITEM_ID;
  home = await mkdtemp(join(tmpdir(), 'opensquid-pack-audit-runtime-'));
  await mkdir(join(home, '.opensquid'));
  process.env.OPENSQUID_HOME = home;
  process.env.OPENSQUID_PROJECT_ROOT = home;
  process.env.OPENSQUID_ITEM_ID = 'wg-pack-audit-runtime';
  const fake = join(home, 'reviewer.js');
  await writeFile(
    fake,
    `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('VERDICT: GUESS_FREE'));`,
    'utf8',
  );
  process.env.OPENSQUID_MODELS_CONFIG_INLINE = JSON.stringify({
    reasoning: { mode: 'subscription', impl: 'cli', cli: process.execPath, args: [fake] },
  });
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  if (priorModels === undefined) delete process.env.OPENSQUID_MODELS_CONFIG_INLINE;
  else process.env.OPENSQUID_MODELS_CONFIG_INLINE = priorModels;
  if (priorProject === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
  else process.env.OPENSQUID_PROJECT_ROOT = priorProject;
  if (priorItem === undefined) delete process.env.OPENSQUID_ITEM_ID;
  else process.env.OPENSQUID_ITEM_ID = priorItem;
  await rm(home, { recursive: true, force: true });
});

describe('fullstack-flow pack → live cached_audit runtime', () => {
  it('dispatches the actual CODE YAML policy through registry, model, ledger, and cache', async () => {
    const yaml = parse(
      await readFile(join(PACK_DIR, 'skills', 'content-audit', 'skill.yaml'), 'utf8'),
    ) as {
      rules: { id: string; process: { call: string; args?: Record<string, unknown> }[] }[];
    };
    const step = yaml.rules
      .find((rule) => rule.id === 'code-guess-free-audit')
      ?.process.find((candidate) => candidate.call === 'cached_audit');
    expect(step?.args).toBeDefined();

    const diff = 'diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n';
    const rubric = '# CODE rubric\nAll declared checks must pass.';
    const raw = structuredClone(step!.args!);
    raw.subject = diff;
    raw.lenses = (raw.lenses as { id: string; prompt: string; criteria?: string[] }[]).map(
      (lens) => ({
        ...lens,
        prompt: lens.prompt.replaceAll('{{rubric}}', rubric).replaceAll('{{diff}}', diff),
      }),
    );

    const sessionId = 'pack-audit-runtime';
    const result = await dispatchCachedAudit(raw, {
      event: { kind: 'stop', assistantText: '' },
      bindings: new Map(),
      sessionId,
      packId: 'fullstack-flow',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatch(/^VERDICT: GUESS_FREE/);

    const entry = await readTaskAuditCache(sessionId, String(raw.cache_key));
    expect(entry?.complete).toBe(true);
    expect(entry?.lenses).toHaveLength(4);
    expect(entry?.verdict).toBeUndefined();
    expect(entry?.subjectHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readAuditTelemetryTail(sessionId, 10)).toHaveLength(4);
  });
});
