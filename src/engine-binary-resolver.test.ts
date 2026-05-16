import { describe, expect, it } from "vitest";

import {
  binaryNameForPlatform,
  currentPlatform,
  packageForPlatform,
  resolveBundledEngineBin,
} from "./engine-binary-resolver.js";

describe("packageForPlatform", () => {
  it("maps darwin-arm64 → opensquid-engine-darwin-arm64", () => {
    expect(packageForPlatform({ platform: "darwin", arch: "arm64" })).toBe(
      "opensquid-engine-darwin-arm64",
    );
  });
  it("maps darwin-x64 → opensquid-engine-darwin-x64", () => {
    expect(packageForPlatform({ platform: "darwin", arch: "x64" })).toBe(
      "opensquid-engine-darwin-x64",
    );
  });
  it("maps linux-x64 → opensquid-engine-linux-x64", () => {
    expect(packageForPlatform({ platform: "linux", arch: "x64" })).toBe(
      "opensquid-engine-linux-x64",
    );
  });
  it("maps linux-arm64 → opensquid-engine-linux-arm64", () => {
    expect(packageForPlatform({ platform: "linux", arch: "arm64" })).toBe(
      "opensquid-engine-linux-arm64",
    );
  });
  it("maps win32-x64 → opensquid-engine-win32-x64", () => {
    expect(packageForPlatform({ platform: "win32", arch: "x64" })).toBe(
      "opensquid-engine-win32-x64",
    );
  });
  it("maps win32-arm64 → opensquid-engine-win32-arm64", () => {
    expect(packageForPlatform({ platform: "win32", arch: "arm64" })).toBe(
      "opensquid-engine-win32-arm64",
    );
  });
  it("returns null for unsupported platform (freebsd)", () => {
    expect(packageForPlatform({ platform: "freebsd" as NodeJS.Platform, arch: "x64" })).toBeNull();
  });
  it("returns null for unsupported arch (ppc64)", () => {
    expect(packageForPlatform({ platform: "linux", arch: "ppc64" })).toBeNull();
  });
});

describe("binaryNameForPlatform", () => {
  it("returns loop-engine on unix", () => {
    expect(binaryNameForPlatform({ platform: "darwin", arch: "arm64" })).toBe("loop-engine");
    expect(binaryNameForPlatform({ platform: "linux", arch: "x64" })).toBe("loop-engine");
  });
  it("returns loop-engine.exe on windows", () => {
    expect(binaryNameForPlatform({ platform: "win32", arch: "x64" })).toBe("loop-engine.exe");
    expect(binaryNameForPlatform({ platform: "win32", arch: "arm64" })).toBe("loop-engine.exe");
  });
  it("returns null for unsupported platform", () => {
    expect(binaryNameForPlatform({ platform: "aix" as NodeJS.Platform, arch: "x64" })).toBeNull();
  });
});

describe("currentPlatform", () => {
  it("returns the live process platform + arch", () => {
    const probe = currentPlatform();
    expect(probe.platform).toBe(process.platform);
    expect(probe.arch).toBe(process.arch);
  });
});

describe("resolveBundledEngineBin", () => {
  it("returns null for unsupported platform (no map entry → no resolve attempt)", () => {
    expect(
      resolveBundledEngineBin({ platform: "haiku" as NodeJS.Platform, arch: "x64" }),
    ).toBeNull();
  });

  it("returns null when the optional dep isn't installed for the current platform", () => {
    // Pre-publish: none of the opensquid-engine-* packages exist in
    // node_modules. The resolver must not throw — it must return null
    // so callers fall through to the legacy discovery chain. After
    // publish, this assertion would flip; the test stays correct as a
    // pre-publish guarantee.
    expect(resolveBundledEngineBin()).toBeNull();
  });
});
