import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyResolution,
  cardPathForRoot,
  findProjectCard,
  loadRegistry,
  pruneDeleted,
  resolveProject,
  saveRegistry,
  writeProjectCard,
  type ProjectCard,
} from "./project.js";

let tmpRoot: string;
let tmpHome: string;

beforeEach(async () => {
  const uniq = crypto.randomUUID();
  tmpRoot = path.join(os.tmpdir(), `oscli-project-cwd-${uniq}`);
  tmpHome = path.join(os.tmpdir(), `oscli-project-home-${uniq}`);
  await fs.mkdir(tmpRoot, { recursive: true });
  await fs.mkdir(tmpHome, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// findProjectCard
// ---------------------------------------------------------------------

describe("findProjectCard", () => {
  it("returns null when no card in any ancestor", async () => {
    expect(await findProjectCard(tmpRoot)).toBeNull();
  });

  it("finds a card at cwd", async () => {
    const card: ProjectCard = {
      version: 1,
      id: "x",
      uuid: "u-1",
      created_at: "2026-05-15T00:00:00Z",
    };
    await writeProjectCard(tmpRoot, card);
    const found = await findProjectCard(tmpRoot);
    expect(found?.card.uuid).toBe("u-1");
  });

  it("walks up to find a card at an ancestor", async () => {
    const card: ProjectCard = {
      version: 1,
      id: "x",
      uuid: "u-1",
      created_at: "2026-05-15T00:00:00Z",
    };
    await writeProjectCard(tmpRoot, card);
    const deep = path.join(tmpRoot, "src", "nested", "deep");
    await fs.mkdir(deep, { recursive: true });
    const found = await findProjectCard(deep);
    expect(found?.card.uuid).toBe("u-1");
    expect(found?.cardPath).toBe(cardPathForRoot(tmpRoot));
  });

  it("ignores malformed card files", async () => {
    await fs.mkdir(path.join(tmpRoot, ".opensquid"), { recursive: true });
    await fs.writeFile(cardPathForRoot(tmpRoot), "{not valid json", "utf8");
    expect(await findProjectCard(tmpRoot)).toBeNull();
  });
});

// ---------------------------------------------------------------------
// writeProjectCard
// ---------------------------------------------------------------------

describe("writeProjectCard", () => {
  it("creates the .opensquid/project.json file", async () => {
    const card: ProjectCard = {
      version: 1,
      id: "x",
      uuid: "u-1",
      created_at: "now",
    };
    const res = await writeProjectCard(tmpRoot, card);
    expect(res.cardPath).toBe(cardPathForRoot(tmpRoot));
    const read = await fs.readFile(res.cardPath, "utf8");
    expect(JSON.parse(read).uuid).toBe("u-1");
  });

  it("refuses to overwrite without force", async () => {
    const card: ProjectCard = {
      version: 1,
      id: "x",
      uuid: "u-1",
      created_at: "now",
    };
    await writeProjectCard(tmpRoot, card);
    await expect(writeProjectCard(tmpRoot, card)).rejects.toThrow(/already exists/);
  });

  it("overwrites with force=true", async () => {
    const v1: ProjectCard = {
      version: 1,
      id: "x",
      uuid: "u-1",
      created_at: "now",
    };
    await writeProjectCard(tmpRoot, v1);
    const v2: ProjectCard = { ...v1, id: "y" };
    await writeProjectCard(tmpRoot, v2, { force: true });
    const found = await findProjectCard(tmpRoot);
    expect(found?.card.id).toBe("y");
  });
});

// ---------------------------------------------------------------------
// resolveProject — state machine
// ---------------------------------------------------------------------

describe("resolveProject state machine", () => {
  it("returns 'new' when no card exists", async () => {
    const r = await resolveProject(tmpRoot, { dataRoot: tmpHome });
    expect(r.kind).toBe("new");
    if (r.kind === "new") {
      expect(r.suggested_id).toBe(path.basename(tmpRoot));
    }
  });

  it("returns 'known' when card exists at path that matches registry", async () => {
    const card: ProjectCard = {
      version: 1,
      id: "x",
      uuid: "u-1",
      created_at: "now",
    };
    await writeProjectCard(tmpRoot, card);
    // Apply once so registry knows the path.
    await applyResolution(tmpRoot, await resolveProject(tmpRoot, { dataRoot: tmpHome }), {
      dataRoot: tmpHome,
    });
    const r = await resolveProject(tmpRoot, { dataRoot: tmpHome });
    expect(r.kind).toBe("known");
  });

  it("returns 'moved' when card exists at NEW path but registry has DIFFERENT path", async () => {
    // Create card at tmpRoot, register it there.
    const card: ProjectCard = {
      version: 1,
      id: "x",
      uuid: "u-1",
      created_at: "now",
    };
    await writeProjectCard(tmpRoot, card);
    await applyResolution(tmpRoot, await resolveProject(tmpRoot, { dataRoot: tmpHome }), {
      dataRoot: tmpHome,
    });
    // Simulate move: write the same card at a new path, leave registry as-is.
    const newRoot = path.join(os.tmpdir(), `oscli-moved-${crypto.randomUUID()}`);
    await fs.mkdir(newRoot, { recursive: true });
    try {
      await writeProjectCard(newRoot, card);
      const r = await resolveProject(newRoot, { dataRoot: tmpHome });
      expect(r.kind).toBe("moved");
      if (r.kind === "moved") {
        expect(r.from_path).toBe(tmpRoot);
      }
    } finally {
      await fs.rm(newRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------
// applyResolution
// ---------------------------------------------------------------------

describe("applyResolution", () => {
  it("auto-creates card on 'new' when autoCreate=true", async () => {
    const r = await resolveProject(tmpRoot, { dataRoot: tmpHome });
    expect(r.kind).toBe("new");
    const card = await applyResolution(tmpRoot, r, {
      dataRoot: tmpHome,
      autoCreate: true,
    });
    expect(card).not.toBeNull();
    expect(card?.id).toBe(path.basename(tmpRoot));
    // Card persisted on disk.
    const found = await findProjectCard(tmpRoot);
    expect(found?.card.uuid).toBe(card?.uuid);
    // Registry has it.
    const reg = await loadRegistry(tmpHome);
    expect(reg.projects[card!.uuid].last_seen_path).toBe(tmpRoot);
  });

  it("returns null on 'new' when autoCreate=false (default)", async () => {
    const r = await resolveProject(tmpRoot, { dataRoot: tmpHome });
    const card = await applyResolution(tmpRoot, r, { dataRoot: tmpHome });
    expect(card).toBeNull();
    expect(await findProjectCard(tmpRoot)).toBeNull();
  });

  it("custom --id overrides the suggested default on auto-create", async () => {
    const r = await resolveProject(tmpRoot, { dataRoot: tmpHome });
    const card = await applyResolution(tmpRoot, r, {
      dataRoot: tmpHome,
      autoCreate: true,
      id: "custom-name",
    });
    expect(card?.id).toBe("custom-name");
  });

  it("updates registry path on 'moved'", async () => {
    // Create card + register at tmpRoot.
    const card: ProjectCard = {
      version: 1,
      id: "x",
      uuid: "u-mov",
      created_at: "now",
    };
    await writeProjectCard(tmpRoot, card);
    await applyResolution(tmpRoot, await resolveProject(tmpRoot, { dataRoot: tmpHome }), {
      dataRoot: tmpHome,
    });
    // Move: same card at a new path.
    const newRoot = path.join(os.tmpdir(), `oscli-moved-${crypto.randomUUID()}`);
    await fs.mkdir(newRoot, { recursive: true });
    try {
      await writeProjectCard(newRoot, card);
      const r = await resolveProject(newRoot, { dataRoot: tmpHome });
      expect(r.kind).toBe("moved");
      await applyResolution(newRoot, r, { dataRoot: tmpHome });
      const reg = await loadRegistry(tmpHome);
      expect(reg.projects["u-mov"].last_seen_path).toBe(newRoot);
    } finally {
      await fs.rm(newRoot, { recursive: true, force: true });
    }
  });

  it("preserves created_at across registry updates", async () => {
    const card: ProjectCard = {
      version: 1,
      id: "x",
      uuid: "u-1",
      created_at: "2020-01-01T00:00:00Z",
    };
    await writeProjectCard(tmpRoot, card);
    await applyResolution(tmpRoot, await resolveProject(tmpRoot, { dataRoot: tmpHome }), {
      dataRoot: tmpHome,
    });
    const reg1 = await loadRegistry(tmpHome);
    const firstCreatedAt = reg1.projects["u-1"].created_at;
    // Second invocation shouldn't change created_at even when last_seen_at moves.
    await applyResolution(tmpRoot, await resolveProject(tmpRoot, { dataRoot: tmpHome }), {
      dataRoot: tmpHome,
    });
    const reg2 = await loadRegistry(tmpHome);
    expect(reg2.projects["u-1"].created_at).toBe(firstCreatedAt);
  });
});

// ---------------------------------------------------------------------
// pruneDeleted
// ---------------------------------------------------------------------

describe("pruneDeleted", () => {
  it("flips entries whose last_seen_path no longer exists", async () => {
    // Set up two entries: one path exists, one doesn't.
    const goneRoot = path.join(os.tmpdir(), `oscli-gone-${crypto.randomUUID()}`);
    await fs.mkdir(goneRoot);
    await saveRegistry(
      {
        version: 1,
        projects: {
          alive: {
            id: "alive",
            last_seen_path: tmpRoot,
            last_seen_at: "2026-05-15T00:00:00Z",
            created_at: "2026-05-15T00:00:00Z",
            status: "active",
          },
          gone: {
            id: "gone",
            last_seen_path: goneRoot,
            last_seen_at: "2026-05-15T00:00:00Z",
            created_at: "2026-05-15T00:00:00Z",
            status: "active",
          },
        },
      },
      tmpHome,
    );
    // Delete the path for "gone" so it'll be flagged.
    await fs.rm(goneRoot, { recursive: true, force: true });
    const res = await pruneDeleted(tmpHome);
    expect(res.swept).toBe(1);
    expect(res.removed_ids).toEqual(["gone"]);
    const reg = await loadRegistry(tmpHome);
    expect(reg.projects.alive.status).toBe("active");
    expect(reg.projects.gone.status).toBe("deleted");
  });

  it("does not touch already-deleted entries", async () => {
    await saveRegistry(
      {
        version: 1,
        projects: {
          ghost: {
            id: "ghost",
            last_seen_path: "/nonexistent/path",
            last_seen_at: "2026-05-15T00:00:00Z",
            created_at: "2026-05-15T00:00:00Z",
            status: "deleted",
          },
        },
      },
      tmpHome,
    );
    const res = await pruneDeleted(tmpHome);
    expect(res.swept).toBe(0);
  });
});
