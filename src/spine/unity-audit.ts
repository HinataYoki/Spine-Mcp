// Read-only audit of a Unity project's Spine content before or after a spine-unity upgrade: which skeleton data the
// installed spine-unity can load, which .spine project each came from, and the user code that uses APIs 4.3 changed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { inspectUnityProject, type UnityProjectInfo } from "./unity-import.js";
import { lf, unityPath } from "../platform.js";

export interface SkeletonFile {
  /** Path inside the Unity project. */
  file: string;
  format: "json" | "binary";
  /** Spine editor version the data was exported with (from its header). */
  spineVersion: string | null;
  hash: string | null;
  /** SkeletonDataAsset(s) that use this file. */
  dataAssets: string[];
  /** The atlas next to it and whether it was exported with premultiplied alpha. */
  atlas: { file: string; pma: boolean } | null;
  /** loads: the data's major.minor matches spine-unity's; reexport: it does not (spine-unity refuses it). */
  status: "loads" | "reexport" | "unknown";
  /** A .spine project among `sources` that holds this skeleton. */
  source?: { project: string; skeleton: string };
}

export interface AtlasPageMemory {
  /** Texture file inside the Unity project. */
  texture: string;
  size: [number, number];
  /** Max Size from the import settings (default platform) and the size Unity keeps after it. */
  maxTextureSize: number | null;
  imported: [number, number];
  mipmaps: boolean;
  /** Per platform: the format (an override, or automatic) and the memory it takes, mip maps included. */
  platforms: { platform: string; format: string; MB: number | null }[];
  findings: string[];
}

export interface ApiFinding {
  file: string;
  line: number;
  code: string;
  /** What 4.3 changed and what to write instead. */
  change: string;
}

export interface UnityAuditResult {
  unityProject: UnityProjectInfo;
  spineUnity: string | null;
  skeletons: SkeletonFile[];
  /** Calls to bring the outdated ones up to date (spine_unity_import update: true per source project). */
  plan: { project: string; folder: string; format: "json" | "binary"; premultipliedAlpha: boolean; update: true }[];
  api: ApiFinding[];
  apiTotal: number;
  /** Atlas pages as Unity imports them: size after Max Size, mip maps, per-platform format and memory. */
  textures: AtlasPageMemory[];
  notes: string[];
}

/** Every file under dir (skipping Library-like folders), up to a limit. */
function walk(dir: string, accept: (f: string) => boolean, out: string[] = [], limit = 20000): string[] {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (out.length >= limit) break;
    if (e.startsWith(".") || e === "Library" || e === "Temp" || e === "node_modules") continue;
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, accept, out, limit);
    else if (accept(p)) out.push(p);
  }
  return out;
}

/** Hash and version from a binary skeleton's header: the 8 hash bytes (the JSON export writes them as base64), then a
 * varint-prefixed version string. */
export function binaryHeader(buf: Buffer): { hash: string; version: string | null } | null {
  if (buf.length < 10) return null;
  const hash = buf.subarray(0, 8).toString("base64").replace(/=+$/, "");
  let p = 8, len = 0, shift = 0;
  for (; p < Math.min(buf.length, 13); p++) {
    const b = buf[p]!;
    len |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) { p++; break; }
  }
  if (len <= 1 || p + len - 1 > buf.length) return { hash, version: null };
  const version = buf.subarray(p, p + len - 1).toString("utf8");
  return { hash, version: /^\d+\.\d+/.test(version) ? version : null };
}

/** Unity TextureImporterFormat values that matter for atlases, with bytes per pixel. */
const FORMATS: Record<number, [string, number]> = {
  1: ["Alpha8", 1], 3: ["RGB24", 3], 4: ["RGBA32", 4], 5: ["ARGB32", 4], 7: ["RGB565", 2], 10: ["DXT1", 0.5], 12: ["DXT5", 1], 13: ["RGBA4444", 2],
  24: ["BC6H", 1], 25: ["BC7", 1], 26: ["BC4", 0.5], 27: ["BC5", 1], 28: ["DXT1Crunched", 0.5], 29: ["DXT5Crunched", 1],
  34: ["ETC_RGB4", 0.5], 41: ["EAC_R", 0.5], 42: ["EAC_R_SIGNED", 0.5], 43: ["EAC_RG", 1], 44: ["EAC_RG_SIGNED", 1],
  45: ["ETC2_RGB4", 0.5], 46: ["ETC2_RGB4_PUNCHTHROUGH_ALPHA", 0.5], 47: ["ETC2_RGBA8", 1], 64: ["ETC_RGB4Crunched", 0.5], 65: ["ETC2_RGBA8Crunched", 1],
  48: ["ASTC_4x4", 1], 49: ["ASTC_5x5", 0.64], 50: ["ASTC_6x6", 16 / 36], 51: ["ASTC_8x8", 0.25], 52: ["ASTC_10x10", 0.16], 53: ["ASTC_12x12", 16 / 144],
};

