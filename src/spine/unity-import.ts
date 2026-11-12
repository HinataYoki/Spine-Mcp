import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, normalize } from "node:path";
import type { Config, Profile } from "../config.js";
import { baseName, execFileSync, processList, readJson, removeQuiet, runFile, splitCommandLine, unityPath } from "../platform.js";
import type { SpineCli } from "./cli.js";
import { exportRuntime } from "./export.js";
import { pruneDir, UserError } from "./project.js";
import { spine } from "./runtime.js";
import { CHECK_SCRIPT, compare, IMPORT_SCRIPT, installedUnityVersions, runtimeBranch, textureFindings, unityBinary, unityQueued, type UnityAnimationParity, type UnityReport, type UnityTexture } from "./unity.js";

const run = runFile;
const SPINE_UNITY = "com.esotericsoftware.spine.spine-unity";
const DATA_FILE = /\.(json|skel\.bytes|atlas\.txt|png)$/i;
const TEMP_SCRIPTS = "Assets/SpineMcpTemp";

export interface MixSetting { from: string; to: string; duration: number }

export interface UnityImportOptions {
  project: string;
  unityProject: string;
  /** Folder inside Assets (default Assets/Spine/<name>). */
  folder?: string;
  /** Runtime format (default binary: smaller and faster to load in a game). */
  format?: "json" | "binary";
  premultipliedAlpha?: boolean;
  /** Save a prefab next to the data (default true). */
  prefab?: boolean;
  /** animation (default): SkeletonAnimation for the world; graphic: SkeletonGraphic for UI (place it under a Canvas); mecanim: SkeletonMecanim with a generated Animator controller (one clip per animation). */
  component?: "animation" | "graphic" | "mecanim";
  /** One AnimationReferenceAsset per animation in ReferenceAssets next to the data (for code and Timeline references). */
  referenceAssets?: boolean;
  /** Bones that get a following child GameObject on the prefab (BoneFollower, or BoneFollowerGraphic for UI). */
  followers?: string[];
  startingAnimation?: string;
  loop?: boolean;
  skin?: string;
  defaultMix?: number;
  mixes?: MixSetting[];
  /** Replace the data of an earlier import in the same folder (keeps GUIDs, so scenes and prefabs stay linked). */
  update?: boolean;
  apply?: boolean;
  unityVersion?: string;
  samples?: number;
  team?: NonNullable<Profile["unity"]>;
}

export interface UnityProjectInfo {
  path: string;
  editorVersion: string;
  installed: boolean;
  spineUnity: { found: boolean; version: string | null; where: string | null };
  /** A Unity editor has this project open (batch mode cannot run then); also true when that is unknown. */
  editorOpen: boolean;
  /** The process list could not be read: the project is treated as open (files copied, no batch mode). */
  editorOpenUnknown?: true;
  /** The render pipeline the project uses and the Spine shader package that goes with it (read from the files, not from Unity). */
  renderPipeline: { kind: "built-in" | "urp" | "hdrp" | "custom"; package: string | null; spineShaders: string | null; advice: string | null };
}

export interface UnityImportResult {
  mode: "dry-run" | "imported" | "copied";
  unityProject: UnityProjectInfo;
  folder: string;
  files: { name: string; bytes: number }[];
  replaced?: string[];
  backup?: string;
  imported?: { asset: string; atlases: number; materials: number; bones: number; slots: number } | null;
  applied?: { defaultMix: number; mixes: [string, string, number][] } | null;
  referenceAssets?: string[];
  prefab?: { path: string; skeletonAnimation: boolean; component?: "animation" | "graphic" | "mecanim" | "none"; followers?: string[]; mecanim?: boolean; controller?: string; clips?: number; dataAsset: string; animation: string; loop: boolean; skin: string; material?: string; rectTransform?: boolean; multipleCanvasRenderers?: boolean } | null;
  textures?: UnityTexture[];
  team?: { pages: { texture: string; slices: number; removedSlices: number }[] } | null;
  animations?: UnityAnimationParity[];
  parity?: boolean;
  errors: string[];
  warnings: string[];
  seconds: number;
  notes: string[];
}

