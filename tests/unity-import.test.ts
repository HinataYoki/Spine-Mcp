import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectUnityProject, renderPipelineOf, unityHasProjectOpen } from "../src/spine/unity-import.js";
import { textureFindings } from "../src/spine/unity.js";

function unityProject(manifest?: object, assetsPkg?: object): string {
  const dir = mkdtempSync(join(tmpdir(), "spine-mcp-uproj-"));
  mkdirSync(join(dir, "Assets"), { recursive: true });
  mkdirSync(join(dir, "ProjectSettings"), { recursive: true });
  mkdirSync(join(dir, "Packages"), { recursive: true });
  writeFileSync(join(dir, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.6.2f1\nm_EditorVersionWithRevision: 6000.6.2f1 (x)\n");
  if (manifest) writeFileSync(join(dir, "Packages", "manifest.json"), JSON.stringify(manifest));
  if (assetsPkg) {
    mkdirSync(join(dir, "Assets", "Spine"), { recursive: true });
    writeFileSync(join(dir, "Assets", "Spine", "package.json"), JSON.stringify(assetsPkg));
  }
  return dir;
}

const UNITY = "/Applications/Unity/Hub/Editor/6000.6.2f1/Unity.app/Contents/MacOS/Unity";

describe("Unity project inspection", () => {
  it("finds spine-unity in the manifest (local package with its version, or a registry version)", () => {
    const pkg = mkdtempSync(join(tmpdir(), "spine-unity-pkg-"));
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "com.esotericsoftware.spine.spine-unity", version: "4.3.115" }));
    const local = inspectUnityProject(unityProject({ dependencies: { "com.esotericsoftware.spine.spine-unity": `file:${pkg}` } }), () => "");
    expect(local).toMatchObject({ editorVersion: "6000.6.2f1", editorOpen: false, spineUnity: { found: true, version: "4.3.115" } });
    const git = inspectUnityProject(unityProject({ dependencies: { "com.esotericsoftware.spine.spine-unity": "https://github.com/EsotericSoftware/spine-runtimes.git?path=spine-unity/Assets/Spine#4.3" } }), () => "");
    expect(git.spineUnity).toMatchObject({ found: true, version: null });
  });

  it("finds spine-unity imported into Assets, and reports when it is missing", () => {
    expect(inspectUnityProject(unityProject({ dependencies: {} }, { name: "com.esotericsoftware.spine.spine-unity", version: "4.2.100" }), () => "").spineUnity)
      .toEqual({ found: true, version: "4.2.100", where: "Assets/Spine" });
    expect(inspectUnityProject(unityProject({ dependencies: {} }), () => "").spineUnity.found).toBe(false);
    expect(() => inspectUnityProject(mkdtempSync(join(tmpdir(), "not-unity-")), () => "")).toThrow(/Not a Unity project/);
    expect(() => inspectUnityProject("relative/path", () => "")).toThrow(/absolute/);
  });

  it("reads the render pipeline and the Spine shader package it needs", () => {
    expect(renderPipelineOf(unityProject({ dependencies: {} }))).toMatchObject({ kind: "built-in", advice: null });
    const urp = unityProject({ dependencies: { "com.unity.render-pipelines.universal": "17.0.3" } });
    // The package alone is not the pipeline: GraphicsSettings must point at a pipeline asset.
    expect(renderPipelineOf(urp).kind).toBe("built-in");
    writeFileSync(join(urp, "ProjectSettings", "GraphicsSettings.asset"), "  m_CustomRenderPipeline: {fileID: 11400000, guid: 4b83569d67af61e458304325a23e5dfd, type: 2}\n");
    expect(renderPipelineOf(urp)).toMatchObject({ kind: "urp", package: "17.0.3", spineShaders: null });
    expect(renderPipelineOf(urp).advice).toMatch(/com\.esotericsoftware\.spine\.urp-shaders/);
    const withShaders = unityProject({ dependencies: { "com.unity.render-pipelines.universal": "17.0.3", "com.esotericsoftware.spine.urp-shaders": "4.3.20" } });
    writeFileSync(join(withShaders, "ProjectSettings", "QualitySettings.asset"), "    customRenderPipeline: {fileID: 11400000, guid: abc, type: 2}\n");
    expect(renderPipelineOf(withShaders)).toMatchObject({ kind: "urp", spineShaders: "com.esotericsoftware.spine.urp-shaders 4.3.20", advice: null });
  });

  it("flags texture import settings that shrink, blur or mismatch the atlas", () => {
    const base = { material: "hero_Material", shader: "Spine/Skeleton", straightAlphaInput: 0, texture: "Assets/Spine/hero/hero.png", source: [2048, 1024] as [number, number], filter: "Bilinear", compression: "Compressed" };
    expect(textureFindings([{ ...base, sRGB: false, alphaIsTransparency: false, maxTextureSize: 2048, mipmaps: false, platforms: { Android: { overridden: false, maxTextureSize: 2048, format: "Automatic" } } }], true)).toEqual([]);
    const bad = textureFindings([{ ...base, sRGB: true, alphaIsTransparency: true, maxTextureSize: 1024, mipmaps: true, platforms: { Android: { overridden: true, maxTextureSize: 512, format: "ETC2_RGBA8" }, iPhone: { overridden: false, maxTextureSize: 256, format: "Automatic" } } }], true).join(" | ");
    expect(bad).toMatch(/Max Size 1024/);
    expect(bad).toMatch(/Android override caps it at 512/);
    expect(bad).not.toMatch(/iPhone/); // not overridden: the default applies
    expect(bad).toMatch(/mip maps on/);
    expect(bad).toMatch(/Alpha Is Transparency on/);
    expect(textureFindings([{ ...base, sRGB: false, alphaIsTransparency: false, maxTextureSize: 2048 }], false).join(" ")).toMatch(/straight alpha but imported like a PMA texture/);
  });

  it("detects a Unity editor with the project open, not batch runs or other projects", () => {
    const p = "/Users/me/Games/Hero Project";
    expect(unityHasProjectOpen(p, () => `${UNITY} -projectpath ${p} -useHub -hubIPC`)).toBe(true);
    expect(unityHasProjectOpen(p, () => `${UNITY} -projectPath ${p}/`)).toBe(true);
    expect(unityHasProjectOpen(p, () => `${UNITY} -batchmode -nographics -projectPath ${p} -executeMethod X`)).toBe(false);
    expect(unityHasProjectOpen(p, () => `${UNITY} -projectpath /Users/me/Games/Other -useHub`)).toBe(false);
    expect(unityHasProjectOpen(p, () => "/Applications/Unity Hub.app/Contents/MacOS/Unity Hub")).toBe(false);
  });
});