/** Width and height from a PNG's IHDR chunk, or null when the file is missing or not a PNG. */
function pngSize(path: string): [number, number] | null {
  try {
    const b = readFileSync(path).subarray(0, 24);
    if (b.length < 24 || b.readUInt32BE(12) !== 0x49484452) return null; // "IHDR"
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  } catch {
    return null;
  }
}

/**
 * Block formats Unity can only use when both sides are multiples of 4 (DXT/BC, ETC, ETC2, EAC and their crunched
 * forms); any other size falls back to RGBA32 on the device while the inspector still shows the override (GOTCHAS
 * G119). ASTC has no such limit.
 */
const BLOCK4 = new Set([10, 12, 24, 25, 26, 27, 28, 29, 34, 41, 42, 43, 44, 45, 46, 47, 64, 65]);

/**
 * The size Unity gives a texture before Max Size: a Default-type (not Sprite) texture with Non-Power of 2 set to
 * ToNearest (1, spine-unity's own texture preset), ToLarger (2) or ToSmaller (3) is resampled to powers of two.
 */
export function npotSize(w: number, h: number, textureType: number | null, npotScale: number | null): [number, number] {
  if (textureType === 8 || !npotScale) return [w, h];
  const pot = (v: number) => {
    const lo = 2 ** Math.floor(Math.log2(v)), hi = lo === v ? v : lo * 2;
    return npotScale === 2 ? hi : npotScale === 3 ? lo : v - lo <= hi - v ? lo : hi;
  };
  return [pot(w), pot(h)];
}

/** Import settings of a texture from its .meta: default Max Size and mip maps, and per-platform overrides. */
function textureImport(text: string): { guid: string | null; textureType: number | null; npotScale: number | null; maxTextureSize: number | null; mipmaps: boolean; platforms: { platform: string; overridden: boolean; maxTextureSize: number; format: number }[] } {
  const meta = lf(text); // checked out by Git on Windows with CRLF
  const guid = /\nguid:\s*([0-9a-f]{32})/.exec(meta)?.[1] ?? null;
  const textureType = /\n\s*textureType:\s*(-?\d+)/.exec(meta)?.[1];
  const npot = /\n\s*nPOTScale:\s*(\d+)/.exec(meta)?.[1];
  const mipmaps = /enableMipMap:\s*1/.test(meta);
  const blocks = meta.split(/\n\s*- serializedVersion: \d+\n/).slice(1);
  const platforms = blocks.map((b) => ({
    platform: /buildTarget:\s*(\S+)/.exec(b)?.[1] ?? "?",
    overridden: /overridden:\s*1/.test(b),
    maxTextureSize: Number(/maxTextureSize:\s*(\d+)/.exec(b)?.[1] ?? 0),
    format: Number(/textureFormat:\s*(-?\d+)/.exec(b)?.[1] ?? -1),
  })).filter((p) => p.platform !== "?");
  const def = platforms.find((p) => p.platform === "DefaultTexturePlatform");
  const top = /\n\s*maxTextureSize:\s*(\d+)/.exec(meta)?.[1];
  return { guid, textureType: textureType === undefined ? null : Number(textureType), npotScale: npot === undefined ? null : Number(npot), maxTextureSize: def?.maxTextureSize || (top ? Number(top) : null), mipmaps, platforms };
}

/** GUIDs of the folders above a file, up to the Unity project's Assets folder (from their .meta files). */
function foldersAbove(unityProject: string, file: string): string[] {
  const out: string[] = [], assets = join(unityProject, "Assets");
  for (let dir = dirname(file); dir.length >= assets.length && dir.startsWith(assets); dir = dirname(dir)) {
    if (dir === assets) break;
    try { const g = /\nguid:\s*([0-9a-f]{32})/.exec(lf(readFileSync(`${dir}.meta`, "utf8")))?.[1]; if (g) out.push(g); } catch { /* no .meta */ }
  }
  return out;
}

