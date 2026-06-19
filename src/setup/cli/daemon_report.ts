/**
 * T4 — `opensquid daemon report`: surface the persisted genesis StartupReport (T-fsm-actor-rescope §T4).
 *
 * READ-ONLY by design: it renders the report (which packs connected / off-and-why, actor classifications, the
 * crash flag, the boot time) and exposes a `--show` DISPLAY filter — it writes NOTHING and changes genesis
 * nothing. (The dead `remediation` enum is NOT wired here; an active re-reconcile is a separate track.) Freshness
 * is labelled via `OpenSquidDaemon.status()` — the SAME oracle `daemon status` uses, so the two never disagree.
 */
import { OpenSquidDaemon } from '../../runtime/daemon.js';
import { readStartupReport } from '../../runtime/genesis/startup_report_file.js';
import type { PackStatus } from '../../runtime/genesis/reconcile.js';

export type ShowFilter = 'failed' | 'all' | 'connected' | { packs: string[] };

/** A pack is "failed" when it is not connected — a `{disabled}`/`{wedged}` validation-failure reason. */
const isFailed = (s: PackStatus): boolean => s !== 'connected';

const reasonOf = (s: PackStatus): string =>
  s === 'connected' ? '' : 'disabled' in s ? s.disabled : s.wedged;

/** Parse the `--show <what>` CLI value into a ShowFilter (comma-separated names ⇒ a pack list). */
export function parseShow(raw: string | undefined): ShowFilter {
  if (raw === undefined || raw === 'failed') return 'failed';
  if (raw === 'all' || raw === 'connected') return raw;
  return {
    packs: raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };
}

export interface DaemonReportDeps {
  /** injectable for tests — defaults to the real daemon status reader. */
  running?: () => Promise<boolean>;
}

export async function runDaemonReport(
  opts: { json?: boolean; show?: ShowFilter },
  deps: DaemonReportDeps = {},
): Promise<string> {
  const report = await readStartupReport();
  if (report === null) return 'daemon report: no genesis report yet (daemon not started)';
  if (opts.json === true) return JSON.stringify(report, null, 2);

  const running =
    deps.running !== undefined
      ? await deps.running()
      : (
          await new OpenSquidDaemon({
            packs: [],
            subscriptions: [],
            dispatch: async () => {
              /* status check never dispatches */
            },
          }).status()
        ).running;
  const when = running ? 'current boot' : 'last boot — daemon not running';

  const show = opts.show ?? 'failed';
  const entries = Object.entries(report.packs).filter(([name, s]) =>
    show === 'all'
      ? true
      : show === 'connected'
        ? s === 'connected'
        : show === 'failed'
          ? isFailed(s)
          : show.packs.includes(name),
  );
  const packLines = entries.map(([name, s]) =>
    s === 'connected' ? `  ✓ ${name}` : `  ✗ ${name}: ${reasonOf(s)}`,
  );
  const actorLines = Object.entries(report.actors).map(([id, c]) => `  ${id}: ${c}`);
  const hint = entries.some(([, s]) => isFailed(s))
    ? '\nFix the cause above, then restart the daemon to re-attempt (genesis re-runs).'
    : '';
  const at = new Date(report.startedAt).toISOString();
  return (
    `genesis startup report (${when}, booted ${at})\n` +
    `packs:\n${packLines.join('\n') || '  (none)'}\n` +
    `actors:\n${actorLines.join('\n') || '  (none)'}` +
    (report.recovery ? '\n⚠ crash recovery: resumes parked as wedges' : '') +
    hint
  );
}