export function teamSettings(team: UnityImportOptions["team"]) {
  const t = team?.texture ?? {}, g = team?.graphic ?? {}, platforms = t.platforms ?? [];
  const tri = (b: boolean | undefined) => (b === undefined ? -1 : b ? 1 : 0);
  return {
    textureType: t.type ?? "", spriteMode: t.spriteMode ?? "", sRGB: tri(t.sRGB), alphaIsTransparency: tri(t.alphaIsTransparency), mipmaps: tri(t.mipmaps), maxSize: t.maxSize ?? 0,
    platformTargets: platforms.map((p) => p.target), platformFormats: platforms.map((p) => p.format), platformMaxSizes: platforms.map((p) => p.maxSize ?? 0),
    spriteSlices: !!team?.spriteSlices,
    canvasGroupCompatible: tri(g.canvasGroupCompatible), pmaVertexColors: tri(g.pmaVertexColors), graphicMaterial: g.material ?? "",
  };
}

/** Reads what matters about a Unity project before touching it. */
export function inspectUnityProject(path: string, listProcesses: () => string | null = psProbe): UnityProjectInfo {
  if (!isAbsolute(path)) throw new UserError(`unityProject must be an absolute path: ${path}`);
  const versionFile = join(path, "ProjectSettings", "ProjectVersion.txt");
  if (!existsSync(join(path, "Assets")) || !existsSync(versionFile)) throw new UserError(`Not a Unity project (needs Assets/ and ProjectSettings/ProjectVersion.txt): ${path}`);
  const editorVersion = /m_EditorVersion:\s*(\S+)/.exec(readFileSync(versionFile, "utf8"))?.[1] ?? "unknown";
  return { path, editorVersion, installed: installedUnityVersions().includes(editorVersion), spineUnity: findSpineUnity(path), ...openState(unityHasProjectOpen(path, listProcesses)), renderPipeline: renderPipelineOf(path) };
}

/**
 * URP or HDRP from Packages/manifest.json and the pipeline asset in GraphicsSettings (or a quality level): those need
 * spine-unity's matching shader package for their lights, shadows and the SRP Batcher.
 */
