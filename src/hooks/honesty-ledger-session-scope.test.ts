/**
 * Tests specifically for the session-scope fix (#114).
 *
 * Verifies that:
 *  1. The ledger accumulates across multiple turns within a session.
 *  2. A claim made in turn N is satisfied by evidence from turn 1.
 *  3. clearSession wipes both ledger + broken-promises.
 *  4. Stop hook's de-dupe behavior — re-running reconcile on the same
 *     text doesn't double-record the broken promise.
 */
import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearSession,
  clearTurnLedger,
  reconcile,
  readBrokenPromises,
  readTurnLedger,
  recordBrokenPromise,
  recordToolCall,
} from "./honesty-ledger.js";

let tmpRoot: string;
const SESSION = "scope-test-session";

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `oscli-honesty-scope-${crypto.randomUUID()}`);
  await fs.mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("session-scoped ledger (#114 fix)", () => {
  it("accumulates tool calls across multiple turns", async () => {
    // Turn 1: ran npm test
    await recordToolCall(SESSION, "Bash", "npm test", { dataRoot: tmpRoot });
    // Turn 2: ran cargo check
    await recordToolCall(SESSION, "Bash", "cargo check", { dataRoot: tmpRoot });
    // Turn 3: read a file
    await recordToolCall(SESSION, "Read", "/x.ts", { dataRoot: tmpRoot });
    const ledger = await readTurnLedger(SESSION, { dataRoot: tmpRoot });
    expect(ledger).toHaveLength(3);
    expect(ledger.map((e) => e.tool)).toEqual(["Bash", "Bash", "Read"]);
  });

  it("recap text in turn N is satisfied by tool call from turn 1 (THE FIX)", async () => {
    // Turn 1: actually ran tests
    await recordToolCall(SESSION, "Bash", "npm test", { dataRoot: tmpRoot });
    // Turn 5 (much later): assistant says "tests pass" in recap text
    const recapText = "Here's a summary. Tests pass and build is green.";
    const ledger = await readTurnLedger(SESSION, { dataRoot: tmpRoot });
    const broken = reconcile(recapText, ledger);
    // Before the fix: would flag "tests pass" as a broken promise.
    // After the fix: ledger has the prior turn's npm test, so satisfied.
    expect(broken.map((b) => b.claim_id)).not.toContain("running-tests");
  });

  it("genuinely lying recap is still caught (no false-negative regression)", async () => {
    // Turn 1: read a file
    await recordToolCall(SESSION, "Read", "/foo.ts", { dataRoot: tmpRoot });
    // Turn 2: claim "tests pass" but NO test was ever run in this session
    const ledger = await readTurnLedger(SESSION, { dataRoot: tmpRoot });
    const broken = reconcile("Tests pass.", ledger);
    expect(broken.map((b) => b.claim_id)).toContain("running-tests");
  });

  it("clearTurnLedger removes only the ledger file (not broken-promises)", async () => {
    await recordToolCall(SESSION, "Bash", "ls", { dataRoot: tmpRoot });
    await recordBrokenPromise(
      SESSION,
      {
        ts: "t",
        claim_id: "fake",
        claim_label: "fake",
        matched_text: "fake",
        reason: "fake",
      },
      { dataRoot: tmpRoot },
    );
    await clearTurnLedger(SESSION, { dataRoot: tmpRoot });
    expect(await readTurnLedger(SESSION, { dataRoot: tmpRoot })).toEqual([]);
    // broken-promises survives a turn-ledger clear
    expect(await readBrokenPromises(SESSION, { dataRoot: tmpRoot })).toHaveLength(1);
  });

  it("clearSession wipes BOTH ledger and broken-promises", async () => {
    await recordToolCall(SESSION, "Bash", "ls", { dataRoot: tmpRoot });
    await recordBrokenPromise(
      SESSION,
      {
        ts: "t",
        claim_id: "fake",
        claim_label: "fake",
        matched_text: "fake",
        reason: "fake",
      },
      { dataRoot: tmpRoot },
    );
    await clearSession(SESSION, { dataRoot: tmpRoot });
    expect(await readTurnLedger(SESSION, { dataRoot: tmpRoot })).toEqual([]);
    expect(await readBrokenPromises(SESSION, { dataRoot: tmpRoot })).toEqual([]);
  });

  it("clearSession is idempotent (no throw on already-clean session)", async () => {
    await clearSession(SESSION, { dataRoot: tmpRoot });
    await clearSession(SESSION, { dataRoot: tmpRoot });
    // No throw.
  });
});

describe("stuck-broken-promise dedupe (#114 fix companion)", () => {
  it("reconcile on the same text twice returns the same set", async () => {
    // No tool calls. Claim text triggers two patterns.
    const broken1 = reconcile("Tests pass and committed.", []);
    const broken2 = reconcile("Tests pass and committed.", []);
    expect(broken1.map((b) => b.claim_id).sort()).toEqual(broken2.map((b) => b.claim_id).sort());
    // Both should flag running-tests + committed
    expect(broken1.map((b) => b.claim_id)).toContain("running-tests");
    expect(broken1.map((b) => b.claim_id)).toContain("committed");
  });
});
