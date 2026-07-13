import { describe, expect, it } from 'vitest';

import { PI_EXECUTOR_WALL_CLOCK_MS_ENV, readPiExecutorWallClockMs } from './env.js';

describe('Pi executor-loop environment', () => {
  it('inherits the parent lap wall clock and otherwise uses the bounded fallback', () => {
    expect(readPiExecutorWallClockMs({}, 600_000)).toBe(600_000);
    expect(readPiExecutorWallClockMs({ [PI_EXECUTOR_WALL_CLOCK_MS_ENV]: '1800000' }, 600_000)).toBe(
      1_800_000,
    );
  });

  it('rejects malformed and unbounded-looking values', () => {
    for (const value of ['0', '-1', 'Infinity', '1.5', 'not-a-number']) {
      expect(() =>
        readPiExecutorWallClockMs({ [PI_EXECUTOR_WALL_CLOCK_MS_ENV]: value }, 600_000),
      ).toThrow(PI_EXECUTOR_WALL_CLOCK_MS_ENV);
    }
  });
});