/**
 * Atlas pages under Assets as Unity will hold them in memory. `spriteAtlases` (path, text) find pages a SpriteAtlas
 * packs a second time: a Sprite-type page inside a folder the atlas packs ends up in its packed sprites.
 */
function atlasTextures(unityProject: string, atlases: string[], spriteAtlases: [string, string][] = []): AtlasPageMemory[] {
  const out: AtlasPageMemory[] = [];
  for (const a of atlases) {
    const text = readFileSync(a, "utf8");
    // Page header: a file name line followed by "size: w,h".
    for (const m of text.matchAll(/^([^\n:]+\.(?:png|jpg|jpeg|webp))\s*\n\s*size:\s*(\d+)\s*,\s*(\d+)/gim)) {
      const tex = join(a, "..", m[1]!.trim()), aw = Number(m[2]), ah = Number(m[3]);
      // Unity imports the file, not the atlas header: a page resized after export (both differ) is sized from the PNG.
      const file = pngSize(tex);
      const [w, h] = file ?? [aw, ah];
      let meta = "";
      try { meta = readFileSync(`${tex}.meta`, "utf8"); } catch { /* not imported yet */ }
      const imp = textureImport(meta);
      // Power-of-two rescaling comes first, then Max Size.
      const [pw, ph] = npotSize(w, h, imp.textureType, imp.npotScale);
      const fit = (max: number | null): [number, number] => { if (!max || (pw <= max && ph <= max)) return [pw, ph]; const k = max / Math.max(pw, ph); return [Math.round(pw * k), Math.round(ph * k)]; };
      const imported = fit(imp.maxTextureSize);
      const mb = (dims: [number, number], bpp: number) => +((dims[0] * dims[1] * bpp * (imp.mipmaps ? 4 / 3 : 1)) / (1024 * 1024)).toFixed(2);
      const platforms: AtlasPageMemory["platforms"] = [];
      const findings: string[] = [];
      for (const p of imp.platforms.filter((x) => x.platform !== "DefaultTexturePlatform")) {
        const dims = p.overridden ? fit(p.maxTextureSize || imp.maxTextureSize) : imported;
        const f = p.overridden ? FORMATS[p.format] : undefined;
        if (f && BLOCK4.has(p.format) && (dims[0] % 4 || dims[1] % 4)) {
          platforms.push({ platform: p.platform, format: `RGBA32 (${f[0]} needs sides divisible by 4)`, MB: mb(dims, 4) });
          findings.push(`${p.platform}: the ${f[0]} override cannot compress a ${dims[0]}x${dims[1]} texture (sides not divisible by 4), so Unity ships it as RGBA32: ${mb(dims, 4)} MB instead of ${mb(dims, f[1])} MB. Pack with "Divisible by 4" (spine_export does by default), keep Max Size from changing the size, or use ASTC.`);
          continue;
        }
        platforms.push({ platform: p.platform, format: f ? f[0] : p.overridden ? `format ${p.format}` : "automatic", MB: f ? mb(dims, f[1]) : null });
      }
      if (pw !== w || ph !== h) findings.push(`Non-Power of 2 is ${["None", "ToNearest", "ToLarger", "ToSmaller"][imp.npotScale!] ?? imp.npotScale} on this Default-type texture (spine-unity's texture preset sets ToNearest), so Unity resamples the ${w}x${h} page to ${pw}x${ph}: the art is filtered (softer, or squeezed) and memory is the ${pw}x${ph} size. Export power-of-two pages, or set Non-Power of 2 to None (ASTC and ETC2 do not need powers of two).`);
      // A SpriteAtlas packs a texture listed by itself or any folder above it (V2 atlases keep only the folder in packables).
      const guids = [imp.guid, ...foldersAbove(unityProject, tex)].filter((g): g is string => !!g);
      const packedBy = guids.length ? spriteAtlases.filter(([, t]) => guids.some((g) => t.includes(g))).map(([p]) => unityPath(relative(unityProject, p))) : [];
      if (packedBy.length && imp.textureType === 8) findings.push(`Imported as a Sprite inside a folder ${packedBy.join(", ")} packs, so the whole page is packed into that SpriteAtlas a second time and nothing draws that copy. Set Texture Type to Default (as spine-unity does) or keep the Spine folder out of the atlas's packables.`);
      if (file && (file[0] !== aw || file[1] !== ah)) findings.push(`The PNG is ${file[0]}x${file[1]} but the atlas says ${aw}x${ah}: the page was resized after export. Region UVs still line up only while both sides scaled by the same factor; re-export at the size you want instead.`);
      if (imported[0] < pw || imported[1] < ph) {
        // Mobile overrides that keep the full size make the default Max Size an editor / desktop matter only.
        const mobile = imp.platforms.filter((p) => p.overridden && ["Android", "iPhone", "iOS"].includes(p.platform));
        const mobileFull = mobile.length > 0 && mobile.every((p) => (p.maxTextureSize || 0) >= Math.max(pw, ph));
        findings.push(mobileFull
          ? `Default Max Size ${imp.maxTextureSize} shrinks this ${pw}x${ph} page to ${imported[0]}x${imported[1]} on platforms without an override (the Editor's own platform, Standalone); the ${mobile.map((p) => p.platform).join(" and ")} overrides keep it at full size.`
          : `Max Size ${imp.maxTextureSize} shrinks this ${pw}x${ph} page to ${imported[0]}x${imported[1]}: the art renders blurry. Raise Max Size to ${Math.max(pw, ph) <= 2048 ? 2048 : 4096} or pack smaller pages.`);
      }
      for (const p of imp.platforms.filter((x) => x.overridden && x.maxTextureSize && (x.maxTextureSize < pw || x.maxTextureSize < ph))) findings.push(`${p.platform} override Max Size ${p.maxTextureSize} shrinks it on that platform.`);
      if (imp.mipmaps) findings.push("Mip maps are on: a third more memory, rarely useful for 2D characters at a fixed size (and they soften the art).");
      if (!meta) findings.push("No .meta yet: Unity has not imported this texture.");
      out.push({ texture: unityPath(relative(unityProject, tex)), size: [w, h], maxTextureSize: imp.maxTextureSize, imported, mipmaps: imp.mipmaps, platforms: [{ platform: "uncompressed", format: "RGBA32", MB: mb(imported, 4) }, ...platforms], findings });
    }
  }
  return out;
}

