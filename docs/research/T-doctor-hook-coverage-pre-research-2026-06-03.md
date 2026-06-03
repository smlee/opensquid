# Pre-research — FC.5: `doctor hooks` coverage check (flag MISSING hook registrations)

**Date:** 2026-06-03. **Repo:** opensquid. **Trigger:** the PostToolUse/SessionStart
stale-settings gap (whole enforcement classes silently off) was found by suspicion, not by
tooling. `opensquid doctor hooks` should have caught it. **Research this turn:** `recall`
(doctor / hook-wiring discipline), Read of `src/setup/cli/doctor.ts` (full runner),
`settings-writer.ts` (`OPENSQUID_BIN_FOR_EVENT`); grep of doctor structure.

## 1. Root cause (verified, file:line)

`runDoctorHooks` (`doctor.ts:100-123`) enumerates `readSettingsHooks(path)` — the hooks
ALREADY IN `settings.json` — and probes each (`probeEntry`: spawn + assert the
`[opensquid-dispatch] event=<kind>` marker on stderr). It is a **presence-and-health**
check of registered hooks. It has NO **coverage** check: a canonical event that is ABSENT
from `settings.json` is simply not in `entries`, so it produces no result — `doctor hooks`
reports all-green while PostToolUse + SessionStart are entirely unregistered. That is
exactly the failure mode that silently disabled FSM phase-advance + SessionStart
enforcement on this machine.

## 2. Fix design (derived)

Add a coverage pass to `runDoctorHooks`, per scope:

- A scope "manages opensquid" iff ≥1 of its entries matches `OPENSQUID_HOOK_REGEX`
  (already used at `doctor.ts:151`). User scope always manages; a project scope with no
  opensquid hooks does not (correctly exempt — project hooks are optional).
- For a managing scope, compute `present = entries.filter(opensquid-managed).map(e=>e.event)`
  and flag every `event ∈ keys(OPENSQUID_BIN_FOR_EVENT)` NOT in `present` as **RED**:
  `"<event> not registered — run \`opensquid setup wizard hooks\`"`.

```ts
// doctor.ts runDoctorHooks, after the probe loop for a scope:
const managed = entries.filter((e) => e.type === 'command' && OPENSQUID_HOOK_REGEX.test(e.command));
if (managed.length > 0) {
  const present = new Set(managed.map((e) => e.event));
  for (const event of Object.keys(OPENSQUID_BIN_FOR_EVENT)) {
    if (!present.has(event)) {
      results.push(
        mk(
          scope,
          event,
          OPENSQUID_BIN_FOR_EVENT[event],
          'red',
          'not registered in settings.json — run `opensquid setup wizard hooks`',
        ),
      );
    }
  }
}
```

`printReport` already counts RED → non-zero exit, so CI/wrappers fail loud. No
output-format change needed.

## 3. Decisions (no unresolved guess)

1. **Coverage gated on "manages opensquid"**, not unconditional — derived: a project
   settings.json with zero opensquid hooks must stay `skipped`, not spew 6 reds.
2. **Reuse `OPENSQUID_BIN_FOR_EVENT` + `OPENSQUID_HOOK_REGEX`** — single source of truth
   for the canonical set + the managed-detector; no new constant.
3. **RED, not warn** — a missing enforcement class is a hard failure (the whole point is
   CI/`doctor`-detectable). Matches the existing red-on-broken-marker severity.

## 4. Open questions — none that block. `readSettingsHooks`'s `ParsedHookEntry` already

carries `{event, command, type}` (consumed at `probeEntry`), so the present-set is a
direct map; confirm its exact field names when wiring the test.
