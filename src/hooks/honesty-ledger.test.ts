import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLAIM_PATTERNS,
  clearTurnLedger,
  reconcile,
  readBrokenPromises,
  readTurnLedger,
  recordBrokenPromise,
  recordToolCall,
  type TurnLedgerEntry,
} from "./honesty-ledger.js";

let tmpRoot: string;
const SESSION = "test-session";

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `oscli-honesty-${crypto.randomUUID()}`);
  await fs.mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// Ledger I/O
// ---------------------------------------------------------------------

describe("turn ledger", () => {
  it("recordToolCall appends and readTurnLedger returns entries", async () => {
    await recordToolCall(SESSION, "Bash", "git status", { dataRoot: tmpRoot });
    await recordToolCall(SESSION, "Read", "src/foo.ts", { dataRoot: tmpRoot });
    const entries = await readTurnLedger(SESSION, { dataRoot: tmpRoot });
    expect(entries.map((e) => e.tool)).toEqual(["Bash", "Read"]);
  });

  it("readTurnLedger returns [] when no ledger exists", async () => {
    expect(await readTurnLedger("unknown-session", { dataRoot: tmpRoot })).toEqual([]);
  });

  it("clearTurnLedger removes the file", async () => {
    await recordToolCall(SESSION, "Bash", "ls", { dataRoot: tmpRoot });
    await clearTurnLedger(SESSION, { dataRoot: tmpRoot });
    expect(await readTurnLedger(SESSION, { dataRoot: tmpRoot })).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// Reconcile — the heart of the lie-catcher
// ---------------------------------------------------------------------

function ledger(...entries: Array<[string, string]>): TurnLedgerEntry[] {
  return entries.map(([tool, input_summary]) => ({
    ts: "2026-05-15T00:00:00Z",
    tool,
    input_summary,
  }));
}

describe("reconcile — research-start", () => {
  it("flags 'pre-research starting' with no Agent tool call", async () => {
    const broken = reconcile("Pre-research starting for #111.", []);
    expect(broken.map((b) => b.claim_id)).toContain("research-start");
  });

  it("doesn't flag when Agent was actually called", async () => {
    const broken = reconcile("Pre-research starting now.", ledger(["Agent", "research prompt"]));
    expect(broken.map((b) => b.claim_id)).not.toContain("research-start");
  });

  it("flags 'research begins' phrasing", async () => {
    const broken = reconcile("Research begins.", []);
    expect(broken.map((b) => b.claim_id)).toContain("research-start");
  });
});

describe("reconcile — running-tests", () => {
  it("flags 'tests pass' without npm test or cargo test in the ledger", async () => {
    const broken = reconcile("All tests pass.", ledger(["Read", "x.ts"]));
    expect(broken.map((b) => b.claim_id)).toContain("running-tests");
  });

  it("clears when npm test ran", async () => {
    const broken = reconcile("Tests pass.", ledger(["Bash", "npm test"]));
    expect(broken.map((b) => b.claim_id)).not.toContain("running-tests");
  });

  it("clears when cargo test ran", async () => {
    const broken = reconcile("Tests passed.", ledger(["Bash", "cargo test --lib"]));
    expect(broken.map((b) => b.claim_id)).not.toContain("running-tests");
  });
});

describe("reconcile — committed", () => {
  it("flags 'committed' without git commit in the ledger", async () => {
    const broken = reconcile("Just committed the change.", ledger(["Read", "x"]));
    expect(broken.map((b) => b.claim_id)).toContain("committed");
  });

  it("clears when git commit ran", async () => {
    const broken = reconcile("Committed and ready.", ledger(["Bash", "git commit -m foo"]));
    expect(broken.map((b) => b.claim_id)).not.toContain("committed");
  });
});

describe("reconcile — audit-done", () => {
  it("flags 'audit done' with empty ledger", async () => {
    const broken = reconcile("Phase 5 audit done.", []);
    expect(broken.map((b) => b.claim_id)).toContain("audit-done");
  });

  it("clears when any tool was called (audit is loose)", async () => {
    const broken = reconcile("Audit done.", ledger(["Read", "src/serve.rs"]));
    expect(broken.map((b) => b.claim_id)).not.toContain("audit-done");
  });
});

describe("reconcile — running-build", () => {
  it("flags 'build clean' without npm build or cargo build", async () => {
    const broken = reconcile("Build clean.", []);
    expect(broken.map((b) => b.claim_id)).toContain("running-build");
  });

  it("clears when npm run build ran", async () => {
    const broken = reconcile("Build green.", ledger(["Bash", "npm run build"]));
    expect(broken.map((b) => b.claim_id)).not.toContain("running-build");
  });
});

describe("reconcile — no claims = no broken promises", () => {
  it("returns [] when text has no claim phrases", async () => {
    expect(reconcile("Here's a regular sentence with no claims.", [])).toEqual([]);
  });

  it("doesn't false-fire on 'research' as a noun", async () => {
    // "the research is going" doesn't trigger "research starting"
    const broken = reconcile("The research is going well.", []);
    expect(broken.map((b) => b.claim_id)).not.toContain("research-start");
  });
});

describe("reconcile — case-insensitive", () => {
  it("matches 'COMMITTED' as well as 'committed'", async () => {
    const broken = reconcile("COMMITTED.", []);
    expect(broken.map((b) => b.claim_id)).toContain("committed");
  });
});

// ---------------------------------------------------------------------
// Broken-promise persistence
// ---------------------------------------------------------------------

describe("broken-promise ledger", () => {
  it("recordBrokenPromise appends and readBrokenPromises returns entries", async () => {
    await recordBrokenPromise(
      SESSION,
      {
        ts: "2026-05-15T00:00:00Z",
        claim_id: "research-start",
        claim_label: "spawn a research agent",
        matched_text: "pre-research starting",
        reason: "no Agent tool call",
      },
      { dataRoot: tmpRoot },
    );
    const promises = await readBrokenPromises(SESSION, { dataRoot: tmpRoot });
    expect(promises).toHaveLength(1);
    expect(promises[0].claim_id).toBe("research-start");
  });

  it("appends are additive across multiple calls", async () => {
    await recordBrokenPromise(SESSION, mockPromise("a"), { dataRoot: tmpRoot });
    await recordBrokenPromise(SESSION, mockPromise("b"), { dataRoot: tmpRoot });
    const promises = await readBrokenPromises(SESSION, { dataRoot: tmpRoot });
    expect(promises.map((p) => p.claim_id)).toEqual(["a", "b"]);
  });
});

function mockPromise(claim_id: string) {
  return {
    ts: "2026-05-15T00:00:00Z",
    claim_id,
    claim_label: "x",
    matched_text: "x",
    reason: "x",
  };
}

// ---------------------------------------------------------------------
// Catalog sanity
// ---------------------------------------------------------------------

describe("CLAIM_PATTERNS catalog", () => {
  it("has at least the 6 MVP patterns", () => {
    const ids = CLAIM_PATTERNS.map((p) => p.id);
    expect(ids).toContain("research-start");
    expect(ids).toContain("running-tests");
    expect(ids).toContain("committed");
    expect(ids).toContain("audit-done");
    expect(ids).toContain("running-build");
    expect(ids).toContain("starting-now");
  });

  it("v0.6.4: includes 5 new claim patterns from today's drift catalog", () => {
    const ids = CLAIM_PATTERNS.map((p) => p.id);
    expect(ids).toContain("telegram-sent");
    expect(ids).toContain("pushed");
    expect(ids).toContain("tagged");
    expect(ids).toContain("phase-logged");
    expect(ids).toContain("fmt-clippy");
  });

  it("every pattern has a valid regex", () => {
    for (const p of CLAIM_PATTERNS) {
      expect(() => new RegExp(p.text_regex, "i")).not.toThrow();
    }
  });
});

// =====================================================================
// v0.6.4 — new claim patterns from today's drift catalog. Each test
// asserts BOTH the unfulfilled case (broken promise) AND the fulfilled
// case (evidence satisfied → no broken promise). Pattern-detection
// false-positives are low-cost (one nag) but false-negatives let the
// drift slip — these tests pin both directions.
// =====================================================================

describe("reconcile — telegram-sent (v0.6.4)", () => {
  it("flags 'Telegram report sent' without any chat tool call", () => {
    const broken = reconcile("🦑 Telegram report sent.", ledger(["Bash", "ls"]));
    expect(broken.map((b) => b.claim_id)).toContain("telegram-sent");
  });

  it("satisfies when mcp__plugin_telegram_telegram__reply was called", () => {
    const broken = reconcile(
      "🦑 Telegram report sent.",
      ledger(["mcp__plugin_telegram_telegram__reply", "{}"]),
    );
    expect(broken.map((b) => b.claim_id)).not.toContain("telegram-sent");
  });

  it("satisfies when mcp__opensquid__chat_send was called (any_of evidence)", () => {
    const broken = reconcile(
      "Pinged you via telegram.",
      ledger(["mcp__opensquid__chat_send", "{}"]),
    );
    expect(broken.map((b) => b.claim_id)).not.toContain("telegram-sent");
  });

  it("matches 'sent to telegram' / 'pinged you' phrasings", () => {
    const broken = reconcile("Sent to Telegram successfully.", ledger());
    expect(broken.map((b) => b.claim_id)).toContain("telegram-sent");
    const broken2 = reconcile("Pinged you on Telegram.", ledger());
    expect(broken2.map((b) => b.claim_id)).toContain("telegram-sent");
  });
});

describe("reconcile — pushed (v0.6.4 — expanded alternation)", () => {
  it("flags 'pushed to origin' without git push", () => {
    const broken = reconcile("Pushed to origin main.", ledger(["Bash", "git status"]));
    expect(broken.map((b) => b.claim_id)).toContain("pushed");
  });

  it("satisfies with git push call", () => {
    const broken = reconcile("Pushed to main.", ledger(["Bash", "git push origin main"]));
    expect(broken.map((b) => b.claim_id)).not.toContain("pushed");
  });

  it("matches 'pushing the engine' phrasing", () => {
    const broken = reconcile("Pushing the engine commit now.", ledger());
    expect(broken.map((b) => b.claim_id)).toContain("pushed");
  });

  // v0.6.4 audit-LOW expansion: common phrasings the previous regex missed.
  it("matches 'pushed it'", () => {
    const broken = reconcile("Pushed it to remote.", ledger());
    expect(broken.map((b) => b.claim_id)).toContain("pushed");
  });

  it("matches 'pushed the branch'", () => {
    const broken = reconcile("Pushed the branch.", ledger());
    expect(broken.map((b) => b.claim_id)).toContain("pushed");
  });

  it("matches 'pushed the PR'", () => {
    const broken = reconcile("Pushed the PR.", ledger());
    expect(broken.map((b) => b.claim_id)).toContain("pushed");
  });

  it("matches 'pushed the changes'", () => {
    const broken = reconcile("Pushed the changes upstream.", ledger());
    expect(broken.map((b) => b.claim_id)).toContain("pushed");
  });
});

describe("reconcile — tagged (v0.6.4 — requires version-shaped token)", () => {
  it("flags 'just tagged v0.5.0' without git tag", () => {
    const broken = reconcile("Just tagged v0.5.0.", ledger(["Bash", "git log"]));
    expect(broken.map((b) => b.claim_id)).toContain("tagged");
  });

  it("satisfies with git tag call", () => {
    const broken = reconcile("Tagged v0.5.0.", ledger(["Bash", "git tag -a v0.5.0 -m 'release'"]));
    expect(broken.map((b) => b.claim_id)).not.toContain("tagged");
  });

  // v0.6.4 audit-MED tightening: false-positive reduction. Bare
  // "tagged" without a version-shaped token (`tagged for review`,
  // `tagged as P0`, `tagged the file`) no longer triggers.
  it("does NOT flag 'tagged for review' (prose, no version)", () => {
    const broken = reconcile("This PR is tagged for review.", ledger());
    expect(broken.map((b) => b.claim_id)).not.toContain("tagged");
  });

  it("does NOT flag 'tagged this as P0' (label prose)", () => {
    const broken = reconcile("I tagged this issue as P0.", ledger());
    expect(broken.map((b) => b.claim_id)).not.toContain("tagged");
  });

  it("matches 'tagged 0.5.0' (no v-prefix)", () => {
    const broken = reconcile("Tagged 0.5.0 just now.", ledger());
    expect(broken.map((b) => b.claim_id)).toContain("tagged");
  });
});

describe("reconcile — phase-logged (v0.6.4 — tightened to require 'phase' keyword)", () => {
  it("flags 'logged audit phase' without mcp__opensquid__log_phase call", () => {
    const broken = reconcile("Logged audit phase + post_research phase.", ledger(["Bash", "ls"]));
    expect(broken.map((b) => b.claim_id)).toContain("phase-logged");
  });

  it("satisfies with mcp__opensquid__log_phase call", () => {
    const broken = reconcile(
      "Logging audit phase now.",
      ledger(["mcp__opensquid__log_phase", "{}"]),
    );
    expect(broken.map((b) => b.claim_id)).not.toContain("phase-logged");
  });

  it("matches 'phases logged' (passive voice)", () => {
    const broken = reconcile("Both phases logged for the task.", ledger());
    expect(broken.map((b) => b.claim_id)).toContain("phase-logged");
  });

  // #169 (S2): the bare `\\blog_phase\\b` alternation was removed —
  // it fired on any prose mention of the tool name. "Called log_phase
  // for audit" without saying "phase" now no longer fires. The phase-
  // word-aware alternations ("logged the audit phase", "phases
  // logged") still fire and are the legitimate promises.
  it("does NOT flag 'Called log_phase for audit' bare identifier (#169)", () => {
    const broken = reconcile("Called log_phase for audit.", ledger());
    expect(broken.map((b) => b.claim_id)).not.toContain("phase-logged");
  });

  // v0.6.4 audit-MED tightening: false-positive reduction. Prose that
  // uses "logged" + a phase-name word but NOT the word "phase" no
  // longer triggers (e.g. "logged audit results" in debug discussion).
  it("does NOT flag 'logged audit results' (debug prose, not phase ceremony)", () => {
    const broken = reconcile("Logged audit results to the journal.", ledger());
    expect(broken.map((b) => b.claim_id)).not.toContain("phase-logged");
  });
});

describe("reconcile — fmt-clippy (v0.6.4)", () => {
  it("flags 'fmt + clippy clean' without running them", () => {
    const broken = reconcile(
      "fmt + clippy clean, ready to commit.",
      ledger(["Bash", "git status"]),
    );
    expect(broken.map((b) => b.claim_id)).toContain("fmt-clippy");
  });

  it("satisfies with cargo fmt call", () => {
    const broken = reconcile("fmt clean.", ledger(["Bash", "cargo fmt --check"]));
    expect(broken.map((b) => b.claim_id)).not.toContain("fmt-clippy");
  });

  it("satisfies with prettier call", () => {
    const broken = reconcile("prettier passes.", ledger(["Bash", "npx prettier --check src/"]));
    expect(broken.map((b) => b.claim_id)).not.toContain("fmt-clippy");
  });
});

// =====================================================================
// New evidence kinds (any_of + input_contains)
// =====================================================================

describe("hasEvidence — any_of (v0.6.4)", () => {
  it("satisfies when ANY option's evidence matches", () => {
    // claim with any_of [tool_called: A, tool_called: B]
    // ledger has B → should be satisfied
    const broken = reconcile("Telegram report sent.", ledger(["mcp__opensquid__chat_send", "{}"]));
    expect(broken.map((b) => b.claim_id)).not.toContain("telegram-sent");
  });

  it("breaks when NONE of the options match", () => {
    const broken = reconcile("Telegram report sent.", ledger(["Bash", "ls"], ["Read", "/tmp/foo"]));
    expect(broken.map((b) => b.claim_id)).toContain("telegram-sent");
  });
});

// ---------------------------------------------------------------------
// 0.7.6 (#150) drift-fix patterns
// ---------------------------------------------------------------------

describe("reconcile — version-slot-assignment (#150)", () => {
  it("flags 'v0.8' mention without AskUserQuestion / Task call", () => {
    const broken = reconcile("This ships as v0.8 next.", ledger(["Bash", "git status"]));
    expect(broken.map((b) => b.claim_id)).toContain("version-slot-assignment");
  });

  it("flags 'next minor' phrasing", () => {
    const broken = reconcile("Bumping to next minor.", ledger(["Read", "x.ts"]));
    expect(broken.map((b) => b.claim_id)).toContain("version-slot-assignment");
  });

  it("flags 'v1.0' assignment", () => {
    const broken = reconcile("This will ship as v1.0.", []);
    expect(broken.map((b) => b.claim_id)).toContain("version-slot-assignment");
  });

  it("clears when AskUserQuestion was called", () => {
    const broken = reconcile(
      "Going to ship as v0.8.",
      ledger(["AskUserQuestion", '{"slot": "v0.8"}']),
    );
    expect(broken.map((b) => b.claim_id)).not.toContain("version-slot-assignment");
  });

  it("clears when TaskUpdate happened (e.g. user-authorized task subject rename)", () => {
    const broken = reconcile("Renaming task to v0.9.", ledger(["TaskUpdate", '{"taskId":"144"}']));
    expect(broken.map((b) => b.claim_id)).not.toContain("version-slot-assignment");
  });

  it("does NOT flag patch-slot strings (v0.7.6 etc.)", () => {
    const broken = reconcile("Patch bumps to v0.7.6.", []);
    expect(broken.map((b) => b.claim_id)).not.toContain("version-slot-assignment");
  });
});

describe("reconcile — phase-claim-forward (#150)", () => {
  it("flags 'Phase 3/7 — code' without log_phase call", () => {
    const broken = reconcile("Phase 3/7 — code: editing files now.", ledger(["Edit", "x.ts"]));
    expect(broken.map((b) => b.claim_id)).toContain("phase-claim-forward");
  });

  it("flags 'now in phase audit' without log_phase", () => {
    const broken = reconcile("Now in phase audit.", ledger(["Bash", "git diff"]));
    expect(broken.map((b) => b.claim_id)).toContain("phase-claim-forward");
  });

  it("clears when log_phase was called", () => {
    const broken = reconcile(
      "Phase 4/7 — test: running suite.",
      ledger(["mcp__opensquid__log_phase", '{"phase":"test"}'], ["Bash", "npm test"]),
    );
    expect(broken.map((b) => b.claim_id)).not.toContain("phase-claim-forward");
  });
});

describe("reconcile — session-no-task (#150)", () => {
  it("flags 'now I'll wire it up' with no Task tool call", () => {
    const broken = reconcile("Now I'll run the migration.", ledger(["Bash", "ls"]));
    expect(broken.map((b) => b.claim_id)).toContain("session-no-task");
  });

  it("flags 'I'm executing' first-person verbiage with no task surface touched", () => {
    // #169 (S2): bare "Executing" was over-broad and fired on passive
    // descriptions. Now requires first-person framing.
    const broken = reconcile("I'm executing the plan.", ledger(["Edit", "x.ts"]));
    expect(broken.map((b) => b.claim_id)).toContain("session-no-task");
  });

  it("clears when TaskCreate happened in this turn", () => {
    const broken = reconcile(
      "Now I'll implement the fix.",
      ledger(["TaskCreate", '{"subject":"fix x"}'], ["Edit", "x.ts"]),
    );
    expect(broken.map((b) => b.claim_id)).not.toContain("session-no-task");
  });

  it("clears when TaskUpdate touched anything", () => {
    const broken = reconcile(
      "Let me build the thing.",
      ledger(["TaskUpdate", '{"taskId":"5","status":"in_progress"}']),
    );
    expect(broken.map((b) => b.claim_id)).not.toContain("session-no-task");
  });
});

describe("CLAIM_PATTERNS catalog — 0.7.6 expansion (#150)", () => {
  it("registers the three new patterns", () => {
    const ids = CLAIM_PATTERNS.map((p) => p.id);
    expect(ids).toContain("version-slot-assignment");
    expect(ids).toContain("phase-claim-forward");
    expect(ids).toContain("session-no-task");
  });
});

// ---------------------------------------------------------------------
// #169 (S2) — prose false-positive tightening
//
// Three patterns kept firing on prose that describes the system rather
// than on first-person commitments. Each block below pairs a TRUE-
// positive test (still fires for the real commitment) with a FALSE-
// positive eliminator (no longer fires for the prose form).
// ---------------------------------------------------------------------

describe("reconcile — phase-logged false-positive on bare `log_phase` (#169)", () => {
  it("does NOT flag prose mention of `log_phase` (e.g. tool documentation)", () => {
    const broken = reconcile(
      "The log_phase tool writes phase entries under ~/.opensquid/.",
      ledger(["Bash", "ls"]),
    );
    expect(broken.map((b) => b.claim_id)).not.toContain("phase-logged");
  });

  it("does NOT flag MCP tool identifier in code reference (`mcp__opensquid__log_phase`)", () => {
    const broken = reconcile(
      "Updated `mcp__opensquid__log_phase` evidence in CLAIM_PATTERNS.",
      ledger(["Edit", "honesty-ledger.ts"]),
    );
    expect(broken.map((b) => b.claim_id)).not.toContain("phase-logged");
  });

  it("STILL flags 'logged audit phase' past-tense claim without evidence", () => {
    const broken = reconcile("Just logged the audit phase.", ledger(["Bash", "ls"]));
    expect(broken.map((b) => b.claim_id)).toContain("phase-logged");
  });

  it("STILL flags 'phases logged' past-tense claim without evidence", () => {
    const broken = reconcile("Phases logged: audit, post_research.", []);
    expect(broken.map((b) => b.claim_id)).toContain("phase-logged");
  });
});

describe("reconcile — version-slot-assignment false-positive on user-named slot (#169)", () => {
  it("does NOT flag agent referencing a slot the USER mentioned in prose", () => {
    // Agent discussing a roadmap or user statement — no first-person
    // commitment verb near the version string.
    const broken = reconcile(
      "The user mentioned v0.8 in yesterday's session as the target.",
      ledger(["Read", "TASKS.md"]),
    );
    expect(broken.map((b) => b.claim_id)).not.toContain("version-slot-assignment");
  });

  it("does NOT flag prose describing the audit doc citing v0.9", () => {
    const broken = reconcile(
      "ROADMAP.md mentions v0.9 as a possible target.",
      ledger(["Read", "ROADMAP.md"]),
    );
    expect(broken.map((b) => b.claim_id)).not.toContain("version-slot-assignment");
  });

  it("STILL flags 'I'll bump to v0.8' first-person commitment", () => {
    const broken = reconcile("I'll bump to v0.8 next.", ledger(["Bash", "git status"]));
    expect(broken.map((b) => b.claim_id)).toContain("version-slot-assignment");
  });

  it("STILL flags 'shipping v0.9' first-person commitment", () => {
    const broken = reconcile("Shipping v0.9 today.", ledger(["Bash", "git status"]));
    expect(broken.map((b) => b.claim_id)).toContain("version-slot-assignment");
  });

  it("STILL flags inherently-committal 'next minor' phrasing", () => {
    const broken = reconcile("Bumping to next minor.", []);
    expect(broken.map((b) => b.claim_id)).toContain("version-slot-assignment");
  });

  it("STILL flags inherently-committal 'ships as vX.Y.Z' phrasing", () => {
    const broken = reconcile("This ships as v1.0.0.", []);
    expect(broken.map((b) => b.claim_id)).toContain("version-slot-assignment");
  });
});

describe("reconcile — session-no-task false-positive on bare 'executing' (#169)", () => {
  it("does NOT flag passive 'the script is executing X' description", () => {
    const broken = reconcile(
      "The script is executing the migration in the background.",
      ledger(["Read", "logs.txt"]),
    );
    expect(broken.map((b) => b.claim_id)).not.toContain("session-no-task");
  });

  it("does NOT flag 'opensquid is executing the codex' system description", () => {
    const broken = reconcile(
      "While opensquid is executing the codex check, the gate logs to stderr.",
      ledger(["Read", "honesty-ledger.ts"]),
    );
    expect(broken.map((b) => b.claim_id)).not.toContain("session-no-task");
  });

  it("STILL flags first-person 'I'm executing the plan'", () => {
    const broken = reconcile("I'm executing the plan.", ledger(["Edit", "x.ts"]));
    expect(broken.map((b) => b.claim_id)).toContain("session-no-task");
  });

  it("STILL flags 'now I'll' first-person framing", () => {
    const broken = reconcile("Now I'll run the migration.", ledger(["Bash", "ls"]));
    expect(broken.map((b) => b.claim_id)).toContain("session-no-task");
  });

  it("STILL flags 'let me run' / 'let me build' / etc. first-person framing", () => {
    const broken = reconcile("Let me build the thing.", ledger(["Bash", "ls"]));
    expect(broken.map((b) => b.claim_id)).toContain("session-no-task");
  });
});
