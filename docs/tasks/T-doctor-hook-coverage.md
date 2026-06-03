# Track T-DOCTOR-HOOK-COVERAGE — `doctor hooks` flags MISSING hook registrations

**Pre-research:** `docs/research/T-doctor-hook-coverage-pre-research-2026-06-03.md`
(`doctor hooks` probes only REGISTERED hooks; a canonical event absent from settings.json
— exactly PostToolUse/SessionStart — produces no result, so doctor reports all-green while
whole enforcement classes are off).

### Task FC.5: Add a canonical-coverage pass to `runDoctorHooks`

**Required skills:** opensquid setup/CLI expert; Claude Code settings.json schema expert; Vitest fixtures expert; Audit / code review expert

**Deliverable:** `opensquid doctor hooks` red-flags any canonical `OPENSQUID_BIN_FOR_EVENT` event that is NOT registered in a settings.json scope that otherwise manages opensquid hooks, with the remediation `run \`opensquid setup wizard hooks\``. A scope with zero opensquid hooks stays `skipped` (project scope is optional). RED → non-zero exit (CI/`doctor`-detectable), so the PostToolUse/SessionStart class of gap can never again pass silently.

**Depends on:** None.

**Files affected:**

- `src/setup/cli/doctor.ts` (modify) — import `OPENSQUID_BIN_FOR_EVENT`; add the coverage pass in `runDoctorHooks` after the per-scope probe loop.
- `src/setup/cli/doctor.test.ts` (modify) — add missing-event-flagged + complete-set-green + non-managing-scope-skipped cases.

**Key code shapes:**

```ts
// doctor.ts — new import (canonical event set; single source of truth)
import { OPENSQUID_BIN_FOR_EVENT } from '../wizard/settings-writer.js';
```

```ts
// doctor.ts — inside runDoctorHooks, appended to the `for (const [scope, path] of scopes)`
// body AFTER `for (const entry of entries) results.push(...)`. A scope "manages
// opensquid" iff it has >=1 opensquid-managed command entry; only then is the full
// canonical set expected (so a project scope with no opensquid hooks is not spammed).
const managed = entries.filter((e) => e.type === 'command' && OPENSQUID_HOOK_REGEX.test(e.command));
if (managed.length > 0) {
  const present = new Set(managed.map((e) => e.event));
  for (const [event, command] of Object.entries(OPENSQUID_BIN_FOR_EVENT)) {
    if (!present.has(event)) {
      results.push(
        mk(
          scope,
          event,
          command,
          'red',
          'not registered in settings.json — run `opensquid setup wizard hooks`',
        ),
      );
    }
  }
}
```

**Test fixtures:** `runDoctorHooks({ userSettingsPath, projectSettingsPath, spawnProbe })` with `spawnProbe` stubbed to emit the expected `[opensquid-dispatch] event=<kind>` marker (so present hooks green). User settings written with only `PreToolUse` + `UserPromptSubmit` opensquid entries → assert RED results for the 4 missing events (incl. PostToolUse, SessionStart). A second fixture with all 6 → no RED coverage results. A project settings with only a non-opensquid hook → no coverage reds (managed.length === 0).

**Acceptance criteria:**

- [ ] settings missing PostToolUse/SessionStart → those events appear as RED with the `opensquid setup wizard hooks` remediation
- [ ] all 6 canonical events present → zero RED coverage results
- [ ] a scope with no opensquid-managed entries emits no coverage REDs (stays skipped)
- [ ] `printReport` exit code is non-zero when a coverage RED exists
- [ ] full suite + tsc + lint clean

**Risk callouts:** must not double-count — an event present-and-broken is already RED via `probeEntry`; the coverage pass only adds events ENTIRELY ABSENT (`!present.has(event)`), so no duplicate row for a present event. Keep the managed-gate (`managed.length > 0`) or a clean project settings.json floods 6 false reds. Reuse `OPENSQUID_HOOK_REGEX` (already in-file) — do not re-derive the managed-detector.

**References:** `src/setup/cli/doctor.ts:100-123` (`runDoctorHooks`), `:151` (`OPENSQUID_HOOK_REGEX` use), `:43-80` (`PROBE_PAYLOADS` — all 6 events already have probes), `src/setup/wizard/settings-writer.ts:36-47` (`OPENSQUID_BIN_FOR_EVENT`).

**Verification commands:** `npx vitest run src/setup/cli/doctor.test.ts && npx vitest run && npx tsc -p tsconfig.build.json --noEmit && npm run lint`.

**7-phase steps:** 1 pre-research: DONE (presence-vs-coverage gap). 2 learn: lock the managed-gated coverage pass reusing OPENSQUID_BIN_FOR_EVENT + OPENSQUID_HOOK_REGEX. 3 code: import + the coverage loop. 4 test: missing-flagged + full-green + non-managing-skipped + exit-code. 5 audit: no double-count, no project-scope spam. 6 post-research: n/a. 7 fix.
