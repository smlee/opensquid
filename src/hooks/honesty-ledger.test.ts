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

  it("every pattern has a valid regex", () => {
    for (const p of CLAIM_PATTERNS) {
      expect(() => new RegExp(p.text_regex, "i")).not.toThrow();
    }
  });
});
