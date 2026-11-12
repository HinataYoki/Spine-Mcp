import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditUnityProject, binaryHeader } from "../src/spine/unity-audit.js";

/** A small Unity project: spine-unity 4.3, one skeleton exported by 4.2 (JSON), one by 4.3 (binary), a script on 4.2 APIs. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "spine-mcp-unity-audit-"));
  const w = (p: string, s: string | Buffer) => { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), s); };
  w("ProjectSettings/ProjectVersion.txt", "m_EditorVersion: 6000.0.30f1\n");
  w("Packages/manifest.json", JSON.stringify({ dependencies: { "com.esotericsoftware.spine.spine-unity": "4.3.40" } }));
  w("Assets/Characters/hero/hero.json", JSON.stringify({ skeleton: { hash: "abc", spine: "4.2.43" }, bones: [{ name: "root" }] }));
  w("Assets/Characters/hero/hero.json.meta", "fileFormatVersion: 2\nguid: 0123456789abcdef0123456789abcdef\n");
  w("Assets/Characters/hero/hero.atlas.txt", "hero.png\nsize: 1024,512\nfilter: Linear,Linear\npma: true\n");
  w("Assets/Characters/hero/hero.png.meta", ["fileFormatVersion: 2", "TextureImporter:", "  mipmaps:", "    enableMipMap: 1", "  maxTextureSize: 512", "  platformSettings:",
    "  - serializedVersion: 3", "    buildTarget: DefaultTexturePlatform", "    maxTextureSize: 512", "    textureFormat: -1", "    overridden: 0",
    "  - serializedVersion: 3", "    buildTarget: Android", "    maxTextureSize: 2048", "    textureFormat: 50", "    overridden: 1",
    "  - serializedVersion: 3", "    buildTarget: iPhone", "    maxTextureSize: 2048", "    textureFormat: -1", "    overridden: 0", ""].join("\n"));
  w("Assets/Characters/hero/hero_SkeletonData.asset", "skeletonJSON: {fileID: 4900000, guid: 0123456789abcdef0123456789abcdef, type: 3}\n");
  const version = Buffer.from("4.3.26");
  w("Assets/Characters/bolt/bolt.skel.bytes", Buffer.concat([Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, version.length + 1]), version, Buffer.alloc(16)]));
  w("Assets/Scripts/Player.cs", ["using Spine;", "using Spine.Unity;", "class Player {", "  void Reset() {", "    skeleton.SetToSetupPose();", "    // skeleton.SetToSetupPose(); in a comment", "    var e = animationState.GetCurrent(0);", "    skeleton.UpdateWorldTransform(Skeleton.Physics.Update);", "  }", "}"].join("\n"));
  w("Assets/Scripts/Unrelated.cs", "class Unrelated { void F() { list.GetCurrent(0); } }"); // no Spine: not scanned
  w("Assets/Spine/Runtime/Old.cs", "using Spine; class Old { void F() { skeleton.SetToSetupPose(); } }"); // the package itself: skipped
  return root;
}

describe("Unity project audit before a spine-unity upgrade", () => {
  it("reads binary headers", () => {
    const v = Buffer.from("4.3.26");
    expect(binaryHeader(Buffer.concat([Buffer.alloc(8, 1), Buffer.from([v.length + 1]), v, Buffer.alloc(4)]))).toEqual({ hash: "AQEBAQEBAQE", version: "4.3.26" });
  });

  it("finds data spine-unity will not load, its source and the update call, and the script lines on removed APIs", () => {
    const root = project();
    try {
      const r = auditUnityProject(root, { sources: [{ project: "/art/hero.spine", skeletons: [{ name: "hero", hash: null }] }] });
      expect(r.spineUnity).toBe("4.3.40");
      const hero = r.skeletons.find((s) => s.file.endsWith("hero.json"))!, bolt = r.skeletons.find((s) => s.file.endsWith("bolt.skel.bytes"))!;
      expect(hero).toMatchObject({ format: "json", spineVersion: "4.2.43", status: "reexport", dataAssets: ["Assets/Characters/hero/hero_SkeletonData.asset"], atlas: { pma: true }, source: { project: "/art/hero.spine", skeleton: "hero" } });
      expect(bolt).toMatchObject({ format: "binary", spineVersion: "4.3.26", status: "loads" });
      expect(r.plan).toEqual([{ project: "/art/hero.spine", folder: "Assets/Characters/hero", format: "json", premultipliedAlpha: true, update: true }]);
      expect(r.api.map((a) => [a.file, a.line])).toEqual([["Assets/Scripts/Player.cs", 5], ["Assets/Scripts/Player.cs", 7], ["Assets/Scripts/Player.cs", 8]]);
      expect(r.api[0]!.change).toMatch(/SetupPose\(\)/);
      expect(r.api[2]!.change).toMatch(/Spine\.Physics/);
      expect(r.notes.join(" ")).toMatch(/1 skeleton file\(s\) were exported with a Spine version spine-unity 4.3.40 does not load/);
      // The atlas page as Unity holds it: Max Size 512 halves it (blurry), mip maps add a third, Android stores ASTC 6x6 at full size.
      const page = r.textures[0]!;
      expect(page).toMatchObject({ texture: "Assets/Characters/hero/hero.png", size: [1024, 512], maxTextureSize: 512, imported: [512, 256], mipmaps: true });
      expect(page.platforms).toEqual([{ platform: "uncompressed", format: "RGBA32", MB: 0.67 }, { platform: "Android", format: "ASTC_6x6", MB: 0.3 }, { platform: "iPhone", format: "automatic", MB: null }]);
      expect(page.findings.join(" ")).toMatch(/Max Size 512 shrinks this 1024x512 page to 512x256.*Mip maps are on/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("knows ETC2 needs sides divisible by 4 and finds a Sprite page a SpriteAtlas packs again", () => {
    const root = project();
    try {
      const w = (p: string, s: string) => { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), s); };
      // A one-strip page as a game shipped it: Max Size 4096 makes it 4096x474, and 474 is not divisible by 4.
      w("Assets/UI/Banner/Spine/strip.atlas.txt", "strip.png\nsize:6500,752\nfilter:Linear,Linear\n");
      w("Assets/UI/Banner/Spine/strip.png.meta", ["fileFormatVersion: 2", "guid: fedcba9876543210fedcba9876543210", "TextureImporter:", "  maxTextureSize: 2048", "  textureType: 8", "  platformSettings:",
        "  - serializedVersion: 3", "    buildTarget: DefaultTexturePlatform", "    maxTextureSize: 2048", "    textureFormat: -1", "    overridden: 0",
        "  - serializedVersion: 3", "    buildTarget: Android", "    maxTextureSize: 4096", "    textureFormat: 47", "    overridden: 1",
        "  - serializedVersion: 3", "    buildTarget: iPhone", "    maxTextureSize: 4096", "    textureFormat: 49", "    overridden: 1", ""].join("\n"));
      w("Assets/Atlases/Banner.spriteatlas", "SpriteAtlas:\n  m_PackedSprites:\n  - {fileID: 21300000, guid: fedcba9876543210fedcba9876543210, type: 3}\n");
      const r = auditUnityProject(root, {});
      const page = r.textures.find((t) => t.texture.endsWith("strip.png"))!;
      // Android: ETC2 refused at 4096x474 -> RGBA32 (7.41 MB); iPhone: ASTC 5x5 has no size rule.
      expect(page.platforms.find((p) => p.platform === "Android")).toEqual({ platform: "Android", format: "RGBA32 (ETC2_RGBA8 needs sides divisible by 4)", MB: 7.41 });
      expect(page.platforms.find((p) => p.platform === "iPhone")).toMatchObject({ format: "ASTC_5x5" });
      const all = page.findings.join(" ");
      expect(all).toMatch(/Android: the ETC2_RGBA8 override cannot compress a 4096x474 texture/);
      expect(all).toMatch(/Assets\/Atlases\/Banner\.spriteatlas packs, so the whole page is packed into that SpriteAtlas a second time/);
      // The other page: divisible by 4, no texture type in its .meta, in no SpriteAtlas -> neither finding.
      const hero = r.textures.find((t) => t.texture.endsWith("hero.png"))!;
      expect(hero.findings.join(" ")).not.toMatch(/divisible by 4|SpriteAtlas/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sizes a Default-type page after Non-Power of 2 scaling, flags every 4x4 block format, finds a folder a V2 atlas packs", () => {
    const root = project();
    try {
      const w = (p: string, s: string) => { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), s); };
      w("Assets/Art/Spine/char.atlas.txt", "char.png\nsize:1022,510\nfilter:Linear,Linear\n");
      // spine-unity's texture preset: Default type, Non-Power of 2 ToNearest -> 1024x512, which ETC2 compresses.
      w("Assets/Art/Spine/char.png.meta", ["fileFormatVersion: 2", "guid: 0123456789abcdef0123456789abcdef", "TextureImporter:", "  maxTextureSize: 2048", "  nPOTScale: 1", "  textureType: 0", "  platformSettings:",
        "  - serializedVersion: 3", "    buildTarget: Android", "    maxTextureSize: 2048", "    textureFormat: 47", "    overridden: 1",
        "  - serializedVersion: 3", "    buildTarget: iPhone", "    maxTextureSize: 2048", "    textureFormat: 46", "    overridden: 1", ""].join("\n"));
      const page = () => auditUnityProject(root, {}).textures.find((t) => t.texture.endsWith("char.png"))!;
      let p = page();
      expect(p.imported).toEqual([1024, 512]);
      expect(p.platforms.find((x) => x.platform === "Android")).toEqual({ platform: "Android", format: "ETC2_RGBA8", MB: 0.5 });
      expect(p.findings.join(" ")).toMatch(/resamples the 1022x510 page to 1024x512/);
      // Non-Power of 2 None: the 1022x510 page stays, and ETC2 and ETC2 punch-through alpha both fall back to RGBA32.
      const meta = join(root, "Assets/Art/Spine/char.png.meta");
      writeFileSync(meta, readFileSync(meta, "utf8").replace("nPOTScale: 1", "nPOTScale: 0"));
      p = page();
      expect(p.platforms.find((x) => x.platform === "Android")!.format).toMatch(/^RGBA32 \(ETC2_RGBA8/);
      expect(p.platforms.find((x) => x.platform === "iPhone")!.format).toMatch(/^RGBA32 \(ETC2_RGB4_PUNCHTHROUGH_ALPHA/);
      // A V2 atlas lists only the folder; a Sprite-type page under it is packed a second time.
      writeFileSync(meta, readFileSync(meta, "utf8").replace("textureType: 0", "textureType: 8"));
      w("Assets/Art.meta", "fileFormatVersion: 2\nguid: aaaaaaaabbbbbbbbccccccccdddddddd\nfolderAsset: yes\n");
      w("Assets/Atlases/All.spriteatlasv2", "SpriteAtlasAsset:\n  m_MasterAtlas: {fileID: 0}\n  packables:\n  - {fileID: 102900000, guid: aaaaaaaabbbbbbbbccccccccdddddddd, type: 3}\n");
      expect(page().findings.join(" ")).toMatch(/Assets\/Atlases\/All\.spriteatlasv2 packs/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads texture import settings from a .meta with Windows line ends", () => {
    const root = project();
    try {
      const meta = join(root, "Assets/Characters/hero/hero.png.meta");
      writeFileSync(meta, readFileSync(meta, "utf8").replace(/\n/g, "\r\n"));
      const r = auditUnityProject(root, {});
      expect(r.textures[0]!.platforms.map((p) => p.format)).toEqual(["RGBA32", "ASTC_6x6", "automatic"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
