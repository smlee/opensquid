/**
 * DAEMON.1 — the host process entry point (T-fsm-actor-runtime §DAEMON.1).
 *
 * The detached child `client.ts` spawns. It does nothing but `startHost()` and stay
 * alive: signal + idle shutdown live inside the host handle. Kept tiny on purpose —
 * all lifecycle logic is in `host.ts` (testable), this is just the runnable shell.
 * If the boot lock is already held (another host owns the topology), `startHost`
 * throws and this process exits non-zero — the client's await-ready loop then finds
 * the winner's `runtime.json` and connects to it.
 *
 * RD.3 — this is the daemon's PRODUCTION caller, so it binds the SYSTEM-scope before/after report observers:
 * `onStartupReport` (before-system, at genesis boot) + `onShutdownReport` (after-system, at graceful stop) each
 * render the §4 scope spine and DISPLAY it live (the daemon's live channel is its own stdout). The resume STATE
 * (`writeStartupReport` / `writeShutdownMarker`) keeps persisting inside `host.ts` — these observers only DISPLAY
 * the communication report alongside it.
 */
import { startHost } from './host.js';
import { displayReport } from '../loop/report_display.js';
import { renderScopeBefore, renderScopeAfter } from '../loop/scope_report.js';

startHost({
  onStartupReport: (report) => {
    const packs = Object.entries(report.packs);
    const connected = packs.filter(([, s]) => s === 'connected').length;
    displayReport(
      renderScopeBefore(
        'system',
        'genesis boot',
        [
          `${connected}/${packs.length} pack(s) connected`,
          `${Object.keys(report.actors).length} actor(s) classified`,
          `${report.failures.length} failure(s)`,
        ],
        new Date().toISOString(),
      ).body,
      process.stdout,
    );
  },
  onShutdownReport: (marker) => {
    displayReport(
      renderScopeAfter(
        'system',
        'shutdown',
        [{ item: 'clean shutdown — actor state persisted, resume marker written', done: true }],
        `resume marker ${marker.digest}`,
        undefined,
        new Date(marker.ts).toISOString(),
      ).body,
      process.stdout,
    );
  },
}).catch((err: unknown) => {
  process.stderr.write(`[opensquid] host failed to start: ${(err as Error).message}\n`);
  process.exit(1);
});
