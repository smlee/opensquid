/**
 * Tests for `nlToCron` — natural-language → cron via the codex-declared
 * `fast_classifier` alias (SCHED.3).
 *
 * Fake-LLM approach (matches `src/functions/llm.test.ts` pattern): write a
 * tiny node script to a per-test tmp dir, point `cfg.cli` at it via the
 * `OPENSQUID_MODELS_CONFIG_INLINE` env-var seam. The script echoes a
 * fixture string from env-var `FAKE_OUTPUT` and exits — no real LLM call.
 *
 * Per the SCHED.3 acceptance criteria: ≥ 8 fixture phrases including the
 * 4 from the spec + edge cases (multi-line output, 6-field strip, timezone
 * detection, prompt-injection escape, bounded-input rejection, garbage).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelAliasConfig } from '../models/types.js';

import {
  InvalidCronError,
  InvalidScheduleInputError,
  MAX_NL_INPUT_LEN,
  PROMPT_TEMPLATE,
  detectTimezone,
  nlToCron,
  normalizeCronOutput,
  safeSubstitute,
} from './schedule_nl.js';

let tmpRoot: string;
let priorInline: string | undefined;

beforeEach(async () => {
  priorInline = process.env.OPENSQUID_MODELS_CONFIG_INLINE;
  tmpRoot = await mkdtemp(join(tmpdir(), 'opensquid-schednl-test-'));
});

afterEach(async () => {
  if (priorInline === undefined) {
    delete process.env.OPENSQUID_MODELS_CONFIG_INLINE;
  } else {
    process.env.OPENSQUID_MODELS_CONFIG_INLINE = priorInline;
  }
  await rm(tmpRoot, { recursive: true, force: true });
});

/**
 * Write a node script that consumes stdin, then echoes `output` and exits.
 * `output` may contain newlines so we can test multi-line model output.
 */
async function writeFakeLlm(output: string): Promise<string> {
  const script = `
let buf = '';
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
  process.stdout.write(${JSON.stringify(output)});
  process.exit(0);
});
`;
  const path = join(tmpRoot, `fake-llm-${Math.random().toString(36).slice(2, 8)}.js`);
  await writeFile(path, script, 'utf8');
  return path;
}

/** Install a single alias into the inline config env var. */
function installAlias(alias: string, scriptPath: string): void {
  const cfg: Record<string, ModelAliasConfig> = {
    [alias]: {
      mode: 'subscription',
      impl: 'cli',
      cli: process.execPath,
      args: [scriptPath],
    },
  };
  process.env.OPENSQUID_MODELS_CONFIG_INLINE = JSON.stringify(cfg);
}

// ---------------------------------------------------------------------------
// Fixture phrases — 8 cases from the spec + edge cases.
// ---------------------------------------------------------------------------

describe('nlToCron — happy paths (spec fixtures)', () => {
  it('"every Monday morning around 9" → "0 9 * * 1"', async () => {
    installAlias('fast_classifier', await writeFakeLlm('0 9 * * 1'));
    const r = await nlToCron('every Monday morning around 9');
    expect(r.cron).toBe('0 9 * * 1');
    expect(r.confidence).toBe('high');
    expect(r.timezone).toBeUndefined();
  });

  it('"every 5 minutes" → "*/5 * * * *"', async () => {
    installAlias('fast_classifier', await writeFakeLlm('*/5 * * * *'));
    const r = await nlToCron('every 5 minutes');
    expect(r.cron).toBe('*/5 * * * *');
  });

  it('"daily at noon" → "0 12 * * *"', async () => {
    installAlias('fast_classifier', await writeFakeLlm('0 12 * * *'));
    const r = await nlToCron('daily at noon');
    expect(r.cron).toBe('0 12 * * *');
  });

  it('"every weekday at 6pm" → "0 18 * * 1-5"', async () => {
    installAlias('fast_classifier', await writeFakeLlm('0 18 * * 1-5'));
    const r = await nlToCron('every weekday at 6pm');
    expect(r.cron).toBe('0 18 * * 1-5');
  });
});

