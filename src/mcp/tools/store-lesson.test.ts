/**
 * Unit tests for `handleStoreLesson` — Zod validation + engine delegation
 * + next_steps anti-misuse guidance.
 */

import { describe, expect, it, vi } from 'vitest';

import type { EngineClient } from '../../engine/client.js';
import type { LessonCreateResult } from '../../engine/types.js';

import { NEXT_STEPS_GUIDANCE, StoreLessonSchema, handleStoreLesson } from './store-lesson.js';

function mkEngine(result: LessonCreateResult): {
  client: EngineClient;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn().mockResolvedValue(result);
  const client = { lessonCreate: spy } as unknown as EngineClient;
  return { client, spy };
}

const SAMPLE_RESULT: LessonCreateResult = {
  id: 'les-xyz789',
  status: 'pending',
  authored_by: 'agent',
  created_at: '2026-05-24T00:00:00Z',
  updated: false,
};

describe('handleStoreLesson', () => {
  it('returns id + status + next_steps guidance for valid args', async () => {
    const { client, spy } = mkEngine(SAMPLE_RESULT);
    const out = await handleStoreLesson(
      StoreLessonSchema.parse({
        description: 'agent slipped to Haiku-classifier',
        content: 'caught the drift; correct framing is model-aliased',
        classification: 'workflow',
      }),
      client,
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

  it('round-trips source_signal + source_session_id via evidence array', async () => {
    const { client, spy } = mkEngine(SAMPLE_RESULT);
    await handleStoreLesson(
      StoreLessonSchema.parse({
        description: 'd',
        content: 'c',
        classification: 'preference',
        source_signal: 'user_correction',
        source_session_id: 'sess-deadbeef',
      }),
      client,
    );
    const call = spy.mock.calls[0]?.[0] as {
      evidence: string[];
      description: string;
      body: string;
    };
    expect(call.body).toBe('c');
    expect(call.description).toBe('d');
    expect(call.evidence).toContain('classification:preference');
    expect(call.evidence).toContain('source_signal:user_correction');
    expect(call.evidence).toContain('source_session_id:sess-deadbeef');
  });

  it('does NOT request promotion (status omitted from output if engine returns pending)', async () => {
    const { client } = mkEngine(SAMPLE_RESULT);
    const out = await handleStoreLesson(
      StoreLessonSchema.parse({
        description: 'd',
        content: 'c',
        classification: 'workflow',
      }),
      client,
    );
    expect(out.status).toBe('pending');
  });
});
