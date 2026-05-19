import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearSession,
  readBrokenPromises,
  readTurnLedger,
  recordBrokenPromise,
  recordToolCall,
} from "./honesty-ledger.js";

let tmpRoot: string;
const SESSION = "session-end-test";

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `oscli-session-end-${crypto.randomUUID()}`);
  await fs.mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("SessionEnd cleanup (clearSession via the hook)", () => {
  it("wipes both ledger and broken-promises after population", async () => {
    await recordToolCall(SESSION, "Bash", "npm test", { dataRoot: tmpRoot });
    await recordToolCall(SESSION, "Bash", "git commit -m foo", { dataRoot: tmpRoot });
    await recordBrokenPromise(
      SESSION,
      {
        ts: "2026-05-15T00:00:00Z",
        claim_id: "fake",
        claim_label: "x",
        matched_text: "y",
        reason: "z",
      },
      { dataRoot: tmpRoot },
    );
    // Sanity-check the precondition.
    expect((await readTurnLedger(SESSION, { dataRoot: tmpRoot })).length).toBe(2);
    expect((await readBrokenPromises(SESSION, { dataRoot: tmpRoot })).length).toBe(1);

    // SessionEnd action.
    await clearSession(SESSION, { dataRoot: tmpRoot });

    expect(await readTurnLedger(SESSION, { dataRoot: tmpRoot })).toEqual([]);
    expect(await readBrokenPromises(SESSION, { dataRoot: tmpRoot })).toEqual([]);
  });

  it("session directory remains, just empty of ledger files", async () => {
    await recordToolCall(SESSION, "Bash", "ls", { dataRoot: tmpRoot });
    await clearSession(SESSION, { dataRoot: tmpRoot });
    // The sessions/<id>/ directory itself is preserved (cheap),
    // only the JSONL files inside are removed.
    const dir = path.join(tmpRoot, "sessions", SESSION);
    await expect(fs.access(dir)).resolves.toBeUndefined();
    const entries = await fs.readdir(dir);
    expect(entries).toEqual([]);
  });

  it("does NOT touch other sessions' ledgers", async () => {
    await recordToolCall(SESSION, "Bash", "ls", { dataRoot: tmpRoot });
    await recordToolCall("other-session", "Bash", "ls", { dataRoot: tmpRoot });
    await clearSession(SESSION, { dataRoot: tmpRoot });
    expect((await readTurnLedger(SESSION, { dataRoot: tmpRoot })).length).toBe(0);
    expect((await readTurnLedger("other-session", { dataRoot: tmpRoot })).length).toBe(1);
  });
});