export function renderPipelineOf(project: string): UnityProjectInfo["renderPipeline"] {
  let deps: Record<string, string> = {};
  try { deps = (readJson(join(project, "Packages", "manifest.json")) as { dependencies?: Record<string, string> }).dependencies ?? {}; } catch { /* no manifest */ }
  const read = (f: string) => { try { return readFileSync(join(project, "ProjectSettings", f), "utf8"); } catch { return ""; } };
  // A pipeline asset is referenced by guid; fileID 0 means none.
  const assigned = /m_CustomRenderPipeline:\s*\{fileID:\s*[1-9]/.test(read("GraphicsSettings.asset")) || /customRenderPipeline:\s*\{fileID:\s*[1-9]/.test(read("QualitySettings.asset"));
  const urp = deps["com.unity.render-pipelines.universal"], hdrp = deps["com.unity.render-pipelines.high-definition"];
  const kind: UnityProjectInfo["renderPipeline"]["kind"] = !assigned ? "built-in" : urp ? "urp" : hdrp ? "hdrp" : "custom";
  const shaderPkg = kind === "urp" ? "com.esotericsoftware.spine.urp-shaders" : kind === "hdrp" ? "com.esotericsoftware.spine.hdrp-shaders" : null;
  const spineShaders = shaderPkg ? deps[shaderPkg] ?? null : null;
  const advice = shaderPkg && !spineShaders
    ? kind === "urp"
      ? `The project renders with URP. spine-unity's default (unlit) materials still draw there (verified: same render as with the URP shaders), but lighting, the 2D Renderer's lights, shadows and the SRP Batcher need its URP shader package (${shaderPkg}, same version line as spine-unity) and the atlas materials on "Universal Render Pipeline/Spine/Skeleton" (or the 2D / Lit variants).`
      : `The project renders with HDRP; add spine-unity's HDRP shader package (${shaderPkg}, same version line as spine-unity). Not checked here.`
    : kind === "custom" ? "A custom render pipeline is assigned; check that Spine's shaders render with it." : null;
  return { kind, package: kind === "urp" ? urp! : kind === "hdrp" ? hdrp! : null, spineShaders: spineShaders ? `${shaderPkg} ${spineShaders}` : null, advice };
}

function findSpineUnity(project: string): UnityProjectInfo["spineUnity"] {
  const manifest = join(project, "Packages", "manifest.json");
  if (existsSync(manifest)) {
    try {
      const dep = (readJson(manifest) as { dependencies?: Record<string, string> }).dependencies?.[SPINE_UNITY];
      if (dep) {
        const local = dep.startsWith("file:") ? dep.slice(5) : null;
        const pkgPath = local ? join(isAbsolute(local) ? local : join(project, "Packages", local), "package.json") : null;
        const version = pkgPath && existsSync(pkgPath) ? (readJson(pkgPath) as { version?: string }).version ?? null : /^\d+\.\d+\.\d+/.test(dep) ? dep : null;
        return { found: true, version, where: `Packages/manifest.json (${dep.length > 80 ? `${dep.slice(0, 77)}...` : dep})` };
      }
    } catch { /* unreadable manifest: fall through to Assets */ }
  }
  // Older setups import the unitypackage into Assets/Spine (package.json sits at its root).
  const stack: [string, number][] = [[join(project, "Assets"), 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop()!;
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const j = readJson(pkg) as { name?: string; version?: string };
        if (j.name === SPINE_UNITY) return { found: true, version: j.version ?? null, where: unityPath(dir.slice(project.length + 1)) };
      } catch { /* not a package */ }
    }
    if (depth >= 3) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith(".")) stack.push([join(dir, e.name), depth + 1]);
  }
  return { found: false, version: null, where: null };
}

let psProbe = (): string | null => defaultPs();
// Unknown counts as open: batch mode against a project Unity has open fails, a copy Unity imports on focus does not.
const openState = (open: boolean | null) => (open === null ? { editorOpen: true, editorOpenUnknown: true as const } : { editorOpen: open });
export const UNITY_UNKNOWN_NOTE = "Could not read the process list, so whether Unity has this project open is unknown: treated as open (files copied for Unity to import on focus; no batch mode, prefab or mixes).";
/** Tests swap the process list (a Unity editor with the project open; null: the list could not be read). */
export function setUnityProcessProbe(fn: () => string | null) {
  psProbe = fn;
}

function defaultPs(): string | null {
  const list = processList();
  return list ? list.map((p) => p.args).join("\n") : null;
}

/**
 * A Unity editor process started with -projectPath pointing at this project (Unity Hub always passes it); null when
 * the process list could not be read. macOS: .../Unity.app/Contents/MacOS/Unity; Windows: "...\Editor\Unity.exe"
 * (quoted, its -projectpath too when it has spaces); Linux: .../Editor/Unity.
 */
export function unityHasProjectOpen(project: string, listProcesses: () => string | null = defaultPs): boolean | null {
  const out = listProcesses();
  if (out === null) return null;
  const key = (p: string) => normalize(p).replace(/[\\/]+$/, "").toLowerCase();
  const want = [project, (() => { try { return realpathSync(project); } catch { return project; } })()].map(key);
  return out.split(/\r?\n/).some((line) => {
    const name = baseName(splitCommandLine(line).exe).toLowerCase();
    if (!(/\/Unity\.app\/Contents\/MacOS\/Unity(\s|$)/.test(line) || name === "unity.exe" || (name === "unity" && /[\\/]Editor[\\/]Unity/.test(line))) || /-batchmode/i.test(line)) return false;
    const m = /-projectpath\s+(?:"([^"]+)"|(.+?)(?=\s+-\w|$))/i.exec(line);
    return !!m && want.includes(key((m[1] ?? m[2]!).trim()));
  });
}

