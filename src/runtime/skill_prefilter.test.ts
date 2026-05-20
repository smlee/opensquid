/**
 * Tests for `prefilterSkills` — embedder pre-filter (Phase 3 Task 3.3).
 *
 * Strategy:
 *   - Stub `globalThis.fetch` so no real Ollama is involved. The mock
 *     dispatches a per-input embedding from a fixed lookup; this lets
 *     us encode "skill 2 is closer to the subject" by literally
 *     constructing the vectors that way.
 *   - 5 cases:
 *       1. Happy path — ordering follows similarity (skill 2 first).
 *       2. Embedder unreachable on subject → fallback returns ALL skills
 *          (acceptance criterion).
 *       3. External cache supplied → second call doesn't re-embed
 *          cache-hit prose. Asserted by counting fetch calls AND by
 *          mutating the mock between calls so a cache miss would show
 *          a different vector.
 *       4. `k > skills.length` → all skills returned.
 *       5. Empty skills → [] (no fetch issued).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { prefilterSkills } from './skill_prefilter.js';
import type { Skill } from './types.js';

// ---------------------------------------------------------------------------
// Test helpers.
// ---------------------------------------------------------------------------

/**
 * Build a Skill with sensible defaults — only `name` and `prose` matter
 * for the embedder, so leave the rest at schema defaults.
 */
function makeSkill(name: string, prose: string): Skill {
  return {
    name,
    prose,
    load: 'lazy',
    when_to_load: [],
    unloads_when: [],
    triggers: [{ kind: 'tool_call' }],
    rules: [],
  };
}

/**
 * Build an `embeddings: [[...]]` ollama-shape response.
 */
function embedResponse(vec: number[]): Response {
  return new Response(JSON.stringify({ embeddings: [vec] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Install a fetch mock that returns a vector keyed off the request body's
 * `input` field. Unknown inputs fall back to `[0, 0, 0]`.
 */
function installEmbedLookup(table: Record<string, number[]>): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    const bodyStr = typeof init?.body === 'string' ? init.body : '';
    let input = '';
    try {
      const parsed = JSON.parse(bodyStr) as { input?: string };
      input = parsed.input ?? '';
    } catch {
      input = '';
    }
    return Promise.resolve(embedResponse(table[input] ?? [0, 0, 0]));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Happy path: skill 2's prose embeds closer to the subject than 1 or 3,
//    so it must come first in the returned list.
// ---------------------------------------------------------------------------

describe('prefilterSkills — happy path', () => {
  it('ranks skills by cosine similarity to the task subject', async () => {
    const skills = [
      makeSkill('one', 'prose-one'),
      makeSkill('two', 'prose-two'),
      makeSkill('three', 'prose-three'),
    ];
    // Subject vec [1, 0, 0]. prose-two vec [1, 0, 0] is the perfect match;
    // prose-one is orthogonal; prose-three is anti-aligned.
    installEmbedLookup({
      'subject text': [1, 0, 0],
      'prose-one': [0, 1, 0],
      'prose-two': [1, 0, 0],
      'prose-three': [-1, 0, 0],
    });

    const result = await prefilterSkills('subject text', skills);
    expect(result.map((s) => s.name)).toEqual(['two', 'one', 'three']);
  });
});

// ---------------------------------------------------------------------------
// 2. Embedder unavailable on the subject — fallback returns ALL skills.
//    Acceptance criterion: "Ollama failure falls through to load-everything."
// ---------------------------------------------------------------------------

describe('prefilterSkills — ollama unavailable fallback', () => {
  it('returns the original skills list when fetch rejects on the subject embed', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const skills = [makeSkill('a', 'pa'), makeSkill('b', 'pb')];

    const result = await prefilterSkills('whatever', skills);
    expect(result).toEqual(skills);
  });

  it('also falls back if HTTP returns non-2xx (malformed embedder)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    );
    const skills = [makeSkill('a', 'pa'), makeSkill('b', 'pb')];

    const result = await prefilterSkills('subject', skills);
    // ollamaEmbed throws on non-2xx; the catch in prefilterSkills returns
    // all skills.
    expect(result).toEqual(skills);
  });
});

// ---------------------------------------------------------------------------
// 3. External cache is honored: a second call with the same prose key in
//    the cache must NOT issue a fetch for that prose.
// ---------------------------------------------------------------------------

describe('prefilterSkills — external cache', () => {
  it('skips re-embedding when the cache already has the prose key', async () => {
    const skills = [makeSkill('a', 'shared-prose')];
    // Seed: subject must still be embedded once per call; prose comes from
    // cache.
    const cache = new Map<string, number[]>([['shared-prose', [0, 1, 0]]]);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const bodyStr = typeof init?.body === 'string' ? init.body : '';
      const parsed = JSON.parse(bodyStr) as { input?: string };
      // Subject text comes through fetch; prose must NOT, because cached.
      if (parsed.input === 'shared-prose') {
        return Promise.reject(new Error('prose embed should have been cached'));
      }
      return Promise.resolve(embedResponse([1, 0, 0]));
    });

    const result = await prefilterSkills('subject', skills, { cache });
    expect(result).toHaveLength(1);
    // Exactly one fetch — the subject. None for the cached prose.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('populates the cache on the first call so subsequent calls hit', async () => {
    const skills = [makeSkill('a', 'fresh-prose')];
    const cache = new Map<string, number[]>();
    installEmbedLookup({
      subject: [1, 0, 0],
      'fresh-prose': [1, 0, 0],
    });

    await prefilterSkills('subject', skills, { cache });
    expect(cache.has('fresh-prose')).toBe(true);
    expect(cache.get('fresh-prose')).toEqual([1, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// 4. k > skills.length — return all skills (post-ranking).
// ---------------------------------------------------------------------------

describe('prefilterSkills — k larger than input', () => {
  it('returns all skills when k exceeds the list length', async () => {
    const skills = [makeSkill('a', 'pa'), makeSkill('b', 'pb')];
    installEmbedLookup({
      s: [1, 0, 0],
      pa: [1, 0, 0],
      pb: [0, 1, 0],
    });

    const result = await prefilterSkills('s', skills, { k: 50 });
    expect(result.map((s) => s.name).sort()).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// 5. Empty input — early return, no fetch.
// ---------------------------------------------------------------------------

describe('prefilterSkills — empty input', () => {
  it('returns [] without issuing any fetch when skills is empty', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await prefilterSkills('anything', []);
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
