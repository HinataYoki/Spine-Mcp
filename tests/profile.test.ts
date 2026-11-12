import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, profileFindings, profileReport, readProfile, withProfile, type Profile } from "../src/config.js";
import { teamSettings } from "../src/spine/unity-import.js";

const TEAM: Omit<Profile, "file"> = {
  name: "team-ui",
  tools: { spine_export: { format: "binary", premultipliedAlpha: false, maxSize: 2048 } },
  export: { maxPages: 1, sidesMultipleOf: 4 },
  unity: {
    texture: { type: "sprite", spriteMode: "multiple", sRGB: true, alphaIsTransparency: true, mipmaps: false, platforms: [{ target: "Android", format: "ASTC_5x5", maxSize: 4096 }, { target: "iOS", format: "ASTC_5x5" }] },
    spriteSlices: true,
    graphic: { canvasGroupCompatible: true, pmaVertexColors: false, material: "SkeletonGraphicDefault-CanvasGroupStraight" },
  },
};

function file(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "spine-mcp-profile-"));
  const f = join(dir, "team-ui.json");
  writeFileSync(f, typeof content === "string" ? content : JSON.stringify(content));
  return f;
}

describe("team profile", () => {
  it("loads from SPINE_MCP_PROFILE and keeps a broken file as an error for the tools", () => {
    const config = loadConfig({ SPINE_MCP_PROFILE: file(TEAM) });
    expect(config.profile?.name).toBe("team-ui");
    expect(config.profileError).toBeUndefined();
    const broken = loadConfig({ SPINE_MCP_PROFILE: file("{ nope") });
    expect(broken.profile).toBeNull();
    expect(() => withProfile(broken, "spine_export", {})).toThrow(/SPINE_MCP_PROFILE/);
    expect(loadConfig({}).profile).toBeNull();
  });

  it("refuses tool defaults that are not objects and platforms without a format", () => {
    expect(() => readProfile(file({ tools: { spine_export: 1 } }))).toThrow(/tools must map/);
    expect(() => readProfile(file({ unity: { texture: { platforms: [{ target: "Android" }] } } }))).toThrow(/target and format/);
    expect(readProfile(file({})).name).toBe("team-ui");
  });

  it("fills only the arguments the call leaves out, and says which", () => {
    const config = loadConfig({ SPINE_MCP_PROFILE: file(TEAM) });
    const { args, defaults } = withProfile(config, "spine_export", { project: "/a.spine", maxSize: 4096, format: undefined });
    expect(args).toEqual({ project: "/a.spine", maxSize: 4096, format: "binary", premultipliedAlpha: false });
    expect(defaults).toEqual(["format", "premultipliedAlpha"]);
    expect(withProfile(config, "spine_validate", { project: "/a.spine" })).toEqual({ args: { project: "/a.spine" }, defaults: [] });
  });

  it("flags pages over the limit, sides not divisible, and platform formats that did not take", () => {
    const profile = { ...TEAM, file: "x" } as Profile;
    const findings = profileFindings(profile, {
      atlases: [{ file: "a.atlas", pages: [{ width: 1924, height: 840 }, { width: 474, height: 222 }] }],
      textures: [{ texture: "Assets/a.png", material: "m", platforms: { Android: { overridden: true, maxTextureSize: 4096, format: "ASTC_5x5" }, iPhone: { overridden: false, maxTextureSize: 2048, format: "AutomaticCompressed" } } }],
    });
    expect(findings).toEqual([
      "a.atlas: 2 pages, the profile allows 1.",
      "a.atlas: page 474x222, the profile wants sides divisible by 4.",
      "a.png: iOS imports as no override, the profile wants ASTC_5x5.",
    ]);
    const report = profileReport({ ...loadConfig({}), profile }, ["format"], { atlases: [] });
    const check = profileReport({ ...loadConfig({}), profile }, [], { textures: [{ material: "m", platforms: {} }] });
    expect((check as { profile?: { findings?: string[] } }).profile?.findings).toBeUndefined();
    const imported = profileReport({ ...loadConfig({}), profile }, [], { textures: [{ material: "m", platforms: {} }] }, true);
    expect((imported as { profile?: { findings?: string[] } }).profile?.findings).toHaveLength(2);
    expect(report).toMatchObject({ profile: { name: "team-ui", defaults: ["format"] } });
    expect(profileReport(loadConfig({}), [], { a: 1 })).toEqual({ a: 1 });
  });

  it("hands Unity the texture and SkeletonGraphic settings, unset ones as -1", () => {
    expect(teamSettings(TEAM.unity)).toEqual({
      textureType: "sprite", spriteMode: "multiple", sRGB: 1, alphaIsTransparency: 1, mipmaps: 0, maxSize: 0,
      platformTargets: ["Android", "iOS"], platformFormats: ["ASTC_5x5", "ASTC_5x5"], platformMaxSizes: [4096, 0],
      spriteSlices: true, canvasGroupCompatible: 1, pmaVertexColors: 0, graphicMaterial: "SkeletonGraphicDefault-CanvasGroupStraight",
    });
    expect(teamSettings(undefined)).toMatchObject({ textureType: "", sRGB: -1, spriteSlices: false, canvasGroupCompatible: -1, platformTargets: [] });
  });
});
