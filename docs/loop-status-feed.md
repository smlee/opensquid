# Loop-status feed — live where-is-every-item, no polling

`opensquid loop-status` surfaces where every driven loop item is to the **harness** (your running Claude Code
session) — never to chat, never to a log file you poll.
It is the thin renderer over the reusable `collectLoopState()` read-model (`src/runtime/loop/loop_state.ts`);
the future loop-state UI consumes the identical `LoopState` contract via `--json`.

Design of record: `loop/docs/design/subprocess-harness-push.md`.

## The CLI

```
opensquid loop-status [--json | --status-line | --watch | --metrics] [--width <n>]
```

| Mode            | What it emits                                                     | Consumed by               |
| --------------- | ----------------------------------------------------------------- | ------------------------- |
| _(default)_     | the live view, one item per line (idle line when empty)           | a human at a terminal     |
| `--json`        | the raw `LoopState` array (full truth, every item incl. terminal) | the future loop-state UI  |
| `--status-line` | exactly ONE width-bounded line, `+N more` overflow, never throws  | the harness status line   |
| `--watch`       | one line per change, a terminal drain line when the board empties | the `Monitor` tool        |
| `--metrics`     | the `loop_metrics` history (per-stage rows + per-loop aggregate)  | cost/perf review + the UI |

The hierarchy each line renders is **stage → phase-within-stage** — e.g.
`🦑 wg-0baaae4bcf2e · code · test (4/7)  wg-cf8c09d74213 · scope_write`.
`scope` is shown (scoping is active work); a `done` item lingers for one iteration then drops.

## Surface 1 — the status line (always-visible current state)

Claude Code runs a small script and displays its output at the bottom, harness-refreshed. Point it at the
`--status-line` mode in `~/.claude/settings.json` (or the project `.claude/settings.json`):

```json
{
  "statusLine": {
    "type": "command",
    "command": "opensquid loop-status --status-line --width 120"
  }
}
```

`--status-line` NEVER throws — a read/render fault degrades to the stable idle line
(`🦑 loop idle — no items in flight`), never a broken status bar. `--width` bounds the render; overflow becomes
a `+N more` suffix so the line always fits.

## Surface 2 — Monitor (push per transition)

The `Monitor` tool streams each stdout line of a long-running script as a push notification. `--watch` emits one
line per **change** (not per poll), and a terminal `■ loop drained` line when the board empties — silence is a
bug, not success. Invoke it from a session:

```
Monitor({
  command: "opensquid loop-status --watch --interval 2000",
  description: "loop item transitions",
})
```

Each transition (`wg-… · code · fix (7/7)`) arrives as its own notification; you keep working and react the
moment an item advances. No `tail -f`, no in-session polling.

## Surface 3 — the ADDITIVE pill (compose into your OWN status line)

Surface 1 REPLACES your status line and spawns a `node` process on every ~300ms harness render. If you already
have a status line you like (repo · branch · cost · model · …) and just want to ADD a live loop pill to it, use
this surface instead: opensquid publishes a pre-rendered fragment STRING to `<root>/.opensquid/loop-statusline`
on each loop state change (fail-open, off the hot path — `src/runtime/loop/statusline_snapshot.ts`), and your own
script reads it with a bare `cat`. No `node` spawn, no `jq`, zero render cost. `opensquid` never owns your line.

Paste this into your `~/.claude/statusline-command.sh` just before the final `printf "%b\n" "$out"` (keep it
wherever you like in `$out`):

```sh
# --- opensquid loop pill (additive; reads the pre-rendered fragment opensquid publishes on each state change) ---
root="$PWD"
while [ "$root" != "/" ] && [ ! -d "$root/.opensquid" ]; do root=$(dirname "$root"); done
frag="$root/.opensquid/loop-statusline"
# fresh (published within 2 min = a live loop) AND non-empty → append as one dim pill; a dead loop's file goes
# stale (find matches nothing) so the pill disappears — never a frozen live line.
if [ -f "$frag" ] && [ -n "$(find "$frag" -mmin -2 2>/dev/null)" ]; then
  pill=$(cat "$frag")
  if [ -n "$pill" ]; then out="${out} ${PIPE} ${DIM}${pill}${RESET}"; fi
fi
# --- end opensquid loop pill ---
```

The block walks UP from `$PWD` for a `.opensquid/` dir (git-style), so the pill works from any subdirectory. The
`find "$frag" -mmin -2` freshness guard is REQUIRED: a live loop emits phase events well inside 2 minutes, so its
file stays fresh; a crashed loop (which never published the graceful-drain blank) leaves a frozen file that goes
stale, so `find` matches nothing and the pill disappears — never a frozen live line (decision 4). Tune the
`-mmin -2` window to your loop's phase cadence. The fragment already carries each item's age
(`🦑 wg-… · code · test (4/7) ⟳ · 3m ago`), so a quiet-but-live loop still reads honestly. No loop running → an
empty fragment → no pill (your line is unchanged). It is POSIX `sh` (`find -mmin`, `dirname`, `cat` — portable
across macOS/Linux; no `stat -f`/`stat -c`), and the pill reuses your script's own `${DIM}`/`${RESET}`/`${PIPE}`
vars, so no ANSI codes are baked into the fragment.

## The metrics history (`--metrics`)

Beyond the live "where is it now," `loop_metrics` is the durable cost/performance time series — one row per
**stage**, folded from data that already exists (per-lap cost/tokens from the lap-log envelope, per-stage timing
from the stage-advance boundary, harness/auth-mode from `ralph.config`). It is SQL-filterable:

```
opensquid loop-status --metrics --since 2026-07-01 --task wg-0baaae4bcf2e --harness claude [--json]
```

`--json` emits `{ stages, loops }` — the per-stage rows plus the per-loop SUM aggregate (per-loop = the aggregate
of its stages). Cost + tokens are recorded **always**, even on a subscription (notional cost), so you can gauge
what a run would cost regardless of billing model.

## Where the state comes from (core / pack split)

- **Core = pack-agnostic mechanism.** `collectLoopState()` merges the whole-board stage
  (`CheckpointStore.listTaskCheckpoints()`), the wg-keyed current-stage phase (`loop_phases`), and the
  pack-declared terminal stage. `setLoopPhase(wgId, phase, index, total)` (the `set_loop_phase` MCP tool) is a
  generic phase writer — it stamps whatever opaque label the pack passes and carries no stage vocabulary.
- **Pack = policy.** The `fullstack-flow` pack's per-stage procedures call `set_loop_phase` at their own real
  phase boundaries — every stage, CODE's 7 phases included. The pack names its terminal stage (`done`).

Status visibility does NOT go to Telegram/chat — the former `surfaceReportToChat` push was removed
(`v2_supply.ts`, §4 of the design). Reports still SAVE to `.opensquid/reports/`; only their _visibility_ moved to
the harness status line / Monitor.
