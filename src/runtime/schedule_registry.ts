/**
 * Schedule registry — distills each installed pack's
 * `triggers: [{kind: schedule, cron: ...}]` declarations into a flat list of
 * cron entries the daemon can register with node-cron.
 *
 * Authoritative source: `docs/tasks/scheduling.md` SCHED.1.
 *
 * Validation contract (load-time, not run-time):
 *
 *   - `cron` is REQUIRED on every schedule trigger. A schedule trigger
 *     without a cron expression is a YAML mistake; we refuse to start the
 *     daemon rather than silently never firing.
 *   - 5-field POSIX cron only. node-cron silently accepts 6-field
 *     (seconds-first) expressions; we reject them at load time with a clear
 *     error citing pack + skill + trigger index, so a pack author can't
 *     accidentally schedule something to fire 60× more often than they
 *     intended on a runtime upgrade that flipped the default.
 *   - `node-cron.validate()` runs on the 5-field shape. Anything that fails
 *     validation throws `ScheduleRegistryError` with the same provenance
 *     fields so the operator can find the bad pack quickly.
 *
 * Timezone defaults to UTC (locked, per spec risk callout). Per-trigger
 * `timezone:` lives under `triggerPayload` on the runtime view today; that
 * field is open-ended (`z.record(z.unknown())`) so the daemon reads it
 * defensively. The YAML schema for the `timezone:` per-trigger field lands
 * in a follow-up task — for SCHED.1 the entries default to UTC and the
 * registry exposes `entry.timezone` as a hook for that future YAML field.
 *
 * Engine-vocabulary discipline: returns `(pack, skill, cron, timezone)`
 * tuples. No consumer-product names leak into this module.
 *
 * Imports from: node-cron, ./types.js.
 * Imported by: src/runtime/daemon.ts.
 */

import cron from 'node-cron';

import type { Pack } from './types.js';

/**
 * One scheduled trigger source. The daemon registers a node-cron task per
 * entry and stores the handle on its `tasks` Map keyed by `entry.id`.
 *
 * `id` format: `${pack}::${skill}::${triggerIndex}` — stable identifier the
 * audit log uses to attribute a fire to its declaration site.
 */
export interface ScheduleEntry {
  id: string;
  pack: string;
  skill: string;
  cron: string;
  /** Defaults to `'UTC'` when the trigger omits an explicit timezone. */
  timezone: string;
}

export class ScheduleRegistryError extends Error {
  constructor(
    message: string,
    readonly pack: string,
    readonly skill: string,
    readonly triggerIndex: number,
  ) {
    super(message);
    this.name = 'ScheduleRegistryError';
  }
}

/**
 * Walk `packs[].skills[].triggers[]` and emit one `ScheduleEntry` per
 * schedule trigger. Throws on the first malformed cron expression — the
 * operator gets one error per daemon-start attempt so a misconfigured pack
 * surfaces as soon as it's installed.
 */
export function buildScheduleRegistry(packs: readonly Pack[]): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];

  for (const pack of packs) {
    for (const skill of pack.skills) {
      let triggerIndex = -1;
      for (const trigger of skill.triggers) {
        triggerIndex += 1;
        if (trigger.kind !== 'schedule') continue;

        if (typeof trigger.cron !== 'string' || trigger.cron.trim() === '') {
          throw new ScheduleRegistryError(
            `pack "${pack.name}" skill "${skill.name}" trigger #${triggerIndex} is kind=schedule but missing required \`cron:\` field`,
            pack.name,
            skill.name,
            triggerIndex,
          );
        }

        const expr = trigger.cron.trim();

        // 5-field POSIX only. node-cron accepts both 5- and 6-field shapes;
        // we refuse 6-field so a schedule author who copies a Quartz-style
        // `*/5 * * * * *` into the YAML gets a loud error instead of having
        // their job fire every second.
        const fieldCount = expr.split(/\s+/).length;
        if (fieldCount === 6) {
          throw new ScheduleRegistryError(
            `pack "${pack.name}" skill "${skill.name}" trigger #${triggerIndex} cron "${expr}" is 6-field (seconds-first); use 5-field POSIX cron — drop the leading seconds field`,
            pack.name,
            skill.name,
            triggerIndex,
          );
        }
        if (fieldCount !== 5) {
          throw new ScheduleRegistryError(
            `pack "${pack.name}" skill "${skill.name}" trigger #${triggerIndex} cron "${expr}" has ${fieldCount} fields; expected 5-field POSIX cron (minute hour day month weekday)`,
            pack.name,
            skill.name,
            triggerIndex,
          );
        }

        if (!cron.validate(expr)) {
          throw new ScheduleRegistryError(
            `pack "${pack.name}" skill "${skill.name}" trigger #${triggerIndex} cron "${expr}" is not a valid 5-field POSIX cron expression`,
            pack.name,
            skill.name,
            triggerIndex,
          );
        }

        entries.push({
          id: `${pack.name}::${skill.name}::${triggerIndex}`,
          pack: pack.name,
          skill: skill.name,
          cron: expr,
          // Open-ended triggerPayload at the schema layer means the daemon
          // reads this defensively. `timezone:` lands as a first-class
          // field in a follow-up YAML refinement; until then, UTC.
          timezone: 'UTC',
        });
      }
    }
  }

  return entries;
}
