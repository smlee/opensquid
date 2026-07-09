/**
 * RD.1/RD.6 — the display primitive prints a report body VERBATIM to an injected sink (no disk, no transform).
 * This is the `reachable` PROOF for `displayReport` (R-REPORT-DISPLAY) — it lets `real_code` stay honest.
 */
import { describe, expect, it } from 'vitest';

import { displayReport, type ReportSink } from './report_display.js';

function recordingSink(): { sink: ReportSink; out: string[] } {
  const out: string[] = [];
  return { sink: { write: (c) => void out.push(c) }, out };
}

describe('displayReport', () => {
  it('writes the body verbatim with a single trailing newline (already-terminated body unchanged)', () => {
    const { sink, out } = recordingSink();
    const body = 'After-stage report — plan complete · wg-x · 2026-07-09\n';
    displayReport(body, sink);
    expect(out.join('')).toBe(body); // no double newline, no transformation
  });

  it('appends a newline only when the body is missing one', () => {
    const { sink, out } = recordingSink();
    displayReport('no-trailing', sink);
    expect(out.join('')).toBe('no-trailing\n');
  });

  it('defaults the sink to process.stderr (the loop-executor live channel, not stdout)', () => {
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    // stub stderr.write to record; a subprocess lap must NOT print a report body to stdout (hook JSON protocol).
    (process.stderr as unknown as { write: (c: string) => boolean }).write = (c: string) => {
      chunks.push(c);
      return true;
    };
    try {
      displayReport('to-stderr\n');
    } finally {
      (process.stderr as unknown as { write: typeof orig }).write = orig;
    }
    expect(chunks.join('')).toBe('to-stderr\n');
  });
});