const unityName = (f: string) => (f.endsWith(".atlas") ? `${f}.txt` : f.endsWith(".skel") ? `${f}.bytes` : f);

/**
 * Brings a .spine project into a Unity project with spine-unity: runtime export, files in an Assets folder, spine-unity's
 * importer, mix durations on the SkeletonDataAsset, a SkeletonAnimation prefab, then a read-back and a bone-by-bone
 * comparison with spine-core. Dry-run by default. While Unity has the project open only the files are copied.
 */
export function unityImport(config: Config, cli: SpineCli, o: UnityImportOptions): Promise<UnityImportResult> {
  return unityQueued(join(config.workDir, "unity"), () => unityImportNow(config, cli, o));
}

async function unityImportNow(config: Config, cli: SpineCli, o: UnityImportOptions): Promise<UnityImportResult> {
  const t0 = Date.now();
  const info = inspectUnityProject(o.unityProject, psProbe);
  const name = basename(o.project, ".spine").replace(/[^\w.-]+/g, "_");
  const folder = (o.folder ?? `Assets/Spine/${name}`).replace(/\\/g, "/").replace(/\/$/, "");
  if (!/^Assets(\/|$)/.test(folder) || folder.split("/").includes("..")) throw new UserError(`folder must be inside Assets/: ${folder}`);
  if (folder === "Assets" || folder.startsWith(TEMP_SCRIPTS)) throw new UserError(`Pick a dedicated folder such as Assets/Spine/${name}`);
  const notes: string[] = [], errors: string[] = [], warnings: string[] = [];
  if (info.editorOpenUnknown) notes.push(UNITY_UNKNOWN_NOTE);
  if (!info.spineUnity.found) throw new UserError(`spine-unity is not installed in ${o.unityProject}. Add the spine-unity ${runtimeBranch()} package (Package Manager > Add package from git URL, see esotericsoftware.com/spine-unity-download), then run again.`);
  if (info.spineUnity.version && !info.spineUnity.version.startsWith(`${runtimeBranch()}.`)) {
    throw new UserError(`spine-unity ${info.spineUnity.version} in the project, but this data is Spine ${runtimeBranch()}: runtime and editor major.minor must match. spine-mcp's Unity import runs with spine-unity ${runtimeBranch()} only; for this project export the data with spine_export editorVersion: "project" (or the matching ${info.spineUnity.version.split(".").slice(0, 2).join(".")}.x editor) and import it in Unity as usual.`);
  }
  if (!info.spineUnity.version) warnings.push("spine-unity version could not be read; it must be 4.3.x for Spine 4.3 data.");
  const version = o.unityVersion ?? info.editorVersion;
  if (!info.editorOpen && !installedUnityVersions().includes(version) && !process.env.UNITY_BIN) {
    throw new UserError(`The project uses Unity ${info.editorVersion}, which is not installed in Unity Hub (installed: ${installedUnityVersions().join(", ") || "none"}). Install it or pass unityVersion.`);
  }

  // Export first (also in dry-run: it lists the exact files).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const exported = join(config.workDir, "unity-import", stamp);
  const format = o.format ?? "binary";
  const ex = await exportRuntime(config, cli, { project: o.project, outputDir: exported, format, premultipliedAlpha: o.premultipliedAlpha ?? true });
  try {
    const files = ex.files.map((f) => ({ name: unityName(f.name), bytes: statSync(join(exported, f.name)).size }));
    const target = join(o.unityProject, folder);
    const exists = existsSync(target) && readdirSync(target).some((f) => DATA_FILE.test(f));

    // Names in mixes and settings must exist before anything is written.
    const atlasFile = ex.files.find((f) => f.name.endsWith(".atlas"))!.name;
    const loader = new spine.AtlasAttachmentLoader(new spine.TextureAtlas(readFileSync(join(exported, atlasFile), "utf8")));
    const skelFile = ex.files.find((f) => f.name.endsWith(".json") || f.name.endsWith(".skel"))!.name;
    const data = skelFile.endsWith(".json")
      ? new spine.SkeletonJson(loader).readSkeletonData(readFileSync(join(exported, skelFile), "utf8"))
      : new spine.SkeletonBinary(loader).readSkeletonData(new Uint8Array(readFileSync(join(exported, skelFile))));
    const missing = [...(o.mixes ?? []).flatMap((m) => [m.from, m.to]), ...(o.startingAnimation ? [o.startingAnimation] : [])].filter((n) => !data.findAnimation(n));
    if (missing.length) throw new UserError(`Animation(s) not found: ${[...new Set(missing)].join(", ")}. Available: ${data.animations.map((a) => a.name).join(", ")}`);
    if (o.skin && !data.findSkin(o.skin)) throw new UserError(`Skin "${o.skin}" not found. Skins: ${data.skins.map((s) => s.name).join(", ")}`);
    const noBone = (o.followers ?? []).filter((b) => !data.findBone(b));
    if (noBone.length) throw new UserError(`Follower bone(s) not found: ${noBone.join(", ")}`);
    if (ex.files.filter((f) => f.name.endsWith(".json") || f.name.endsWith(".skel")).length > 1) throw new UserError("The project has several skeletons; spine_unity_import handles one skeleton per call for now.");

    let prefabPath = o.prefab === false ? undefined : `${folder}/${name}.prefab`;
    // An update keeps the user's prefab (it may carry their own components and settings) unless prefab: true is explicit.
    if (prefabPath && exists && o.prefab !== true && existsSync(join(o.unityProject, prefabPath))) {
      notes.push(`${prefabPath} already exists and was kept (pass prefab: true to rebuild it).`);
      prefabPath = undefined;
    }
    const result: UnityImportResult = { mode: "dry-run", unityProject: info, folder, files, errors, warnings, seconds: 0, notes };
    if (info.renderPipeline.advice) notes.push(info.renderPipeline.advice);
    if (exists && !o.update) throw new UserError(`${folder} already holds Spine data. Pass update: true to replace it in place (GUIDs kept, so scenes and prefabs stay linked), or choose another folder.`);
    if (!o.apply) {
      notes.push(info.editorOpen
        ? "Unity has this project open: apply will only copy the files (Unity imports them when it gets focus). Prefab and mixes need the project closed, or set them in the Inspector."
        : `apply: true will copy ${files.length} file(s) to ${folder}${exists ? " (replacing the earlier data, backed up first)" : ""}, run Unity ${version} in batch mode to import${prefabPath ? `, save ${prefabPath}` : ""}${o.mixes?.length || o.defaultMix !== undefined ? ", set the mixes" : ""}, then verify against spine-core.`);
      result.seconds = +((Date.now() - t0) / 1000).toFixed(1);
      return result;
    }

    // Write: back up replaced data, copy the new files.
    let backup: string | undefined;
    const replaced: string[] = [];
    if (exists) {
      backup = join(config.workDir, "unity-backups", `${name}-${stamp}`);
      mkdirSync(backup, { recursive: true });
      for (const f of readdirSync(target).filter((x) => DATA_FILE.test(x))) {
        cpSync(join(target, f), join(backup, f));
        if (!files.some((n) => n.name === f)) {
          // A data file the new export no longer has (e.g. an atlas page less).
          rmSync(join(target, f), { force: true });
          rmSync(join(target, `${f}.meta`), { force: true });
        }
        replaced.push(f);
      }
      result.replaced = replaced;
      result.backup = backup;
    }
    mkdirSync(target, { recursive: true });
    for (const f of ex.files) cpSync(join(exported, f.name), join(target, unityName(f.name)));
    const rollback = () => {
      if (backup) {
        for (const f of files) if (!replaced.includes(f.name)) { rmSync(join(target, f.name), { force: true }); rmSync(join(target, `${f.name}.meta`), { force: true }); }
        for (const f of replaced) cpSync(join(backup, f), join(target, f));
      } else {
        rmSync(target, { recursive: true, force: true });
        rmSync(`${target}.meta`, { force: true });
      }
    };

    if (info.editorOpen) {
      result.mode = "copied";
      notes.push("Unity has this project open: the files were copied and Unity imports them when it gets focus (spine-unity creates the SkeletonDataAsset).");
      if (prefabPath || o.mixes?.length || o.defaultMix !== undefined) notes.push(`Not done while Unity is open: ${[prefabPath && "prefab", (o.mixes?.length || o.defaultMix !== undefined) && "mixes"].filter(Boolean).join(" and ")}. Close the project and run again with update: true, or set them in the SkeletonDataAsset Inspector${o.mixes?.length ? `: ${o.mixes.map((m) => `${m.from} -> ${m.to} ${m.duration}s`).join(", ")}` : ""}.`);
      result.seconds = +((Date.now() - t0) / 1000).toFixed(1);
      return result;
    }

    // Batch mode: our two editor scripts live in a temp folder only for this run.
    const scripts = join(o.unityProject, TEMP_SCRIPTS, "Editor");
    mkdirSync(scripts, { recursive: true });
    cpSync(CHECK_SCRIPT, join(scripts, "SpineMcpCheck.cs"));
    cpSync(IMPORT_SCRIPT, join(scripts, "SpineMcpImport.cs"));
    const settingsFile = join(config.workDir, "unity-import", `${stamp}-settings.json`);
    const reportFile = join(config.workDir, "unity-import", `${stamp}-report.json`);
    const logFile = join(config.workDir, "unity-import", `${stamp}-unity.log`);
    pruneDir(join(config.workDir, "unity-import"), 20, /-unity\.log$/);
    writeFileSync(settingsFile, JSON.stringify({
      setDefaultMix: o.defaultMix !== undefined, defaultMix: o.defaultMix ?? 0,
      setMixes: !!o.mixes, from: (o.mixes ?? []).map((m) => m.from), to: (o.mixes ?? []).map((m) => m.to), duration: (o.mixes ?? []).map((m) => m.duration),
      startingAnimation: o.startingAnimation ?? "", loop: o.loop ?? true, skin: o.skin ?? "", samples: o.samples ?? 20, component: o.component ?? "animation", referenceAssets: !!o.referenceAssets, followers: o.followers ?? [],
      ...teamSettings(o.team), straightAlpha: o.premultipliedAlpha === false,
    }));
    let report: (UnityReport & { applied: UnityImportResult["applied"]; prefab: UnityImportResult["prefab"] }) | null = null;
    try {
      try {
        await run(unityBinary(version), ["-batchmode", "-nographics", "-projectPath", o.unityProject, "-executeMethod", "SpineMcpImport.Run",
          "-spineMcpDir", folder, "-spineMcpOut", reportFile, "-spineMcpSettings", settingsFile, ...(prefabPath ? ["-spineMcpPrefab", prefabPath] : []), "-logFile", logFile],
        { timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 });
      } catch (e) {
        if (!existsSync(reportFile)) {
          const tail = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter((l) => /error|exception|licen/i.test(l)).slice(-5).join(" | ") : "";
          throw new UserError(`Unity batch mode failed (${(e as Error).message.split("\n")[0]}). ${tail}`);
        }
      }
      report = JSON.parse(readFileSync(reportFile, "utf8"));
    } catch (e) {
      rollback();
      throw e instanceof UserError ? new UserError(`${e.message} The Unity project was put back as it was.`) : e;
    } finally {
      for (const p of [join(o.unityProject, TEMP_SCRIPTS), join(o.unityProject, `${TEMP_SCRIPTS}.meta`), settingsFile, reportFile]) removeQuiet(p);
    }

    const check = compare(report!, exported, ex.files.map((f) => f.name), version, format, (Date.now() - t0) / 1000);
    result.mode = "imported";
    result.imported = check.imported;
    result.applied = report!.applied;
    result.prefab = report!.prefab;
    result.animations = check.animations;
    result.parity = check.parity;
    errors.push(...check.errors);
    warnings.push(...check.warnings);
    if (o.mixes?.length && result.applied && result.applied.mixes.length !== o.mixes.length) errors.push(`Unity reports ${result.applied.mixes.length} mixes after saving, expected ${o.mixes.length}.`);
    if (prefabPath && o.component !== "mecanim" && !result.prefab?.skeletonAnimation) errors.push(`Prefab ${prefabPath} was not saved with a SkeletonAnimation.`);
    if (prefabPath && o.component === "mecanim") {
      if (result.prefab?.component !== "mecanim" || !result.prefab.controller) errors.push(`Prefab ${prefabPath} was not saved as a SkeletonMecanim with a controller.`);
      else notes.push(`${prefabPath} is a SkeletonMecanim driven by ${result.prefab.controller} (${result.prefab.clips} clip(s), one per animation): set up states and transitions there.`);
    }
    if (o.followers?.length && prefabPath) {
      const missing = o.followers.filter((b) => !result.prefab?.followers?.includes(b));
      if (missing.length) errors.push(`Followers not on the prefab: ${missing.join(", ")}.`);
      else notes.push(`Followers on the prefab: ${o.followers.join(", ")} (child GameObjects tracking those bones: parent props or effects to them).`);
    }
    if (o.referenceAssets) {
      result.referenceAssets = (report as unknown as { referenceAssets?: string[] }).referenceAssets ?? [];
      notes.push(`${result.referenceAssets.length} AnimationReferenceAsset(s) in ${folder}/ReferenceAssets.`);
    }
    if (prefabPath && o.component === "graphic") {
      if (result.prefab?.component !== "graphic" || !result.prefab.rectTransform) errors.push(`Prefab ${prefabPath} was not saved as a SkeletonGraphic with a RectTransform.`);
      else notes.push(`${prefabPath} is a SkeletonGraphic (UI): drop it under a Canvas. Material ${result.prefab.material || "(none)"}${result.prefab.multipleCanvasRenderers ? "; Multiple CanvasRenderers is on (several atlas pages or blend modes need one CanvasRenderer each)" : ""}.`);
    }
    if (report!.textures?.length) { result.textures = report!.textures; warnings.push(...textureFindings(report!.textures, o.premultipliedAlpha ?? true)); }
    if (o.team) {
      result.team = (report as unknown as { team?: UnityImportResult["team"] }).team ?? null;
      const slices = result.team?.pages.filter((p) => p.slices || p.removedSlices) ?? [];
      notes.push(`Team settings from the profile applied to the atlas pages and the SkeletonGraphic${slices.length ? `; sprite slices: ${slices.map((p) => `${p.texture.split("/").pop()} ${p.slices} (${p.removedSlices} without a region removed)`).join(", ")}` : ""}.`);
    }
    if (errors.length && !report!.skeletons.length) rollback();
    notes.push(`spine-unity imported the ${format} export${prefabPath ? ` and ${prefabPath} was saved` : ""}; the SkeletonDataAsset keeps spine-unity's default scale (0.01). Parity compares every bone with spine-core in Spine units (tolerance ${check.tolerance.position} units, ${check.tolerance.rotationDegrees} deg).`);
    if (backup) notes.push(`Earlier data backed up to ${backup}; generated assets (SkeletonDataAsset, atlas asset, materials) were reused, so references in scenes and prefabs still work.`);
    result.seconds = +((Date.now() - t0) / 1000).toFixed(1);
    return result;
  } finally {
    removeQuiet(exported);
  }
}
