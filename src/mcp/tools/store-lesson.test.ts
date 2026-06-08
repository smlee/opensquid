/**
 * Unit tests for `handleStoreLesson` — Zod validation + wedge-store delegation
 * + next_steps anti-misuse guidance (retire-Rust RES-3c: store-backed, engine-free).
 */

import { describe, expect, it, vi } from 'vitest';

import type { WedgeLessonStore } from '../../rag/wedge/store.js';

import { NEXT_STEPS_GUIDANCE, StoreLessonSchema, handleStoreLesson } from './store-lesson.js';

const SAMPLE_RESULT = {
  id: 'les-xyz789',
  status: 'pending' as const,
  createdAt: '2026-05-24T00:00:00Z',
};

function mkStore(result: typeof SAMPLE_RESULT): {
  store: WedgeLessonStore;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn().mockResolvedValue(result);
  const store = { createLesson: spy } as unknown as WedgeLessonStore;
  return { store, spy };
}

describe('handleStoreLesson', () => {
  it('returns id + status + next_steps guidance for valid args', async () => {
    const { store, spy } = mkStore(SAMPLE_RESULT);
    const out = await handleStoreLesson(
      StoreLessonSchema.parse({
        description: 'agent slipped to Haiku-classifier',
        content: 'caught the drift; correct framing is model-aliased',
        classification: 'workflow',
      }),
      store,
    );
    expect(out).toEqual({
      id: 'les-xyz789',
      status: 'pending',
      next_steps: NEXT_STEPS_GUIDANCE,
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('next_steps explicitly warns against promote_lesson misuse', () => {
    expect(NEXT_STEPS_GUIDANCE).toMatch(/do not call promote_lesson/i);
    expect(NEXT_STEPS_GUIDANCE).toMatch(/automation handles it/i);
  });

  it('rejects invalid classification via Zod', () => {
    const r = StoreLessonSchema.safeParse({
      description: 'd',
      content: 'c',
      classification: 'random',
    });
    expect(r.success).toBe(false);
  });

  it('accepts all three valid classifications', () => {
    for (const c of ['workflow', 'preference', 'skill_upgrade'] as const) {
      const r = StoreLessonSchema.safeParse({ description: 'd', content: 'c', classification: c });
      expect(r.success).toBe(true);
    }
  });

  it('round-trips source_signal + source_session_id via evidenceRefs', async () => {
    const { store, spy } = mkStore(SAMPLE_RESULT);
    await handleStoreLesson(
      StoreLessonSchema.parse({
        description: 'd',
        content: 'c',
        classification: 'preference',
        source_signal: 'user_correction',
        source_session_id: 'sess-deadbeef',
      }),
      store,
    );
    const call = spy.mock.calls[0]?.[0] as {
      evidenceRefs: string[];
      description: string;
      body: string;
    };
    expect(call.body).toBe('c');
    expect(call.description).toBe('d');
    expect(call.evidenceRefs).toContain('classification:preference');
    expect(call.evidenceRefs).toContain('source_signal:user_correction');
    expect(call.evidenceRefs).toContain('source_session_id:sess-deadbeef');
  });

  it('returns pending status from a create', async () => {
    const { store } = mkStore(SAMPLE_RESULT);
    const out = await handleStoreLesson(
      StoreLessonSchema.parse({ description: 'd', content: 'c', classification: 'workflow' }),
      store,
    );
    expect(out.status).toBe('pending');
  });
});
