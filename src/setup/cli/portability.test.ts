/**
 * POR.1 — export/import/rebuild pins: the round trip, redaction, the
 * fail-closed secret scan, both refusal semantics, and rebuild-failure
 * truth preservation.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Embedder } from '../../rag/embedders/types.js';

import {
  buildExportList,
  isExcluded,
  redactConfig,
  runExport,
  runImport,
  scanForSecrets,
  truthPresent,
} from './portability.js';

let tmp: string;
let srcHome: string;
let dstHome: string;
const lines: string[] = [];
const print = (l: string): void => void lines.push(l);

const SEEDED_MEM = '---\nid: mem-1\n---\nseeded memory body\n';

const fakeEmbedder: Embedder = {
  dim: 4,
  embed: () => Promise.resolve([0.1, 0.2, 0.3, 0.4]),
};

const throwingEmbedder: Embedder = {
  dim: 4,
  embed: () => Promise.reject(new Error('embedder unavailable')),
};

async function seedTruthHome(home: string, opts: { token?: string } = {}): Promise<void> {
  await mkdir(join(home, 'memories'), { recursive: true });
  await mkdir(join(home, 'lessons', 'promoted'), { recursive: true });
  await mkdir(join(home, 'store', 'issues'), { recursive: true });
  await writeFile(join(home, 'active.json'), JSON.stringify({ packs: [] }), 'utf8');
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      version: 1,
      chat_connections: { telegram: { bot_token: opts.token ?? '', allowlist_chat_ids: [] } },
    }),
    'utf8',
  );
  await writeFile(join(home, 'memories', 'mem-1.md'), SEEDED_MEM, 'utf8');
  await writeFile(join(home, 'memories', 'mem-1.vec'), 'binary-vec', 'utf8');
  await writeFile(join(home, 'chat-daemon.sock'), '', 'utf8');
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'opensquid-por-'));
  srcHome = join(tmp, 'src-home');
  dstHome = join(tmp, 'dst-home');
  await mkdir(srcHome, { recursive: true });
  await mkdir(dstHome, { recursive: true });
  await seedTruthHome(srcHome);
  lines.length = 0;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('isExcluded / buildExportList', () => {
  it('denylist excludes projections, runtime junk, .vec, leases; truth stays', async () => {
    expect(isExcluded('rag.sqlite')).toBe(true);
    expect(isExcluded('sessions/x/state/y.json')).toBe(true);
    expect(isExcluded('memories/mem-1.vec')).toBe(true);
    expect(isExcluded('umbrellas/loop/live-session.lease')).toBe(true);
    expect(isExcluded('chat-daemon.sock')).toBe(true);
    expect(isExcluded('models/fast-bge-small-en-v1.5/tokenizer_config.json')).toBe(true);
    expect(isExcluded('memories/mem-1.md')).toBe(false);
    expect(isExcluded('store/issues/op-1.json')).toBe(false);
    const list = await buildExportList(srcHome);
    expect(list).toContain('memories/mem-1.md');
    expect(list).not.toContain('memories/mem-1.vec');
    expect(list).not.toContain('chat-daemon.sock');
  });
});

describe('export → import round trip', () => {
  it('truth identical, exclusions hold, projections rebuild (fake embedder)', async () => {
    const bundle = await runExport({ homeDir: srcHome, out: join(tmp, 'b.tgz'), print });
    await rm(dstHome, { recursive: true, force: true });
    const out = await runImport({ bundle, homeDir: dstHome, embedder: fakeEmbedder, print });
    // The memory rebuild canonicalizes the per-file frontmatter (semantically
    // lossless normalization, by migrateMemories' design) — pin the CONTENT,
    // not the bytes.
    const imported = await readFile(join(dstHome, 'memories', 'mem-1.md'), 'utf8');
    expect(imported).toContain('id: mem-1');
    expect(imported).toContain('seeded memory body');
    expect(existsSync(join(dstHome, 'memories', 'mem-1.vec'))).toBe(false);
    expect(existsSync(join(dstHome, 'chat-daemon.sock'))).toBe(false);
    expect(out.failed).toEqual([]);
    expect(out.rebuilt.some((r) => r.startsWith('memories'))).toBe(true);
    expect(out.rebuilt.some((r) => r.startsWith('lessons'))).toBe(true);
    expect(out.rebuilt.some((r) => r.startsWith('workgraph'))).toBe(true);
  });
});

describe('secrets', () => {
  it('a real-looking bot_token is redacted in the bundle; the live file untouched', async () => {
    await rm(srcHome, { recursive: true, force: true });
    await mkdir(srcHome, { recursive: true });
    await seedTruthHome(srcHome, { token: '8684081234:AAFakeTokenValue' });
    const bundle = await runExport({ homeDir: srcHome, out: join(tmp, 'b.tgz'), print });
    let bundled = '';
    await tar.list({
      file: bundle,
      onReadEntry: (e) => {
        if (e.path.replace(/^\.\//, '') === 'config.json') {
          e.on('data', (c: Buffer) => (bundled += c.toString('utf8')));
        }
      },
    });
    expect(bundled).toContain('<redacted-on-export>');
    expect(bundled).not.toContain('AAFakeTokenValue');
    expect(await readFile(join(srcHome, 'config.json'), 'utf8')).toContain('AAFakeTokenValue');
  });

  it('an uncatalogued secret-shaped value REFUSES the export, naming the path', async () => {
    await writeFile(
      join(srcHome, 'webhooks.yaml'),
      'subscriptions:\n  - secret: literal:abcdef0123456789\n',
      'utf8',
    );
    await expect(runExport({ homeDir: srcHome, out: join(tmp, 'b.tgz'), print })).rejects.toThrow(
      /webhooks\.yaml.*secret/,
    );
  });

  it('redactConfig + scanForSecrets units: env refs exempt, marker exempt', () => {
    const red = redactConfig({ chat_connections: { telegram: { bot_token: 'real-token-123' } } });
    expect(JSON.stringify(red)).toContain('<redacted-on-export>');
    expect(scanForSecrets('x.json', { api_key: 'env:OPENAI_API_KEY' })).toEqual([]);
    expect(scanForSecrets('x.json', { bot_token: '<redacted-on-export>' })).toEqual([]);
    expect(scanForSecrets('x.json', { nested: { password: 'supersecret123' } })).toEqual([
      'x.json: nested.password',
    ]);
    // The live-spike false positive: key names CONTAINING but not ENDING in
    // the credential word are not secrets.
    expect(scanForSecrets('x.json', { tokenizer_class: 'BertTokenizerFast' })).toEqual([]);
    expect(scanForSecrets('x.json', { bot_token: 'realtoken123456' })).toEqual([
      'x.json: bot_token',
    ]);
  });
});

describe('import refusals', () => {
  it('refuses into a lived-in home, listing the truth markers — NO force override', async () => {
    const bundle = await runExport({ homeDir: srcHome, out: join(tmp, 'b.tgz'), print });
    await seedTruthHome(dstHome);
    await expect(runImport({ bundle, homeDir: dstHome, print })).rejects.toThrow(/active\.json/);
    await expect(runImport({ bundle, homeDir: dstHome, force: true, print })).rejects.toThrow(
      /active\.json/,
    );
  });

  it('refuses a newer-version manifest without --force; proceeds with it', async () => {
    const stage = join(tmp, 'stage');
    await mkdir(stage, { recursive: true });
    await writeFile(
      join(stage, 'manifest.json'),
      JSON.stringify({ version: 1, opensquid: '99.0.0', created_at: 'x', files: 1 }),
      'utf8',
    );
    await writeFile(join(stage, 'active.json'), JSON.stringify({ packs: [] }), 'utf8');
    const bundle = join(tmp, 'newer.tgz');
    await tar.create({ gzip: true, file: bundle, cwd: stage }, ['.']);
    await rm(dstHome, { recursive: true, force: true });
    await expect(
      runImport({ bundle, homeDir: dstHome, embedder: fakeEmbedder, print }),
    ).rejects.toThrow(/newer/i);
    await rm(dstHome, { recursive: true, force: true });
    const r = await runImport({
      bundle,
      homeDir: dstHome,
      force: true,
      embedder: fakeEmbedder,
      print,
    });
    expect(existsSync(join(dstHome, 'active.json'))).toBe(true);
    expect(r.rebuilt.length + r.failed.length).toBeGreaterThan(0);
  });

  it('truthPresent covers the FULL inventory (channels.json alone refuses)', async () => {
    await rm(dstHome, { recursive: true, force: true });
    await mkdir(dstHome, { recursive: true });
    await writeFile(join(dstHome, 'channels.json'), '{"v":1,"umbrellas":[]}', 'utf8');
    expect(await truthPresent(dstHome)).toEqual(['channels.json']);
  });
});

describe('rebuild failure', () => {
  it('keeps the extracted truth and reports the re-run command', async () => {
    const bundle = await runExport({ homeDir: srcHome, out: join(tmp, 'b.tgz'), print });
    await rm(dstHome, { recursive: true, force: true });
    const out = await runImport({ bundle, homeDir: dstHome, embedder: throwingEmbedder, print });
    expect(out.failed.some((f) => f.includes('re-run:'))).toBe(true);
    expect(existsSync(join(dstHome, 'memories', 'mem-1.md'))).toBe(true);
  });
});