const majorMinor = (v: string | null) => (v ? /^(\d+\.\d+)/.exec(v)?.[1] ?? null : null);

/**
 * APIs spine-unity 4.3 removed or moved (spine-runtimes CHANGELOG, 4.3 C# and Unity breaking changes). Only names
 * that no longer exist in 4.3: moved members that keep their name elsewhere (Bone.WorldX now on Bone.AppliedPose)
 * cannot be told apart by name. Unity's compiler gives the definite list after the upgrade.
 */
const API_CHANGES: [RegExp, string][] = [
  [/\.SetToSetupPose\s*\(/, "SetToSetupPose() is now SetupPose()"],
  [/\.SetBonesToSetupPose\s*\(/, "SetBonesToSetupPose() is now SetupPoseBones()"],
  [/\.SetSlotsToSetupPose\s*\(/, "SetSlotsToSetupPose() is now SetupPoseSlots()"],
  [/Skeleton\.Physics\b/, "Skeleton.Physics moved to Spine.Physics (and clashes with UnityEngine.Physics: qualify both)"],
  [/\.Find(Ik|Transform|Path|Physics)Constraint\s*\(/, "SkeletonData.FindXConstraint(name) is now FindConstraint<XConstraintData>(name)"],
  [/\.(IkConstraints|TransformConstraints|PathConstraints|PhysicsConstraints)\b/, "SkeletonData's per-type constraint lists are now Constraints.OfType<XConstraintData>()"],
  [/\.GetRemappedClone\s*\(/, "GetRemappedClone() was removed: attachment.Copy() then SetRegion(...)"],
  [/ToAtlasRegionPMAClone|ToRegionAttachmentPMAClone/, "renamed to ToAtlasRegionWithNewPMATexture / ToRegionAttachmentWithNewPMATexture"],
  [/\b(HoldPrevious|holdPrevious|InterruptAlpha)\b/, "TrackEntry.HoldPrevious / InterruptAlpha were removed (the new hold system works it out)"],
  [/\bMixBlend\.|\bMixDirection\./, "MixBlend / MixDirection are no longer used: Apply takes MixFrom (Setup / Current / First), add and out"],
  [/\.(SetCurrent|GetCurrent)\s*\(/, "AnimationState.SetCurrent / GetCurrent are now SetTrack / GetTrack"],
  [/\bmaskInteraction\b/, "SkeletonRenderer.maskInteraction is now MaskInteraction"],
  [/\bBoneLocal\b/, "BoneLocal was removed: use BonePose"],
  [/\.ParentMesh\b/, "MeshAttachment.ParentMesh is now SourceMesh"],
  [/\.HasSecondColor\b/, "Slot.HasSecondColor is now Slot.AppliedPose.HasDarkColor"],
  [/\.(R2|G2|B2)\b/, "Slot dark colour fields are now AppliedPose.GetDarkColor() / SetDarkColor()"],
  [/\.(ARotation|AScaleX|AScaleY|AShearX|AShearY)\b/, "Bone applied transform moved to Bone.AppliedPose (Rotation, ScaleX, ...)"],
  [/\.SkinEntry\b[^;]*\.Name\b|\bPlaceholderName\b/, "Skin.SkinEntry.Name is now Placeholder"],
  [/\bEventData\b[^;]*\.(Int|Float|String|Volume|Balance)\b/, "EventData values moved to EventData.SetupPose"],
];

/**
 * Scans a Unity project: spine-unity's version, every skeleton data file (.json, .skel.bytes) with the Spine version
 * it was exported with and whether this spine-unity loads it, the SkeletonDataAsset and atlas that go with it, the
 * .spine source among `sources` (matched by skeleton name and data hash), and C# outside the Spine packages that uses
 * APIs 4.3 changed. Read-only.
 */
export function auditUnityProject(unityProject: string, o: { sources?: { project: string; skeletons: { name: string; hash: string | null }[] }[]; scanCode?: boolean } = {}): UnityAuditResult {
  const info = inspectUnityProject(unityProject);
  const runtime = majorMinor(info.spineUnity.version);
  const assets = join(unityProject, "Assets");
  const notes: string[] = [];
  const dataFiles = walk(assets, (f) => f.endsWith(".skel.bytes") || f.endsWith(".skel") || (f.endsWith(".json") && !f.endsWith("package.json")));
  // SkeletonDataAssets reference their data file by GUID (skeletonJSON: {fileID, guid, type}).
  const assetFiles = walk(assets, (f) => f.endsWith(".asset"));
  const guidOf = (f: string) => { try { return /guid:\s*([0-9a-f]{32})/.exec(readFileSync(`${f}.meta`, "utf8"))?.[1] ?? null; } catch { return null; } };
  const dataAssetText = assetFiles.map((f) => { try { const t = readFileSync(f, "utf8"); return /skeletonJSON:/.test(t) ? [f, t] as const : null; } catch { return null; } }).filter((x): x is readonly [string, string] => !!x);
  const skeletons: SkeletonFile[] = [];
  for (const f of dataFiles) {
    let format: "json" | "binary", version: string | null = null, hash: string | null = null;
    if (f.endsWith(".json")) {
      let head = "";
      try { head = readFileSync(f, "utf8").slice(0, 400); } catch { continue; }
      const m = /"skeleton"\s*:\s*\{([^}]*)\}/.exec(head);
      if (!m || !/"spine"\s*:/.test(m[1]!)) continue; // not Spine data
      format = "json";
      version = /"spine"\s*:\s*"([^"]+)"/.exec(m[1]!)?.[1] ?? null;
      hash = /"hash"\s*:\s*"([^"]+)"/.exec(m[1]!)?.[1] ?? null;
    } else {
      const h = binaryHeader(readFileSync(f));
      if (!h) continue;
      format = "binary";
      version = h.version;
      hash = h.hash;
    }
    const guid = guidOf(f);
    const dataAssets = guid ? dataAssetText.filter(([, t]) => t.includes(guid)).map(([a]) => unityPath(relative(unityProject, a))) : [];
    const stem = basename(f).replace(/\.skel\.bytes$|\.skel$|\.json$/, "");
    const atlasPath = [join(f, "..", `${stem}.atlas.txt`), ...walk(join(f, ".."), (x) => x.endsWith(".atlas.txt"), [], 50)].find((x) => existsSync(x));
    const atlas = atlasPath ? { file: unityPath(relative(unityProject, atlasPath)), pma: /^pma:\s*true/m.test(readFileSync(atlasPath, "utf8").slice(0, 2000)) } : null;
    const status: SkeletonFile["status"] = !runtime || !version ? "unknown" : majorMinor(version) === runtime ? "loads" : "reexport";
    const row: SkeletonFile = { file: unityPath(relative(unityProject, f)), format, spineVersion: version, hash, dataAssets, atlas, status };
    for (const src of o.sources ?? []) {
      const s = src.skeletons.find((x) => (hash && x.hash === hash) || x.name === stem);
      if (s) { row.source = { project: src.project, skeleton: s.name }; break; }
    }
    skeletons.push(row);
  }
  if (!info.spineUnity.found) notes.push("spine-unity was not found in Packages/manifest.json or under Assets: the data cannot be checked against it.");
  const outdated = skeletons.filter((s) => s.status === "reexport");
  if (outdated.length) notes.push(`${outdated.length} skeleton file(s) were exported with a Spine version spine-unity ${info.spineUnity.version} does not load (major.minor must match). Re-export them from their .spine projects with this Spine editor version.`);
  const unmatched = outdated.filter((s) => !s.source);
  if (unmatched.length && o.sources) notes.push(`No source .spine found for: ${unmatched.map((s) => s.file).join(", ")} (matched by skeleton name and data hash).`);
  const plan = outdated.filter((s) => s.source).map((s) => ({ project: s.source!.project, folder: unityPath(relative(unityProject, join(unityProject, s.file, ".."))), format: s.format, premultipliedAlpha: s.atlas?.pma ?? true, update: true as const }));
  if (plan.length) notes.push("plan: one spine_unity_import call per entry (dry-run first, then apply) replaces the data in place, keeps the GUIDs so scenes and prefabs stay linked, backs up the old files and compares every bone with spine-core.");
  const api: ApiFinding[] = [];
  if (o.scanCode !== false) {
    const code = walk(assets, (f) => extname(f) === ".cs").filter((f) => !/[/\\](Spine|spine-unity|Spine Examples)[/\\]/.test(relative(assets, f)) && !/^(Spine|spine-unity)/.test(relative(assets, f)));
    for (const f of code) {
      let lines: string[];
      try { lines = readFileSync(f, "utf8").split(/\r?\n/); } catch { continue; }
      if (!lines.some((l) => /\bSpine\b|using Spine/.test(l))) continue; // only files that use Spine
      lines.forEach((l, i) => {
        if (/^\s*\/\//.test(l)) return;
        for (const [re, change] of API_CHANGES) if (re.test(l)) { api.push({ file: unityPath(relative(unityProject, f)), line: i + 1, code: l.trim().slice(0, 160), change }); break; }
      });
    }
    if (api.length) notes.push(`${api.length} line(s) in your scripts use APIs spine-unity 4.3 changed (spine-runtimes CHANGELOG). These are name matches to look at; after the upgrade Unity's compiler gives the definite list. Components (SkeletonAnimation, SkeletonMecanim, SkeletonGraphic) are split and upgraded automatically when scenes and prefabs are opened in the editor.`);
  }
  const spriteAtlases = walk(assets, (f) => f.endsWith(".spriteatlas") || f.endsWith(".spriteatlasv2")).map((f): [string, string] => [f, readFileSync(f, "utf8")]);
  const textures = atlasTextures(unityProject, walk(assets, (f) => f.endsWith(".atlas.txt")), spriteAtlases);
  const total = textures.reduce((s2, t) => s2 + (t.platforms[0]!.MB ?? 0), 0);
  if (textures.length) notes.push(`${textures.length} atlas page(s), ${+total.toFixed(2)} MB uncompressed as imported. Compressed formats per platform come from the overrides; "automatic" follows the platform's default (Player Settings), typically ASTC on current mobile targets. spine_export with sweep compares packings.`);
  return { unityProject: info, spineUnity: info.spineUnity.version, skeletons, plan, api: api.slice(0, 200), apiTotal: api.length, textures, notes };
}