describe('nlToCron — edge cases', () => {
  it('strips multi-line model output, keeping only the first line', async () => {
    installAlias(
      'fast_classifier',
      await writeFakeLlm('0 9 * * 1\nThe rest of this is chatter the model added.'),
    );
    const r = await nlToCron('every Monday at 9');
    expect(r.cron).toBe('0 9 * * 1');
  });

  it('strips a 6-field (seconds-first) cron expression to 5-field', async () => {
    installAlias('fast_classifier', await writeFakeLlm('0 0 9 * * 1'));
    const r = await nlToCron('every Monday at 9');
    expect(r.cron).toBe('0 9 * * 1');
  });

  it('detects timezone in input (EST) and surfaces it alongside cron', async () => {
    installAlias('fast_classifier', await writeFakeLlm('0 18 * * 1-5'));
    const r = await nlToCron('every weekday at 6pm in EST');
    expect(r.cron).toBe('0 18 * * 1-5');
    expect(r.timezone).toBe('America/New_York');
  });

  it('detects IANA timezone (America/New_York) preferentially over abbreviations', async () => {
    installAlias('fast_classifier', await writeFakeLlm('0 18 * * 1-5'));
    const r = await nlToCron('every weekday at 6pm America/New_York');
    expect(r.cron).toBe('0 18 * * 1-5');
    expect(r.timezone).toBe('America/New_York');
  });

  it('detects PST timezone and maps to America/Los_Angeles', async () => {
    installAlias('fast_classifier', await writeFakeLlm('0 9 * * *'));
    const r = await nlToCron('daily at 9am PST');
    expect(r.timezone).toBe('America/Los_Angeles');
  });

  it('throws InvalidCronError when model returns garbage', async () => {
    installAlias('fast_classifier', await writeFakeLlm('blubbering nonsense'));
    await expect(nlToCron('blubbering nonsense')).rejects.toThrow(InvalidCronError);
  });

  it('throws InvalidScheduleInputError for input over 256 chars (no LLM call)', async () => {
    installAlias('fast_classifier', await writeFakeLlm('0 9 * * 1'));
    const tooLong = 'every Monday at 9am '.repeat(20); // ~400 chars
    expect(tooLong.length).toBeGreaterThan(MAX_NL_INPUT_LEN);
    await expect(nlToCron(tooLong)).rejects.toThrow(InvalidScheduleInputError);
  });

  it('throws InvalidScheduleInputError for empty input', async () => {
    installAlias('fast_classifier', await writeFakeLlm('0 9 * * 1'));
    await expect(nlToCron('')).rejects.toThrow(InvalidScheduleInputError);
    await expect(nlToCron('   ')).rejects.toThrow(InvalidScheduleInputError);
  });

  it('throws InvalidScheduleInputError when alias is unknown', async () => {
    // No alias installed.
    process.env.OPENSQUID_MODELS_CONFIG_INLINE = JSON.stringify({});
    await expect(nlToCron('every Monday at 9am')).rejects.toThrow(InvalidScheduleInputError);
  });
});

// ---------------------------------------------------------------------------
// Prompt-injection defence: substitution escapes `"` and `\`.
// ---------------------------------------------------------------------------

describe('safeSubstitute — prompt-injection defence', () => {
  it("escapes double quotes in NL input so it can't break out of the quoted slot", () => {
    const hostile = 'cron"; DROP TABLE schedules; --';
    const out = safeSubstitute(PROMPT_TEMPLATE, hostile);
    // The `"` from the hostile string must be escaped to `\"`.
    expect(out).toContain('cron\\";');
    // The template's surrounding quotes must still be intact (unescaped).
    expect(out).toContain('Input: "cron\\";');
  });

  it('escapes backslashes before quotes (order matters)', () => {
    const hostile = 'foo\\"bar';
    const out = safeSubstitute(PROMPT_TEMPLATE, hostile);
    // `\` → `\\`, then `"` → `\"`. Final substring: `foo\\\"bar`.
    expect(out).toContain('foo\\\\\\"bar');
  });

  it('leaves harmless input unchanged', () => {
    const out = safeSubstitute(PROMPT_TEMPLATE, 'every Monday at 9am');
    expect(out).toContain('Input: "every Monday at 9am"');
  });
});

// ---------------------------------------------------------------------------
// Pure-function unit tests for the helpers.
// ---------------------------------------------------------------------------

describe('normalizeCronOutput', () => {
  it('returns 5-field cron unchanged when valid', () => {
    expect(normalizeCronOutput('0 9 * * 1')).toBe('0 9 * * 1');
    expect(normalizeCronOutput('*/5 * * * *')).toBe('*/5 * * * *');
  });

  it('takes the first line of multi-line output', () => {
    expect(normalizeCronOutput('0 9 * * 1\nrest')).toBe('0 9 * * 1');
  });

  it('strips leading seconds field from 6-field output', () => {
    expect(normalizeCronOutput('30 0 9 * * 1')).toBe('0 9 * * 1');
  });

  it('returns null for invalid cron', () => {
    expect(normalizeCronOutput('not a cron')).toBeNull();
    expect(normalizeCronOutput('')).toBeNull();
    expect(normalizeCronOutput('0 9 * *')).toBeNull(); // 4-field
    expect(normalizeCronOutput('0 9 * * * * extra')).toBeNull(); // 7-field
  });
});

describe('detectTimezone', () => {
  it('returns undefined when no tz token present', () => {
    expect(detectTimezone('every Monday at 9am')).toBeUndefined();
  });

  it('matches common abbreviations', () => {
    expect(detectTimezone('daily at 9am EST')).toBe('America/New_York');
    expect(detectTimezone('daily at 9am PST')).toBe('America/Los_Angeles');
    expect(detectTimezone('daily at 9am UTC')).toBe('UTC');
    expect(detectTimezone('daily at 9am JST')).toBe('Asia/Tokyo');
  });

  it('prefers IANA slash-form over abbreviations', () => {
    expect(detectTimezone('daily at 9am Europe/Paris')).toBe('Europe/Paris');
  });
});
