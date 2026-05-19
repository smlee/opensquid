import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendPromotedLessonToClaudeMd, listRulesBlockLessonIds } from "./claude-md.js";

let tmpFile: string;

beforeEach(async () => {
  tmpFile = path.join(os.tmpdir(), `oscli-claude-md-${crypto.randomUUID()}.md`);
});

afterEach(async () => {
  await fs.rm(tmpFile, { force: true });
});

const INSTALLED_BLOCK = `<!-- opensquid-automation:start v0.4.0 -->
## opensquid

Use recall before substantive answers.

### Active lessons (auto-managed — do not edit by hand)

<!-- opensquid-rules:start (auto-managed) -->
(no promoted lessons yet — this block populates as \`lesson.promote\`
succeeds for user-endorsed candidates)
<!-- opensquid-rules:end -->
<!-- opensquid-automation:end -->
`;

describe("appendPromotedLessonToClaudeMd", () => {
  it("returns null when CLAUDE.md doesn't exist", async () => {
    const res = await appendPromotedLessonToClaudeMd(
      { id: "les-x", description: "anything", promoted_at: "2026-05-15T00:00:00Z" },
      { target: tmpFile },
    );
    expect(res).toBeNull();
  });

  it("returns null when the rules block isn't installed", async () => {
    await fs.writeFile(tmpFile, "# Just a regular CLAUDE.md\nNothing fancy.\n", "utf8");
    const res = await appendPromotedLessonToClaudeMd(
      { id: "les-x", description: "anything", promoted_at: "now" },
      { target: tmpFile },
    );
    expect(res).toBeNull();
  });

  it("replaces the placeholder with the first promoted lesson", async () => {
    await fs.writeFile(tmpFile, INSTALLED_BLOCK, "utf8");
    const res = await appendPromotedLessonToClaudeMd(
      {
        id: "les-abc12345",
        description: "before any git push or release",
        promoted_at: "2026-05-15T19:00:00Z",
      },
      { target: tmpFile },
    );
    expect(res?.appended).toBe(true);
    const content = await fs.readFile(tmpFile, "utf8");
    expect(content).not.toContain("(no promoted lessons yet");
    expect(content).toContain("(lesson:les-abc12345)");
    expect(content).toContain("before any git push or release");
    expect(content).toContain("promoted 2026-05-15T19:00:00Z");
  });

  it("appends subsequent lessons without removing prior ones", async () => {
    await fs.writeFile(tmpFile, INSTALLED_BLOCK, "utf8");
    await appendPromotedLessonToClaudeMd(
      { id: "les-1", description: "first rule", promoted_at: "2026-05-15T19:00:00Z" },
      { target: tmpFile },
    );
    await appendPromotedLessonToClaudeMd(
      { id: "les-2", description: "second rule", promoted_at: "2026-05-15T19:01:00Z" },
      { target: tmpFile },
    );
    const content = await fs.readFile(tmpFile, "utf8");
    expect(content).toContain("(lesson:les-1)");
    expect(content).toContain("(lesson:les-2)");
    expect(content).toContain("first rule");
    expect(content).toContain("second rule");
  });

  it("is idempotent — re-promoting the same id is a no-op", async () => {
    await fs.writeFile(tmpFile, INSTALLED_BLOCK, "utf8");
    await appendPromotedLessonToClaudeMd(
      { id: "les-1", description: "rule one", promoted_at: "2026-05-15T19:00:00Z" },
      { target: tmpFile },
    );
    const before = await fs.readFile(tmpFile, "utf8");
    const res = await appendPromotedLessonToClaudeMd(
      { id: "les-1", description: "rule one", promoted_at: "2026-05-15T19:30:00Z" },
      { target: tmpFile },
    );
    expect(res?.appended).toBe(false);
    const after = await fs.readFile(tmpFile, "utf8");
    expect(after).toBe(before);
  });

  it("preserves the outer automation block sentinels", async () => {
    await fs.writeFile(tmpFile, INSTALLED_BLOCK, "utf8");
    await appendPromotedLessonToClaudeMd(
      { id: "les-x", description: "anything", promoted_at: "2026-05-15T00:00:00Z" },
      { target: tmpFile },
    );
    const content = await fs.readFile(tmpFile, "utf8");
    expect(content).toContain("<!-- opensquid-automation:start v0.4.0 -->");
    expect(content).toContain("<!-- opensquid-automation:end -->");
    expect(content).toContain("<!-- opensquid-rules:start (auto-managed) -->");
    expect(content).toContain("<!-- opensquid-rules:end -->");
  });
});

describe("listRulesBlockLessonIds", () => {
  it("returns [] when no rules block", async () => {
    await fs.writeFile(tmpFile, "# plain\n", "utf8");
    expect(await listRulesBlockLessonIds({ target: tmpFile })).toEqual([]);
  });

  it("returns ids in append order", async () => {
    await fs.writeFile(tmpFile, INSTALLED_BLOCK, "utf8");
    await appendPromotedLessonToClaudeMd(
      { id: "les-aaa", description: "a", promoted_at: "t1" },
      { target: tmpFile },
    );
    await appendPromotedLessonToClaudeMd(
      { id: "les-bbb", description: "b", promoted_at: "t2" },
      { target: tmpFile },
    );
    expect(await listRulesBlockLessonIds({ target: tmpFile })).toEqual(["les-aaa", "les-bbb"]);
  });
});
