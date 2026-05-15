import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  forgetEngineBin,
  loadConfig,
  resolveEngineBin,
  saveConfig,
  setEngineBin,
} from "./config.js";

let tmpHome: string;
let savedEnvBin: string | undefined;

beforeEach(async () => {
  tmpHome = path.join(os.tmpdir(), `oscli-config-${crypto.randomUUID()}`);
  await fs.mkdir(tmpHome, { recursive: true });
  savedEnvBin = process.env.OPENSQUID_ENGINE_BIN;
  delete process.env.OPENSQUID_ENGINE_BIN;
  process.env.OPENSQUID_HOME = tmpHome;
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
  if (savedEnvBin === undefined) delete process.env.OPENSQUID_ENGINE_BIN;
  else process.env.OPENSQUID_ENGINE_BIN = savedEnvBin;
  delete process.env.OPENSQUID_HOME;
});

// Helper: write a fake executable at a tmp path.
async function fakeExecAt(dir: string, name = "loop-engine"): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, name);
  await fs.writeFile(p, "#!/bin/sh\necho fake\n", "utf8");
  await fs.chmod(p, 0o755);
  return p;
}

// ---------------------------------------------------------------------
// load / save
// ---------------------------------------------------------------------

describe("loadConfig + saveConfig", () => {
  it("returns default config when file is missing", async () => {
    const c = await loadConfig();
    expect(c.version).toBe(1);
    expect(c.engine_bin).toBeUndefined();
  });

  it("round-trips a saved config", async () => {
    await saveConfig({ version: 1, engine_bin: "/x/y", engine_bin_resolved_at: "now" });
    const c = await loadConfig();
    expect(c.engine_bin).toBe("/x/y");
  });

  it("returns default on malformed config", async () => {
    await fs.mkdir(tmpHome, { recursive: true });
    await fs.writeFile(path.join(tmpHome, "config.json"), "{not json", "utf8");
    const c = await loadConfig();
    expect(c.version).toBe(1);
    expect(c.engine_bin).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// resolveEngineBin
// ---------------------------------------------------------------------

describe("resolveEngineBin priority order", () => {
  it("env var wins over everything (no validation)", async () => {
    process.env.OPENSQUID_ENGINE_BIN = "/some/explicit/path";
    expect(await resolveEngineBin()).toBe("/some/explicit/path");
  });

  it("uses persisted config when env is unset and path is executable", async () => {
    const bin = await fakeExecAt(path.join(tmpHome, "tools"));
    await saveConfig({ version: 1, engine_bin: bin });
    expect(await resolveEngineBin()).toBe(bin);
  });

  it("ignores persisted config when its path is no longer executable", async () => {
    // Persist a path that doesn't exist.
    await saveConfig({ version: 1, engine_bin: "/nonexistent/loop-engine" });
    // Auto-search and $PATH likely won't hit on this machine either.
    const result = await resolveEngineBin();
    // We can't assert null universally (CI runners might have something
    // matching), but the bad persisted path must not have been returned.
    expect(result).not.toBe("/nonexistent/loop-engine");
  });
});

// ---------------------------------------------------------------------
// setEngineBin
// ---------------------------------------------------------------------

describe("setEngineBin", () => {
  it("validates the path is executable", async () => {
    await expect(setEngineBin("/nonexistent/bin")).rejects.toThrow(/not an executable/);
  });

  it("persists the path on success", async () => {
    const bin = await fakeExecAt(path.join(tmpHome, "tools"));
    const res = await setEngineBin(bin);
    expect(res.resolved).toBe(bin);
    const config = await loadConfig();
    expect(config.engine_bin).toBe(bin);
    expect(config.engine_bin_resolved_at).toBeDefined();
  });

  it("resolves relative paths to absolute", async () => {
    const bin = await fakeExecAt(path.join(tmpHome, "tools"));
    const rel = path.relative(process.cwd(), bin);
    const res = await setEngineBin(rel);
    expect(path.isAbsolute(res.resolved)).toBe(true);
    expect(res.resolved).toBe(bin);
  });
});

// ---------------------------------------------------------------------
// forgetEngineBin
// ---------------------------------------------------------------------

describe("forgetEngineBin", () => {
  it("clears the persisted engine_bin", async () => {
    const bin = await fakeExecAt(path.join(tmpHome, "tools"));
    await setEngineBin(bin);
    expect((await loadConfig()).engine_bin).toBe(bin);
    await forgetEngineBin();
    expect((await loadConfig()).engine_bin).toBeUndefined();
  });

  it("is idempotent on missing config", async () => {
    await forgetEngineBin();
    await forgetEngineBin();
    // No throw — config just stays empty.
    expect((await loadConfig()).engine_bin).toBeUndefined();
  });
});
