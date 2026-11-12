import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSpineBin, defaultWorkDir, loadConfig } from "../src/config.js";
import { packSettings, verifyHeaders } from "../src/spine/export.js";

describe("platform defaults", () => {
  it("knows where Spine and the cache live per platform, and the environment wins", () => {
    expect(defaultSpineBin("darwin")).toBe("/Applications/Spine.app/Contents/MacOS/Spine");
    expect(defaultSpineBin("win32", { ProgramFiles: "D:\\Apps" })).toBe("D:\\Apps\\Spine\\Spine.com");
    expect(defaultSpineBin("linux")).toMatch(/Spine\/Spine\.sh$/);
    expect(defaultWorkDir("win32", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" })).toBe("C:\\Users\\me\\AppData\\Local\\spine-mcp");
    expect(defaultWorkDir("darwin")).toMatch(/Library\/Caches\/spine-mcp$/);
    expect(loadConfig({ SPINE_BIN: "/x/Spine", SPINE_VERSION: "4.2.43" })).toMatchObject({ spineBin: resolve("/x/Spine"), spineVersion: "4.2.43" });
    // Relative values become absolute: the Spine CLI runs in its own empty folder, where they would point elsewhere (G115).
    expect(loadConfig({ SPINE_BIN: "tools/Spine", SPINE_MCP_WORKDIR: "spine-cache" })).toMatchObject({ spineBin: resolve("tools/Spine"), workDir: resolve("spine-cache") });
  });
});

describe("older-version exports", () => {
  it("checks the version a skeleton file carries (JSON header, binary header)", () => {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-hdr-"));
    writeFileSync(join(dir, "hero.json"), JSON.stringify({ skeleton: { hash: "x", spine: "4.2.43" }, bones: [] }));
    // A binary file: 8-byte hash, then the version string.
    writeFileSync(join(dir, "hero.skel"), Buffer.concat([Buffer.alloc(8, 7), Buffer.from([7]), Buffer.from("4.2.43"), Buffer.alloc(32)]));
    writeFileSync(join(dir, "old.json"), JSON.stringify({ skeleton: { spine: "4.1.24" } }));
    const r = verifyHeaders(dir, ["hero.json", "hero.skel", "old.json", "hero.atlas"], "4.2.43");
    expect(r.map((v) => [v.file, v.ok])).toEqual([["hero.json", true], ["hero.skel", true], ["old.json", false]]);
    expect(r[2]!.detail).toMatch(/4\.1\.24, expected 4\.2\.43/);
  });
});

describe("pack settings", () => {
  it("packs pages divisible by 4 by default and rounds a max size Spine's packer would refuse (G119)", () => {
    expect(packSettings({ project: "/p.spine", outputDir: "/o" })).toMatchObject({ multipleOfFour: true, maxWidth: 2048, maxHeight: 2048 });
    expect(packSettings({ project: "/p.spine", outputDir: "/o", maxSize: 1366 })).toMatchObject({ maxWidth: 1364, maxHeight: 1364 });
    expect(packSettings({ project: "/p.spine", outputDir: "/o", maxSize: 1366, multipleOfFour: false })).toMatchObject({ multipleOfFour: false, maxWidth: 1366 });
  });
});

