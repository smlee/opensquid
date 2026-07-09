/**
 * RD.1 — the display primitive: the missing "show it on the screen" step of the reporting model.
 *
 * Design-of-record: loop/docs/design/opensquid-reporting-model.md — a report is a before/after
 * COMMUNICATION pair, DISPLAYED live on the terminal at the moment its scope boundary is crossed,
 * and NEVER persisted (the communication reports; the §5.4b failure report keeps its own save).
 *
 * The render functions (`stage_report.ts` / `scope_report.ts`) already produce the body; this module
 * adds the one primitive that PRINTS it to a live output stream, behind a single injected sink seam
 * so it is testable + context-agnostic (mirrors the `StageIo`/`realStageIo` single-seam-with-default
 * convention, `release/stage_integration.ts`).
 */

/**
 * The minimal live-output sink a report prints to. `process.stderr` / `process.stdout` both satisfy it
 * (both are `NodeJS.WriteStream`, which has `write` plus much more); a test injects a recording fake.
 * The ONE seam for WHERE a report shows — render stays pure elsewhere. Deliberately a structural minimum
 * (`{ write(chunk: string): void }`), NOT `NodeJS.WritableStream` (that would drag in `end`/`cork`/… a
 * fake would have to stub).
 */
export interface ReportSink {
  write(chunk: string): void;
}

/**
 * DISPLAY a rendered report body on the live output stream — the report is SHOWN, never filed.
 *
 * Default `process.stderr` is load-bearing: in a loop executor (a subprocess lap) stdout carries the
 * Claude-Code hook JSON protocol, so a report body written to stdout would CORRUPT it; stderr is the
 * channel `makeSpawnLap`'s `onStderrLine` (`setup/cli/ralph.ts`) streams to the loop terminal live,
 * line by line. An interactive/parent surface (the orchestrator, a future CLI command) passes
 * `process.stdout` explicitly. The body is shown VERBATIM (the renderers already end in '\n'; append
 * one ONLY when missing, so there is never a double blank line and no other transformation).
 */
export function displayReport(body: string, out: ReportSink = process.stderr): void {
  out.write(body.endsWith('\n') ? body : body + '\n');
}
