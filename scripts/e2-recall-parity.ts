/**
 * E2 — recall-parity harness (T-STORE-FOUNDATION-LIBSQL acceptance gate).
 * Loads ~/.opensquid/memories/mem-*.md into TWO libSQL stores — one with the in-process
 * fastembed embedder (bge-small 384d), one with the Ollama-Qwen3 embedder — and compares
 * recall on the SAME corpus + queries. Metrics: self-retrieval@5 (query each memory by its
 * description; is that memory in its own top-5?) + an optional spot-check query (E2_SPOT_QUERY).
 * Run: `node --import tsx scripts/e2-recall-parity.ts`  (needs Ollama up for the Qwen3 side).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { libsqlStoreBackend } from '../src/rag/backends/libsql_store.js';
import { fastembedEmbedder } from '../src/rag/embedders/fastembed.js';
import { ollamaQwen3Embedder } from '../src/rag/embedders/ollama_qwen3.js';

import type { Lesson, RagBackend } from '../src/rag/types.js';

const MEM_DIR = join(homedir(), '.opensquid', 'memories');

function loadMemories(): Lesson[] {
  const files = readdirSync(MEM_DIR).filter((f) => f.startsWith('mem-') && f.endsWith('.md'));
  const out: Lesson[] = [];
  for (const f of files) {
    const raw = readFileSync(join(MEM_DIR, f), 'utf8');
    const id = /^id:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? f.replace(/\.md$/, '');
    const description = /^description:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? '';
    const body = raw.includes('\n---\n')
      ? raw.split('\n---\n').slice(1).join('\n---\n').trim()
      : raw;
    out.push({
      id,
      content: `${description}\n\n${body}`.trim(),
      tags: [],
      source: 'memory',
      author: 'user',
      createdAt:
        /^created_at:\s*'?([^'\n]+)'?$/m.exec(raw)?.[1]?.trim() ?? new Date(0).toISOString(),
    });
  }
  return out;
}

async function loadInto(backend: RagBackend, mems: Lesson[]): Promise<void> {
  await backend.init();
  for (const m of mems) await backend.storeLesson(m);
}

async function selfRetrievalAt5(
  backend: RagBackend,
  mems: Lesson[],
  sample: number,
): Promise<number> {
  let hits = 0;
  const step = Math.max(1, Math.floor(mems.length / sample));
  let n = 0;
  for (let i = 0; i < mems.length; i += step) {
    const m = mems[i]!;
    const q = m.content.split('\n')[0]!.slice(0, 120); // its description / first line
    const res = await backend.recall(q, 5);
    if (res.some((h) => h.lesson.id === m.id)) hits++;
    n++;
  }
  return n === 0 ? 0 : hits / n;
}

// Optional spot-check: set E2_SPOT_QUERY to eyeball one query's top-5 on both backends (e.g. a
// proper-noun recall case). No query is hardcoded — keeps the harness corpus-agnostic + free of
// any specific user's data.
async function spotCheck(backend: RagBackend, query: string): Promise<string[]> {
  const res = await backend.recall(query, 5);
  return res.map((h) => h.lesson.id);
}

(async () => {
  const mems = loadMemories();
  console.log(`Loaded ${mems.length} memories from ${MEM_DIR}`);

  const fast = libsqlStoreBackend({ dbUrl: ':memory:', embedder: fastembedEmbedder() });
  const qwen = libsqlStoreBackend({
    dbUrl: ':memory:',
    embedder: ollamaQwen3Embedder({ ollamaUrl: 'http://localhost:11434' }),
  });

  console.log('Indexing into fastembed store…');
  await loadInto(fast, mems);
  console.log('Indexing into Ollama-Qwen3 store…');
  await loadInto(qwen, mems);

  const SAMPLE = 40;
  const fastSR = await selfRetrievalAt5(fast, mems, SAMPLE);
  const qwenSR = await selfRetrievalAt5(qwen, mems, SAMPLE);
  console.log('\n=== E2 recall parity ===');
  console.log(
    `self-retrieval@5 (sample ${SAMPLE}):  fastembed-bge ${(fastSR * 100).toFixed(0)}%   ollama-qwen3 ${(qwenSR * 100).toFixed(0)}%`,
  );
  const spot = process.env.E2_SPOT_QUERY;
  if (spot) {
    const fastS = await spotCheck(fast, spot);
    const qwenS = await spotCheck(qwen, spot);
    console.log(
      `spot-check "${spot}" top-5: fastembed ${JSON.stringify(fastS)} | qwen3 ${JSON.stringify(qwenS)}`,
    );
  }
  console.log(
    `\nVERDICT: ${fastSR >= qwenSR - 0.1 ? 'fastembed PARITY (within 10pt)' : 'fastembed BELOW parity — escalate to bge-base/nomic'} `,
  );
})().catch((e) => {
  console.error('E2 FAILED:', e);
  process.exit(1);
});
