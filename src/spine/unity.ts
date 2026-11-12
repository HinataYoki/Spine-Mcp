import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import type { SpineCli } from "./cli.js";
import { exportRuntime, formatMB, type TextureFormatName } from "./export.js";
import { angleDelta } from "./measure.js";
import { mecanimFrames, type MecanimMode } from "./mix.js";
import { budgetReport } from "./budget.js";
import { fadeFolder, FADE_OFF_PERCENT, GROUP_ALPHA, type FadeError } from "./canvasgroup.js";
import { pruneDir, UserError } from "./project.js";
import { renderFrames } from "./render.js";
import { compareFrames, lossDiff } from "./visual.js";
import { spine } from "./runtime.js";
import { readJson, removeQuiet, renderFolder, runFile, unityHubEditors, unityLayout, unityPath } from "../platform.js";

const run = runFile;
// Windows: spine-runtimes nests deep enough to pass 260 characters under %LOCALAPPDATA%.
const longPaths = process.platform === "win32" ? ["-c", "core.longpaths=true"] : [];
const here = dirname(fileURLToPath(import.meta.url));
export const CHECK_SCRIPT = join(here, "..", "..", "unity", "Editor", "SpineMcpCheck.cs");
export const IMPORT_SCRIPT = join(here, "..", "..", "unity", "Editor", "SpineMcpImport.cs");
export const PERF_SCRIPTS = { player: join(here, "..", "..", "unity", "Perf", "SpineMcpPerf.cs"), build: join(here, "..", "..", "unity", "Editor", "SpineMcpPerfBuild.cs") };
// Unity Hub's default editor folder; the Windows layout is Unity's default, untested here.
export const HUB_EDITORS = unityHubEditors();
const RUNTIMES_REPO = "https://github.com/EsotericSoftware/spine-runtimes.git";

export interface UnityCheckOptions {
  project: string;
  /** Unity editor version from Unity Hub (default: the newest installed). */
  unityVersion?: string;
  /** Runtime data format handed to spine-unity (default json). */
  format?: "json" | "binary";
  /** Samples per animation (default 20, plus the end frame). */
  samples?: number;
  /** Atlas with premultiplied alpha (default true: what spine-unity's default material expects). */
  premultipliedAlpha?: boolean;
  /** Also render with SkeletonAnimation + a camera in Unity and compare with Spine's own render. */
  render?: boolean;
  /** Animations to render (default: all). */
  renderAnimations?: string[];
  /** Render rate (default 10 fps) and scale in percent (default 50). */
  renderFps?: number;
  renderScale?: number;
  /** Unity project colour space (default gamma). Linear runs in a separate cached project with spine-unity's matching texture workflow. */
  colorSpace?: "gamma" | "linear";
  /** built-in (default) or urp: a separate cached project with URP (the version shipped with the editor) and spine-unity's URP shaders. */
  renderPipeline?: "built-in" | "urp";
  /** With urp: switch the atlas materials to "Universal Render Pipeline/Spine/Skeleton" (default true), as a URP project would. */
  urpShaders?: boolean;
  /**
   * Animator transitions played through spine-unity's SkeletonMecanim (generated controller, default settings) and
   * compared frame by frame with spine-mcp's simulation of it (spine_mix_check runtime mecanim). duration: transition
   * seconds (default 0.25); at: seconds into `from` when it starts (default half of `from`).
   */
  mecanimTransitions?: { from: string; to: string; duration?: number; at?: number; trace?: string; mode?: MecanimMode; autoReset?: boolean }[];
  /** With render: draw through SkeletonAnimation (default, world) or a UI SkeletonGraphic under a Canvas. */
  renderComponent?: "animation" | "graphic";
  /**
   * With render and renderComponent graphic: the SkeletonGraphic also faded to half through a CanvasGroup, once with its
   * settings as detected without one (a fade added later) and once after spine-unity's Detect Settings below it, each
   * against the right blend of the full render over the background.
   */
  canvasGroup?: boolean;
  /**
   * Layered playback: one looping animation per track (track 0 first, e.g. [idle, blink, gaze]) through
   * SkeletonAnimation's AnimationState, stepped for `tracksSeconds` (default 10) at 30 fps and compared bone by bone
   * with spine-core's AnimationState playing the same tracks (physics off on both, or on with tracksPhysics).
   */
  tracks?: string[];
  tracksSeconds?: number;
  tracksPhysics?: boolean;
  /** Draw calls as spine-unity's SkeletonRenderer builds them (submesh instructions), per animation (renderAnimations or all), next to spine_budget's estimate. */
  batching?: boolean;
  /**
   * Device texture compression: the atlas pages imported for Android as RGBA32 and then in each of these formats, in a
   * separate cached Unity project on the Android build target; per format the pages read back from the GPU and frames
   * rendered at 100% (renderAnimations, default the first two), against RGBA32 from the same run.
   */
  compression?: CompressionFormat[];
  spineUnity?: string;
}

export type CompressionFormat = Exclude<TextureFormatName, "rgba32">;
// TextureImporterFormat names, which are also the TextureFormat names Unity loads.
const UNITY_FORMAT: Record<CompressionFormat, string> = { etc2: "ETC2_RGBA8", astc4x4: "ASTC_4x4", astc5x5: "ASTC_5x5", astc6x6: "ASTC_6x6", astc8x8: "ASTC_8x8", astc10x10: "ASTC_10x10", astc12x12: "ASTC_12x12" };

export interface UnityCompression {
  format: CompressionFormat;
  unityFormat: string;
  /** The format Unity loaded per page (read back after the import): the override took effect when it equals unityFormat. */
  loaded: string[];
  applied: boolean;
  /** GPU support for the loaded format on this machine (unsupported formats are decompressed by Unity, still lossy). */
  supported: boolean;
  /** Texture memory of the pages in this format (RGBA32 in the baseline row). */
  memoryMB: number;
  /** The pages as the GPU samples them, against RGBA32 (premultiplied colour and alpha, drawn pixels). */
  texture: { psnr: number | null; visiblePercent: number; maxDelta: number };
  /** Frames at 100% against RGBA32 frames (colour, pixels off the background). */
  render: { psnr: number | null; visiblePercent: number; maxDelta: number; frames: number; worst: { animation: string; frame: number } | null };
}

export interface UnityBatching {
  animation: string;
  /** Most submeshes (draw calls before Unity's own batching) in any sampled frame, and when. */
  drawCalls: number;
  at: number;
  /** spine_budget's estimate for spine-unity's default materials (drawCallsPagesOnly: texture page runs in draw order). */
  estimate: number | null;
  /** The worst frame's submeshes: material and the draw order slots each covers. */
  submeshes: { material: string; from: string; to: string; slots: number; clipping: boolean }[];
}

export interface UnityMecanimTransition {
  from: string;
  to: string;
  duration: number;
  at: number;
  mode: MecanimMode;
  autoReset: boolean;
  frames: number;
  /** Largest bone difference from spine-mcp's simulation of SkeletonMecanim, in Spine units. */
  maxPositionError: number;
  /** The worst single-frame jump Unity showed after the transition started, when it stands out (a pop). */
  pop: { bone: string; step: number; time: number; afterTransition: boolean } | null;
  /** With trace: that bone's world position per frame from the transition start, in Unity and in the simulation. */
  trace?: { bone: string; fps: number; unity: [number, number][]; simulation: [number, number][] };
}

export interface UnityVisual {
  animation: string;
  frames: number;
  minIoU: number;
  meanIoU: number;
  meanColorDiff: number;
  maxColorDiff: number;
  worstFrame: number;
  ok: boolean;
}

export interface UnityAnimationParity {
  name: string;
  duration: number;
  maxPositionError: number;
  maxRotationError: number;
  ok: boolean;
}

export interface UnityCheckResult {
  unity: { version: string; spineUnity: string | null; spineUnityCommit?: string; editor: string; colorSpace?: string; workflow?: string | null; renderPipeline?: string };
  /** Texture import and material settings spine-unity applied (sRGB, straight alpha). */
  textures?: UnityReport["textures"];
  imported: { asset: string; atlases: number; materials: number; bones: number; slots: number } | null;
  animations: UnityAnimationParity[];
  parity: boolean;
  tolerance: { position: number; rotationDegrees: number };
  errors: string[];
  warnings: string[];
  seconds: number;
  notes: string[];
  /** With render: Unity's camera render against Spine's render, per animation. */
  visual?: UnityVisual[];
  /** With render: the worst frame as Spine | Unity | difference. */
  visualPng?: Buffer;
  /**
   * With canvasGroup, per animation (worst frame): asIs and detected against each part faded through the
   * SkeletonGraphic's colour (the right per-part fade), overlap = that fade against the character faded as one layer.
   */
  canvasGroup?: { alpha: number; settings: { asIs: string; detected: string }; animations: { animation: string; asIs: FadeError; detected: FadeError; overlap: FadeError }[] };
  /** With compression: per format, against RGBA32 on the same Android import. */
  compression?: { baselineMB: number; scale: number; formats: UnityCompression[] };
  /** With compression: the worst format's worst frame as RGBA32 | format | difference x4. */
  compressionPng?: Buffer;
  mecanim?: UnityMecanimTransition[];
  batching?: UnityBatching[];
  tracks?: {
    animations: string[]; seconds: number; frames: number; maxPositionError: number; maxRotationError: number; worst: { bone: string; time: number } | null; ok: boolean; overrides: { track: number; hides: number; timelines: number }[];
    /**
     * With tracksPhysics: the bones the simulation moves (directly or through constraints), compared apart.
     * Both runtimes step physics at a fixed rate; float32 (spine-csharp) and float64 (spine-core) can round a frame to a
     * different number of steps, so they part for a while and come back: settledPositionError is the last quarter.
     * startup: how far the simulation throws these bones when the skeleton appears (SkeletonRenderer.Initialize starts
     * physics at the setup pose, the first animated pose arrives as a jump), against a physics reset at that pose.
     */
    physics?: {
      bones: string[]; maxPositionError: number; settledPositionError: number; maxRotationError: number; worst: { bone: string; time: number } | null; finite: boolean; ok: boolean;
      startup: { maxOffset: number; bone: string | null; settlesAt: number | null; unityMaxOffset: number };
    };
  };
}

export interface UnityTexture {
  material: string; shader: string; straightAlphaInput: number | null; sRGB: boolean | null; alphaIsTransparency: boolean | null;
  texture?: string; source?: [number, number]; maxTextureSize?: number; mipmaps?: boolean; filter?: string; compression?: string;
  platforms?: Record<string, { overridden: boolean; maxTextureSize: number; format: string }>;
}

/**
 * What the texture import settings will do to the atlas pages: shrunk below their size (default or a platform
 * override), mip maps, a workflow that does not match how the atlas was exported (PMA or straight alpha).
 */
export function textureFindings(textures: UnityTexture[], pma: boolean): string[] {
  const out: string[] = [];
  for (const t of textures) {
    const page = t.texture?.split("/").pop() ?? t.material;
    const side = t.source ? Math.max(...t.source) : 0;
    if (side && t.maxTextureSize && t.maxTextureSize < side) out.push(`${page}: ${t.source!.join("x")} imported with Max Size ${t.maxTextureSize}, so Unity shrinks it and the atlas looks blurry; raise Max Size or pack smaller pages.`);
    for (const [platform, ps] of Object.entries(t.platforms ?? {})) if (ps.overridden && side && ps.maxTextureSize < side) out.push(`${page}: the ${platform} override caps it at ${ps.maxTextureSize} (page is ${side}); that platform gets a blurry atlas.`);
    if (t.mipmaps) out.push(`${page}: mip maps on; spine-unity imports atlas pages without them (they blur and bleed at small sizes unless the skeleton is shown far away).`);
    // spine-unity's own test (SkeletonGraphicUtility): PMA textures import without sRGB and without Alpha Is Transparency.
    if (t.sRGB !== null && t.alphaIsTransparency !== null) {
      const importedPma = !t.alphaIsTransparency && !t.sRGB;
      if (pma && t.alphaIsTransparency) out.push(`${page}: exported with premultiplied alpha but imported with Alpha Is Transparency on, which darkens or fringes edges; use spine-unity's PMA texture preset.`);
      else if (!pma && importedPma) out.push(`${page}: exported with straight alpha but imported like a PMA texture (no sRGB, no Alpha Is Transparency); use spine-unity's straight-alpha preset.`);
    }
  }
  return out;
}

/**
 * Per format: whether Unity loaded it, its memory, and how far its pages (texture level) and frames (render level) are
 * from RGBA32 in the same run. The image is the worst format's worst frame.
 */
export function compressionReport(raw: NonNullable<UnityReport["compression"]>, formats: CompressionFormat[], dir: string, animations: string[]): { report: NonNullable<UnityCheckResult["compression"]>; png?: Buffer } {
  const base = raw.find((r) => r.format === "RGBA32");
  if (!base) throw new UserError("compression: Unity reported no RGBA32 baseline");
  const area = base.pages.reduce((a, p) => a + p.size[0] * p.size[1], 0);
  const pngs = (sub: string) => existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).filter((f) => f.endsWith(".png")).sort() : [];
  const pool = (pairs: [string, string][], background?: [number, number, number]) => {
    let pixels = 0, sum = 0, visible = 0, maxDelta = 0, worst: { mse: number; at: number; png: () => Buffer } | null = null;
    pairs.forEach(([a, b], i) => {
      const d = lossDiff(a, b, background);
      pixels += d.pixels; sum += d.mse * d.pixels; visible += (d.visiblePercent / 100) * d.pixels; maxDelta = Math.max(maxDelta, d.maxDelta);
      if (!worst || d.mse > worst.mse) worst = { mse: d.mse, at: i, png: d.diffPng };
    });
    const mse = pixels ? sum / pixels : 0;
    return { psnr: mse ? +(10 * Math.log10((255 * 255) / mse)).toFixed(2) : null, visiblePercent: pixels ? +(100 * visible / pixels).toFixed(2) : 0, maxDelta, worst: worst as { mse: number; at: number; png: () => Buffer } | null };
  };
  let worstFrame: { mse: number; png: () => Buffer } | null = null;
  const rows: UnityCompression[] = formats.map((format) => {
    const unityFormat = UNITY_FORMAT[format], got = raw.find((r) => r.format === unityFormat);
    const loaded = got?.pages.map((p) => p.loaded) ?? [];
    const pagePairs = pngs(join("RGBA32", "~pages")).map((f): [string, string] => [join(dir, "RGBA32", "~pages", f), join(dir, unityFormat, "~pages", f)]).filter(([, b]) => existsSync(b));
    const frames: { animation: string; frame: number; pair: [string, string] }[] = [];
    for (const a of animations) for (const [k, f] of pngs(join("RGBA32", renderFolder(a))).entries()) {
      const b = join(dir, unityFormat, renderFolder(a), f);
      if (existsSync(b)) frames.push({ animation: a, frame: k, pair: [join(dir, "RGBA32", renderFolder(a), f), b] });
    }
    const tex = pool(pagePairs), ren = pool(frames.map((f) => f.pair), [127, 127, 127]);
    if (ren.worst && (!worstFrame || ren.worst.mse > worstFrame.mse)) worstFrame = ren.worst;
    return {
      format, unityFormat, loaded, applied: loaded.length > 0 && loaded.every((l) => l === unityFormat), supported: !!got?.pages.every((p) => p.supported),
      memoryMB: formatMB(area, format),
      texture: { psnr: tex.psnr, visiblePercent: tex.visiblePercent, maxDelta: tex.maxDelta },
      render: { psnr: ren.psnr, visiblePercent: ren.visiblePercent, maxDelta: ren.maxDelta, frames: frames.length, worst: ren.worst ? { animation: frames[ren.worst.at]!.animation, frame: frames[ren.worst.at]!.frame } : null },
    };
  });
  const wf = worstFrame as { mse: number; png: () => Buffer } | null;
  return { report: { baselineMB: formatMB(area, "rgba32"), scale: 100, formats: rows }, png: wf ? wf.png() : undefined };
}

export interface UnityReport {
  canvasGroup?: { asIs: string; detected: string };
  textures?: UnityTexture[];
  colorSpace?: string;
  workflow?: string | null;
  unityVersion: string;
  spineUnityVersion: string | null;
  mecanim?: { from: string; to: string; frames: number[][] }[];
  batching?: Omit<UnityBatching, "estimate">[];
  tracks?: number[][];
  compression?: { format: string; pages: { texture: string; loaded: string; supported: boolean; size: [number, number] }[] }[];
  skeletons: { asset: string; loaded: boolean; atlases: number; materials: number; bones?: string[]; slots?: number; animations?: { name: string; duration: number; times: number[]; frames: number[][] }[] }[];
  errors: string[];
  warnings: string[];
}

/** Unity editors installed through Unity Hub, newest first. */
export function installedUnityVersions(): string[] {
  if (!existsSync(HUB_EDITORS)) return [];
  const key = (v: string) => v.split(/[.a-z]/i).filter(Boolean).map(Number);
  return readdirSync(HUB_EDITORS).filter((v) => existsSync(unityBinary(v))).sort((a, b) => {
    const x = key(a), y = key(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
}

export const unityBinary = (version: string) => process.env.UNITY_BIN ?? unityLayout(join(HUB_EDITORS, version)).exe;

/** spine-csharp + spine-unity sources for the runtime branch that matches spine-core (sparse, shallow clone, cached). */
export async function ensureRuntimes(root: string, branch: string, commit?: string): Promise<string> {
  const override = process.env.SPINE_UNITY_RUNTIMES;
  if (override && (!commit || (await gitHead(override)) === commit.toLowerCase())) return override;
  if (commit) return ensureRuntimesAt(root, branch, commit);
  const dir = join(root, `spine-runtimes-${branch}`);
  if (existsSync(join(dir, "spine-unity", "Assets", "Spine", "package.json"))) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  try {
    await run("git", [...longPaths, "clone", "-q", "--depth", "1", "--filter=blob:none", "--sparse", "-b", branch, RUNTIMES_REPO, dir], { timeout: 600_000 });
    await run("git", [...longPaths, "-C", dir, "sparse-checkout", "set", "spine-csharp/src", "spine-unity/Assets/Spine"], { timeout: 600_000 });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new UserError(`Could not fetch spine-unity ${branch} from GitHub (${(e as Error).message.split("\n")[0]}). Set SPINE_UNITY_RUNTIMES to a local spine-runtimes checkout.`);
  }
  return dir;
}

export async function gitHead(dir: string): Promise<string | null> {
  try {
    return (await run("git", ["-C", dir, "rev-parse", "HEAD"], { timeout: 30_000 })).stdout.trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

async function ensureRuntimesAt(root: string, branch: string, commit: string): Promise<string> {
  const dir = join(root, `spine-runtimes-${commit.slice(0, 12)}`);
  if (existsSync(join(dir, "spine-unity", "Assets", "Spine", "package.json"))) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  try {
    await run("git", [...longPaths, "clone", "-q", "--depth", "1", "--filter=blob:none", "--sparse", "--no-checkout", "-b", branch, RUNTIMES_REPO, dir], { timeout: 600_000 });
    await run("git", [...longPaths, "-C", dir, "fetch", "-q", "--depth", "1", "origin", commit], { timeout: 600_000 });
    await run("git", [...longPaths, "-C", dir, "sparse-checkout", "set", "spine-csharp/src", "spine-unity/Assets/Spine"], { timeout: 600_000 });
    await run("git", [...longPaths, "-C", dir, "checkout", "-q", commit], { timeout: 600_000 });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new UserError(`Could not fetch spine-runtimes commit ${commit} (${(e as Error).message.split("\n")[0]}). Set SPINE_UNITY_RUNTIMES to a local checkout of it.`);
  }
  return dir;
}

export interface PinnedRuntime { commit: string; from: string; csharpCommit: string | null }

export function pinnedRuntime(spineUnity: string): PinnedRuntime {
  if (/^[0-9a-f]{40}$/i.test(spineUnity)) return { commit: spineUnity.toLowerCase(), from: "commit", csharpCommit: null };
  if (!isAbsolute(spineUnity)) throw new UserError(`spineUnity must be a 40-character commit or an absolute Unity project path: ${spineUnity}`);
  const lockFile = join(spineUnity, "Packages", "packages-lock.json");
  if (!existsSync(lockFile)) throw new UserError(`No Packages/packages-lock.json in ${spineUnity}.`);
  const deps = (readJson(lockFile) as { dependencies?: Record<string, { source?: string; hash?: string; version?: string }> }).dependencies ?? {};
  const unityPkg = deps["com.esotericsoftware.spine.spine-unity"], csharp = deps["com.esotericsoftware.spine.spine-csharp"];
  if (!unityPkg) throw new UserError(`${lockFile} has no com.esotericsoftware.spine.spine-unity.`);
  if (unityPkg.source !== "git" || !unityPkg.hash) throw new UserError(`spine-unity in ${spineUnity} comes from "${unityPkg.source ?? "?"}" (${unityPkg.version ?? "?"}), not a git commit: point SPINE_UNITY_RUNTIMES at a spine-runtimes checkout of the same version.`);
  return { commit: unityPkg.hash.toLowerCase(), from: lockFile, csharpCommit: csharp?.hash?.toLowerCase() ?? null };
}

/** A throwaway Unity project per editor version with spine-csharp and spine-unity as local packages. */
export function ensureProject(root: string, version: string, runtimes: string, colorSpace: "gamma" | "linear" = "gamma", urp = false, android = false, perf = false, pin = ""): string {
  // Linear, URP, the Android build target and the perf player get their own projects: a crashed run can never leave
  // the shared one changed.
  const project = join(root, "projects", `${version}${colorSpace === "linear" ? "-linear" : ""}${urp ? "-urp" : ""}${android ? "-android" : ""}${perf ? "-perf" : ""}${pin ? `-${pin.slice(0, 8)}` : ""}`);
  mkdirSync(join(project, "Assets", "Editor"), { recursive: true });
  mkdirSync(join(project, "Packages"), { recursive: true });
  const manifest = {
    dependencies: {
      "com.esotericsoftware.spine.spine-csharp": `file:${unityPath(join(runtimes, "spine-csharp", "src"))}`,
      "com.esotericsoftware.spine.spine-unity": `file:${unityPath(join(runtimes, "spine-unity", "Assets", "Spine"))}`,
      "com.unity.ugui": version.startsWith("20") ? "1.0.0" : "2.0.0",
      "com.unity.2d.sprite": "1.0.0",
      ...Object.fromEntries(["animation", "physics", "physics2d", "imgui", "jsonserialize", "uielements"].map((m) => [`com.unity.modules.${m}`, "1.0.0"])),
      ...(urp ? { "com.unity.render-pipelines.universal": urpVersion(version), "com.esotericsoftware.spine.urp-shaders": `file:${unityPath(join(runtimes, "spine-unity", "Modules", "com.esotericsoftware.spine.urp-shaders"))}` } : {}),
    },
  };
  const manifestPath = join(project, "Packages", "manifest.json");
  const current = existsSync(manifestPath) ? readJson<{ dependencies?: Record<string, string> }>(manifestPath) : {};
  current.dependencies = { ...current.dependencies, ...manifest.dependencies };
  writeFileSync(manifestPath, JSON.stringify(current, null, 2));
  cpSync(CHECK_SCRIPT, join(project, "Assets", "Editor", "SpineMcpCheck.cs"));
  if (perf) {
    mkdirSync(join(project, "Assets", "SpineMcpPerf"), { recursive: true });
    cpSync(PERF_SCRIPTS.build, join(project, "Assets", "Editor", "SpineMcpPerfBuild.cs"));
    cpSync(PERF_SCRIPTS.player, join(project, "Assets", "SpineMcpPerf", "SpineMcpPerf.cs"));
  }
  return project;
}

/** Where Unity Hub installs an editor's Android Build Support module. */
function androidModule(version: string): string {
  const editor = join(HUB_EDITORS, version);
  return process.platform === "darwin" ? join(editor, "PlaybackEngines", "AndroidPlayer") : join(editor, "Editor", "Data", "PlaybackEngines", "AndroidPlayer");
}

/** The URP version an editor ships with (Unity 6 bundles it as a built-in package). */
function urpVersion(version: string): string {
  const pkg = join(unityLayout(join(HUB_EDITORS, version)).resources, "PackageManager", "BuiltInPackages", "com.unity.render-pipelines.universal", "package.json");
  if (!existsSync(pkg)) throw new UserError(`Unity ${version} has no built-in URP package; use a Unity 6 editor for the URP check.`);
  return readJson<{ version: string }>(pkg).version;
}

/** spine-unity's URP shaders module, added to the sparse runtimes checkout when first needed. */
async function ensureUrpShaders(runtimes: string): Promise<void> {
  if (existsSync(join(runtimes, "spine-unity", "Modules", "com.esotericsoftware.spine.urp-shaders", "package.json"))) return;
  if (process.env.SPINE_UNITY_RUNTIMES) throw new UserError("SPINE_UNITY_RUNTIMES has no spine-unity/Modules/com.esotericsoftware.spine.urp-shaders");
  await run("git", [...longPaths, "-C", runtimes, "sparse-checkout", "add", "spine-unity/Modules/com.esotericsoftware.spine.urp-shaders"], { timeout: 600_000 });
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Unity runs one batch job at a time (shared by the check and the import): in this process through the queue, across
 * processes on the same work folder (a second MCP server, parallel test workers) through a lock file there. Two batch
 * jobs on one cached project break its script compilation (Library/Bee: CS2011, response file not opened).
 */
export function unityQueued<T>(lockDir: string, fn: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => undefined).then(() => withBatchLock(lockDir, fn));
  queue = next;
  return next;
}

const LOCK_WAIT_MS = 3_600_000;
// The holder rewrites its lock every HEARTBEAT_MS; one not rewritten for STALE_MS belongs to nobody (a hung or killed
// holder, a reused pid, a file whose content was never written).
const HEARTBEAT_MS = 30_000, STALE_MS = 5 * 60_000;

type LockOwner = { pid?: number; at?: number; token?: string };

function readLock(file: string): { owner: LockOwner | null; mtime: number } | null {
  try {
    const mtime = statSync(file).mtimeMs;
    let owner: LockOwner | null = null;
    try { owner = JSON.parse(readFileSync(file, "utf8")) as LockOwner; } catch { owner = null; }
    return { owner, mtime };
  } catch {
    return null; // released meanwhile
  }
}

export async function withBatchLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "batch.lock");
  const token = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const content = () => JSON.stringify({ pid: process.pid, at: Date.now(), token });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(file, content(), { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (takeOver(dir, file)) continue;
      if (Date.now() > deadline) throw new UserError(`Another spine-mcp Unity job has held ${file} for an hour. Delete the file if no Unity batch job is running.`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const mine = () => readLock(file)?.owner?.token === token;
  const beat = setInterval(() => { try { if (mine()) writeFileSync(file, content()); } catch { /* next beat */ } }, HEARTBEAT_MS);
  beat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    // Only our own lock: one taken over meanwhile belongs to its new holder.
    if (mine()) removeQuiet(file);
  }
}

/**
 * Removes an abandoned lock, one process at a time: the takeover runs under a second lock file and deletes the lock
 * only if it still holds the owner judged abandoned (another waiter may have replaced it meanwhile).
 */
function takeOver(dir: string, file: string): boolean {
  const seen = readLock(file);
  if (!seen || !abandoned(seen)) return !seen;
  const guard = join(dir, "batch.lock.takeover");
  try {
    writeFileSync(guard, String(process.pid), { flag: "wx" });
  } catch {
    // Another waiter is taking over; a guard left by a killed one expires.
    const g = readLock(guard);
    if (g && Date.now() - g.mtime > STALE_MS) removeQuiet(guard);
    return false;
  }
  try {
    const now = readLock(file);
    if (now && now.mtime === seen.mtime && JSON.stringify(now.owner) === JSON.stringify(seen.owner)) removeQuiet(file);
    return true;
  } finally {
    removeQuiet(guard);
  }
}

/** The lock's owner is gone (crashed or killed), it has not been rewritten for STALE_MS, or it is this process's own leftover. */
function abandoned(lock: { owner: LockOwner | null; mtime: number }): boolean {
  const o = lock.owner, at = Math.max(o?.at ?? 0, lock.mtime);
  if (Date.now() - at > STALE_MS) return true;
  // Unreadable content younger than that is being written right now.
  if (!o?.pid) return false;
  // This process holds no lock outside the queue: one with its pid is a leftover (a release that failed).
  if (o.pid === process.pid) return true;
  try {
    process.kill(o.pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Exports the project's runtime files, imports them with spine-unity's own importer in a headless (batch mode) Unity,
 * samples every animation there and compares each bone's world position and rotation with spine-core.
 */
export function unityCheck(config: Config, cli: SpineCli, o: UnityCheckOptions): Promise<UnityCheckResult> {
  return unityQueued(join(config.workDir, "unity"), () => unityCheckNow(config, cli, o));
}

async function unityCheckNow(config: Config, cli: SpineCli, o: UnityCheckOptions): Promise<UnityCheckResult> {
  const t0 = Date.now();
  const versions = installedUnityVersions();
  const version = o.unityVersion ?? versions[0];
  if (!version || (!process.env.UNITY_BIN && !versions.includes(version))) {
    throw new UserError(versions.length ? `Unity ${o.unityVersion} is not installed. Installed: ${versions.join(", ")}` : `No Unity editor found in Unity Hub (${HUB_EDITORS}). Set UNITY_BIN to a Unity binary.`);
  }
  if (o.canvasGroup && (!o.render || o.renderComponent !== "graphic")) throw new UserError("canvasGroup needs render: true and renderComponent: \"graphic\".");
  const samples = o.samples ?? 20;
  const root = join(config.workDir, "unity");
  const branch = runtimeBranch();
  const pin = o.spineUnity ? pinnedRuntime(o.spineUnity) : null;
  const runtimes = await ensureRuntimes(root, branch, pin?.commit);
  const ranAt = pin ? await gitHead(runtimes) : null;
  if (pin && ranAt && ranAt !== pin.commit) throw new UserError(`spine-unity was asked at ${pin.commit.slice(0, 12)} but ${runtimes} is at ${ranAt.slice(0, 12)}.`);
  const pinnedVersion = pin ? readJson<{ version?: string }>(join(runtimes, "spine-unity", "Assets", "Spine", "package.json")).version ?? "?" : null;
  if (pinnedVersion && !pinnedVersion.startsWith(`${branch}.`)) throw new UserError(`spine-unity ${pinnedVersion} at ${pin!.commit.slice(0, 12)}, but this data is Spine ${branch}: runtime and editor major.minor must match.`);
  const linear = o.colorSpace === "linear", urp = o.renderPipeline === "urp", android = !!o.compression?.length;
  if (urp) await ensureUrpShaders(runtimes);
  if (android && !process.env.UNITY_BIN && !existsSync(androidModule(version))) throw new UserError(`compression needs Unity ${version}'s Android Build Support module (Unity Hub > Installs > Add modules).`);
  const project = ensureProject(root, version, runtimes, linear ? "linear" : "gamma", urp, android, false, pin?.commit);

  // Runtime files named the way spine-unity expects (.atlas.txt, .skel.bytes).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const exported = join(root, "exports", stamp);
  const name = basename(o.project, ".spine").replace(/[^\w.-]+/g, "_");
  const format = o.format ?? "json";
  // spine-unity's default material expects premultiplied-alpha textures (straight alpha shows bright edges).
  // Linear colour space needs straight alpha (spine-unity docs); Gamma uses spine-unity's default PMA material.
  const pma = o.premultipliedAlpha ?? !linear;
  const ex = await exportRuntime(config, cli, { project: o.project, outputDir: exported, format, premultipliedAlpha: pma });
  const rel = `Assets/SpineMcp/${name}-${stamp}`;
  const target = join(project, rel);
  mkdirSync(target, { recursive: true });
  for (const f of ex.files) {
    const out = f.name.endsWith(".atlas") ? `${f.name}.txt` : f.name.endsWith(".skel") ? `${f.name}.bytes` : f.name;
    cpSync(join(exported, f.name), join(target, out));
  }

  const report = join(root, `report-${stamp}.json`), log = join(root, `unity-${stamp}.log`);
  pruneDir(root, 20, /^unity-.*\.log$/); // one Unity log per check: keep the recent ones for debugging
  // Transitions for SkeletonMecanim: timing from the skeleton (the clips stop at their end unless looped, so the window
  // stays inside both animations).
  const runtime = o.mecanimTransitions?.length ? runtimeData(exported, ex.files.map((f) => f.name)) : null;
  const mecanim = (o.mecanimTransitions ?? []).map((m) => {
    const dur = (n: string) => { const a = runtime!.findAnimation(n); if (!a) throw new UserError(`mecanimTransitions: animation "${n}" not found`); return a.duration; };
    const df = dur(m.from), dt = dur(m.to), duration = m.duration ?? 0.25, at = m.at ?? +(df / 2).toFixed(4);
    return { from: m.from, to: m.to, duration, at, seconds: +(at + duration + Math.max(0.1, Math.min(0.3, dt - duration - 0.05))).toFixed(4), mode: m.mode ?? "mixNext", autoReset: m.autoReset !== false, ...(m.trace ? { trace: m.trace } : {}) };
  });
  const renderDir = join(root, `renders-${stamp}`);
  const renderFps = o.renderFps ?? 10, renderScale = o.renderScale ?? 50;
  const GREY = 127;
  const compressionDir = join(root, `compression-${stamp}`), compressionFps = o.renderFps ?? 10;
  // At 100% every texel is a pixel: compression blocks show as they would on a phone held close.
  const compressionAnims = !android ? [] : o.renderAnimations?.length ? o.renderAnimations
    : runtimeData(exported, ex.files.map((f) => f.name)).animations.filter((a) => a.duration > 0).slice(0, 2).map((a) => a.name);
  const compressionArgs = android ? ["-buildTarget", "Android", "-spineMcpCompression", o.compression!.map((f) => UNITY_FORMAT[f]).join("|"), "-spineMcpCompressionDir", compressionDir, "-spineMcpCompressionFps", String(compressionFps), "-spineMcpCompressionAnimations", compressionAnims.join("|")] : [];
  const renderArgs = o.render ? [...(o.renderComponent === "graphic" ? ["-spineMcpRenderGraphic", "1"] : []), ...(o.canvasGroup ? ["-spineMcpCanvasGroup", String(GROUP_ALPHA)] : []), "-spineMcpRenderGrey", (GREY / 255).toFixed(4), "-spineMcpRenderDir", renderDir, "-spineMcpRenderFps", String(renderFps), "-spineMcpRenderScale", String(renderScale), ...(o.renderAnimations?.length ? ["-spineMcpRenderAnimations", o.renderAnimations.join("|")] : [])] : [];
  try {
    try {
      // Rendering needs a real graphics device: -nographics gives Unity a null device (blank frames).
      await run(unityBinary(version), ["-batchmode", ...(o.render || android ? [] : ["-nographics"]), ...compressionArgs, "-projectPath", project, "-executeMethod", "SpineMcpCheck.Run",
        "-spineMcpDir", rel, "-spineMcpOut", report, "-spineMcpSamples", String(samples), ...renderArgs,
        ...(linear ? ["-spineMcpColorSpace", "linear"] : []), "-spineMcpWorkflow", pma ? "pma" : "straight",
        ...(urp ? ["-spineMcpUrp", "1", ...(o.urpShaders !== false ? ["-spineMcpUrpShaders", "1"] : [])] : []),
        ...(o.tracks?.length ? ["-spineMcpTracks", o.tracks.join("|"), "-spineMcpTracksSeconds", String(o.tracksSeconds ?? 10), "-spineMcpTracksFps", "30", ...(o.tracksPhysics ? ["-spineMcpTracksPhysics", "1"] : [])] : []),
        ...(o.batching ? ["-spineMcpBatching", o.renderAnimations?.length ? o.renderAnimations.join("|") : "*", "-spineMcpBatchingFps", "10"] : []),
        ...(mecanim.length ? ["-spineMcpMecanim", mecanim.map((m) => [m.from, m.to, m.duration, m.at, m.seconds, m.mode[0]!.toUpperCase() + m.mode.slice(1), m.autoReset ? 1 : 0].join(">")).join("|"), "-spineMcpMecanimFps", String(MECANIM_FPS)] : []), "-logFile", log], { timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      if (!existsSync(report)) {
        const tail = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => /error|exception|licen/i.test(l)).slice(-5).join(" | ") : "";
        throw new UserError(`Unity batch mode failed (${(e as Error).message.split("\n")[0]}). ${tail}`);
      }
    }
    const r = JSON.parse(readFileSync(report, "utf8")) as UnityReport;
    const result = compare(r, exported, ex.files.map((f) => f.name), version, format, (Date.now() - t0) / 1000);
    if (o.tracks?.length && r.tracks) {
      result.tracks = compareTracks(runtimeData(exported, ex.files.map((f) => f.name)), o.tracks, o.tracksSeconds ?? 10, r.tracks, o.tracksPhysics);
      for (const ov of result.tracks.overrides) result.notes.push(`Track ${ov.track} (${o.tracks[ov.track]}) keys ${ov.timelines} timeline(s) that track ${ov.hides} (${o.tracks[ov.hides]}) also keys: on those, track ${ov.hides}'s motion is replaced, not added (lower the higher track's alpha, or key only what it adds).`);
      result.notes.push(`Tracks: ${o.tracks.map((a, i) => `${i}: ${a}`).join(", ")} looping together for ${o.tracksSeconds ?? 10} s through SkeletonAnimation's AnimationState in Unity, against spine-core's AnimationState with spine-csharp's float32 track times (${o.tracksPhysics ? "physics on both, stepped as SkeletonAnimation does: Skeleton.Update, pose, Physics.Update" : "physics off on both"}).`);
      if (result.tracks.physics) {
        const ph = result.tracks.physics;
        result.notes.push(!ph.finite ? `Physics in Unity produced non-finite bone values (NaN or infinity) on ${ph.bones.join(", ")}: the simulation blew up.`
          : `Physics: ${ph.bones.length} bone(s) move with the simulation (${ph.bones.slice(0, 6).join(", ")}${ph.bones.length > 6 ? ", ..." : ""}). Unity and spine-core step it at the same fixed rate, but float32 and float64 can round a frame to a different number of steps: they parted by up to ${ph.maxPositionError} units (${ph.worst?.bone} at ${ph.worst?.time} s) and ${ph.ok ? `agree within ${ph.settledPositionError} over the last quarter` : `still differ by ${ph.settledPositionError} over the last quarter (they do not come back together)`}.`);
        if (ph.startup.maxOffset > 1) result.notes.push(`Physics on spawn: SkeletonAnimation starts the simulation at the setup pose, so the jump to the first frame of ${o.tracks[0]} throws the simulated parts up to ${ph.startup.maxOffset} units (${ph.startup.bone}; ${ph.startup.unityMaxOffset} in Unity's own frames)${ph.startup.settlesAt === null ? ", still moving at the end of the run" : `, settling after ${ph.startup.settlesAt} s`}. To start calm: after setting the first animation, apply it and reset physics once (Skeleton.UpdateWorldTransform(Physics.Reset)) before the first visible frame.`);
      }
    }
    if (o.batching && r.batching) {
      const data = runtimeData(exported, ex.files.map((f) => f.name));
      const budget = budgetReport(data, {}, { fps: 10, pagesKnown: true });
      result.batching = r.batching.map((b) => ({ ...b, estimate: b.animation === "(setup pose)" ? budget.setup.drawCallsPagesOnly : budget.animations.find((a) => a.name === b.animation)?.max.drawCallsPagesOnly ?? null }));
      const off = result.batching.filter((b) => b.estimate !== null && b.estimate !== b.drawCalls);
      result.notes.push(`Batching: submeshes spine-unity's SkeletonRenderer generates (one draw call each before Unity's dynamic batching or the SRP Batcher), sampled at 10 fps${off.length ? `; differs from spine_budget's estimate for ${off.map((b) => `${b.animation} (${b.drawCalls} vs ${b.estimate})`).join(", ")}` : ", same as spine_budget's estimate"}. A new submesh starts wherever the material changes in draw order: another atlas page, a blend mode material, clipping.`);
    }
    if (mecanim.length) {
      result.mecanim = compareMecanim(r, exported, ex.files.map((f) => f.name), mecanim);
      result.notes.push(`SkeletonMecanim: each transition played by Unity's Animator (CrossFadeInFixedTime, stepped at ${MECANIM_FPS} fps) through spine-unity's MecanimTranslator (layer 0 MixMode and autoReset as given, default MixNext and on), compared with spine_mix_check's runtime mecanim simulation.`);
    }
    result.unity.colorSpace = r.colorSpace;
    result.unity.renderPipeline = (r as { renderPipeline?: string }).renderPipeline;
    if (pin) {
      result.unity.spineUnityCommit = pin.commit;
      result.notes.push(`spine-unity ${pinnedVersion} at commit ${pin.commit.slice(0, 12)}${pin.from === "commit" ? "" : `, as locked in ${pin.from}`}, in its own cached project.${pin.csharpCommit && pin.csharpCommit !== pin.commit ? ` spine-csharp is locked at another commit (${pin.csharpCommit.slice(0, 12)}); it ran from ${pin.commit.slice(0, 12)}.` : ""}`);
    }
    if (urp) result.notes.push(`Rendered in a URP project (${result.unity.renderPipeline}) ${o.urpShaders !== false ? "with the atlas materials on spine-unity's \"Universal Render Pipeline/Spine/Skeleton\" shader" : "with spine-unity's default (built-in pipeline) materials"}.`);
    result.unity.workflow = r.workflow ?? (pma ? "pma" : "straight");
    if (r.textures?.length) { result.textures = r.textures; result.warnings.push(...textureFindings(r.textures, pma)); }
    if (!linear && !pma) result.notes.push("Straight alpha checked with spine-unity's straight-alpha workflow (its straight preset on the pages, Straight Alpha Texture on the materials, the straight SkeletonGraphic materials). A Unity project left on spine-unity's default PMA texture settings draws this export with bright edges: switch it (Preferences > Spine > Switch Texture Workflow) or export with premultipliedAlpha: true.");
    if (linear && pma) result.notes.push("PMA textures in a Linear project render washed out (spine-unity's PMA preset imports them without sRGB). For Linear, export with premultipliedAlpha: false and use spine-unity's straight-alpha workflow (sRGB and Alpha Is Transparency on, Straight Alpha Texture on the material).");
    if (linear && readFileSync(join(exported, ex.files.find((f) => f.name.endsWith(".json"))?.name ?? ex.files[0]!.name)).includes('"additive"')) result.notes.push("Additive slots blend in linear space in a Linear project, so glows and flashes look different from Spine's gamma render even with the right workflow.");
    if (linear) result.notes.push(`Rendered in Unity's Linear colour space with spine-unity's ${pma ? "PMA" : "straight-alpha"} texture workflow${pma ? "" : " (straight-alpha presets, Straight Alpha Texture on the material)"}, compared with Spine's own (gamma) render.`);
    if (o.render && result.imported) {
      const skeletonName = basename(result.imported.asset).replace(/_SkeletonData\.asset$/, "");
      const names = o.renderAnimations?.length ? o.renderAnimations : (r.skeletons[0]?.animations ?? []).filter((a) => a.duration > 0).map((a) => a.name);
      const visual: UnityVisual[] = [];
      let worst: { score: number; png: () => Buffer } | null = null;
      for (const name of names) {
        const unityDir = join(renderDir, renderFolder(name));
        if (!existsSync(unityDir)) continue;
        const spineRender = await renderFrames(config, cli, o.project, { skeleton: skeletonName, animation: name, fps: renderFps, scale: renderScale, background: "7f7f7fff" });
        const unityFrames = readdirSync(unityDir).filter((f) => f.endsWith(".png")).sort().map((f) => join(unityDir, f));
        const n = Math.min(unityFrames.length, spineRender.frames.length);
        let minIoU = 1, sumIoU = 0, sumColor = 0, maxColor = 0, worstFrame = 0;
        for (let k = 0; k < n; k++) {
          const c = compareFrames(spineRender.frames[k]!, unityFrames[k]!, [GREY, GREY, GREY]);
          sumIoU += c.iou; sumColor += c.colorDiff; maxColor = Math.max(maxColor, c.colorDiff);
          if (c.iou < minIoU) { minIoU = c.iou; worstFrame = k; }
          const score = (1 - c.iou) + c.colorDiff;
          if (!worst || score > worst.score) worst = { score, png: c.diffPng };
        }
        visual.push({ animation: name, frames: n, minIoU: +minIoU.toFixed(4), meanIoU: +(sumIoU / Math.max(1, n)).toFixed(4), meanColorDiff: +(sumColor / Math.max(1, n)).toFixed(4), maxColorDiff: +maxColor.toFixed(4), worstFrame, ok: sumIoU / Math.max(1, n) >= VIS_MEAN_IOU && minIoU >= VIS_MIN_IOU && sumColor / Math.max(1, n) <= VIS_COLOR });
      }
      result.visual = visual;
      if (worst) result.visualPng = worst.png();
      if (r.skeletons[0]?.bones && readFileSync(join(exported, ex.files.find((f) => f.name.endsWith(".json"))?.name ?? ex.files[0]!.name)).includes('"physics"')) {
        result.notes.push("This rig has physics: each renderer runs its own simulation, so physics-driven parts can differ (chaotic motion more so). Bake the physics (bakePhysics) for an exact comparison.");
      }
      if (o.canvasGroup && r.canvasGroup) {
        const animations = names.flatMap((name) => {
          const dir = join(renderDir, renderFolder(name));
          const asIs = fadeFolder(dir, "canvas-group-as-is", GROUP_ALPHA, GREY, "canvas-group-reference"), detected = fadeFolder(dir, "canvas-group-detected", GROUP_ALPHA, GREY, "canvas-group-reference"), overlap = fadeFolder(dir, "canvas-group-reference", GROUP_ALPHA, GREY);
          return asIs && detected && overlap ? [{ animation: name, asIs, detected, overlap }] : [];
        });
        result.canvasGroup = { alpha: GROUP_ALPHA, settings: { asIs: r.canvasGroup.asIs, detected: r.canvasGroup.detected }, animations };
        type Row = (typeof animations)[number];
        const worst = (k: "asIs" | "detected" | "overlap") => animations.reduce<Row | null>((w, x) => (!w || x[k].visiblePercent > w[k].visiblePercent ? x : w), null);
        const off = (k: "asIs" | "detected" | "overlap") => animations.some((x) => x[k].visiblePercent >= FADE_OFF_PERCENT);
        const additive = readFileSync(join(exported, ex.files.find((f) => f.name.endsWith(".json"))?.name ?? ex.files[0]!.name)).includes('"additive"');
        if (!animations.length) result.warnings.push("canvasGroup: Unity wrote no faded frames.");
        else {
          const a = worst("asIs")!, d = worst("detected")!, v = worst("overlap")!;
          if (off("detected")) result.warnings.push(`canvasGroup: even with spine-unity's Detect Settings below the CanvasGroup (${r.canvasGroup.detected}), ${d.animation} blends differently from fading each part through the SkeletonGraphic's colour on ${d.detected.visiblePercent}% of its pixels (mean ${d.detected.meanDiff}/255).${additive ? " This skeleton has additive slots: on spineboy's portal their glow is lost under the CanvasGroup (looked at); fade those slots' alpha in the animation or render the character to a texture." : ""}`);
          result.notes.push(off("asIs")
            ? `canvasGroup: faded to ${GROUP_ALPHA} with the settings detected without a CanvasGroup (${r.canvasGroup.asIs}), ${a.animation} blends wrong on ${a.asIs.visiblePercent}% of its pixels (mean ${a.asIs.meanDiff}/255 from fading each part right): PMA colours are not multiplied by the group alpha, so the art brightens instead of fading. ${off("detected") ? "" : `After Detect Settings below the CanvasGroup (${r.canvasGroup.detected}) it is right. `}Under a CanvasGroup, run Detect Settings on the SkeletonGraphic (CanvasGroup Compatible on, PMA Vertex Color off, the -CanvasGroup material).`
            : `canvasGroup: faded to ${GROUP_ALPHA}, the SkeletonGraphic blends right with its settings as detected without a CanvasGroup (${r.canvasGroup.asIs}).`);
          if (off("overlap")) result.notes.push(`canvasGroup: a CanvasGroup fades each part on its own, so where parts overlap the ones behind show through: ${v.animation} differs from fading the character as one layer (Spine's or an image editor's layer opacity) on ${v.overlap.visiblePercent}% of its pixels (mean ${v.overlap.meanDiff}/255), whatever the settings. For a clean fade, render it to a texture first and fade that (spine-unity's SkeletonGraphicRenderTexture example component, sample scene "RenderTexture FadeOut Transparency").`);
        }
      }
      result.notes.push(`Visual: Unity camera render (${o.renderComponent === "graphic" ? "UI SkeletonGraphic under a World Space Canvas, material and blend-mode materials detected as spine-unity does" : "SkeletonAnimation, default material"}) vs Spine's own render at ${renderFps} fps, ${renderScale}%; ok = mean silhouette IoU >= ${VIS_MEAN_IOU}, worst frame >= ${VIS_MIN_IOU}, mean colour difference <= ${VIS_COLOR} (renders differ slightly at edges: Spine uses MSAA).`);
    }
    if (android && r.compression) {
      const out = compressionReport(r.compression, o.compression!, compressionDir, compressionAnims);
      result.compression = out.report;
      if (out.png) result.compressionPng = out.png;
      for (const f of out.report.formats) {
        if (!f.applied) result.warnings.push(`compression ${f.format}: Unity loaded ${[...new Set(f.loaded)].join(", ")} instead of ${f.unityFormat}, so the numbers are not that format's.`);
        else if (f.texture.psnr === null) result.warnings.push(`compression ${f.format}: the pages read back identical to RGBA32, so the compressed data was not what the GPU sampled.`);
      }
      result.notes.push(`Compression: the atlas imported for Android (separate cached project on the Android build target), first as RGBA32 and then in each format, nothing else changed. texture = the pages as the GPU samples them against RGBA32; render = frames at 100% (${compressionAnims.join(", ")} at ${compressionFps} fps) against the RGBA32 frames. PSNR in dB (higher is closer; identical = null); visiblePercent = drawn pixels where a channel moved by 8/255 or more. Memory without mip maps. Which loss is acceptable depends on how big the character is on screen: judge the image.`);
    }
    return result;
  } finally {
    for (const p of [target, `${target}.meta`, exported, report, renderDir, compressionDir]) removeQuiet(p);
  }
}

export function runtimeBranch(): string {
  const pkg = JSON.parse(readFileSync(join(here, "..", "..", "node_modules", "@esotericsoftware", "spine-core", "package.json"), "utf8")) as { version: string };
  return pkg.version.split(".").slice(0, 2).join(".");
}

const POS_TOL = 0.01, ROT_TOL = 0.01;
const MECANIM_FPS = 60;
// Physics with tracksPhysics: Unity and spine-core part while fixed steps round differently, then meet again (measured
// on celestial-circus: 46 units at 0.4 s, under 0.001 after 4 s). The last quarter of the run must agree.
const PHYSICS_SETTLED = 0.1;

function runtimeData(dir: string, files: string[]): spine.SkeletonData {
  const atlas = new spine.TextureAtlas(readFileSync(join(dir, files.find((f) => f.endsWith(".atlas"))!), "utf8"));
  const loader = new spine.AtlasAttachmentLoader(atlas);
  const skel = files.find((f) => f.endsWith(".json")) ?? files.find((f) => f.endsWith(".skel"))!;
  return skel.endsWith(".json")
    ? new spine.SkeletonJson(loader).readSkeletonData(readFileSync(join(dir, skel), "utf8"))
    : new spine.SkeletonBinary(loader).readSkeletonData(new Uint8Array(readFileSync(join(dir, skel))));
}

/** spine-core's AnimationState with one looping animation per track, as the Unity script plays them. */
export function compareTracks(data: spine.SkeletonData, animations: string[], seconds: number, unity: number[][], physics = false): NonNullable<UnityCheckResult["tracks"]> {
  const sk = new spine.Skeleton(data);
  sk.setupPose();
  const state = new spine.AnimationState(new spine.AnimationStateData(data));
  animations.forEach((a, i) => { if (!data.findAnimation(a)) throw new UserError(`tracks: animation "${a}" not found`); state.setAnimation(i, a, true); });
  // spine-csharp keeps track times in float32: accumulate them the same way, or frames that land exactly on a stepped
  // key fall on different sides of it.
  const fps = 30, dt = Math.fround(1 / fps);
  // With physics: the bones the simulation moves (physics constraint bones and everything under them) are compared apart.
  const sim = new Set<number>();
  if (physics) {
    // Every bone the simulation moves, directly or through constraints: where physics on and off ever differ.
    const on = playTracks(data, animations, unity.length, fps, "setup"), off = playTracks(data, animations, unity.length, fps, "none");
    for (let k = 0; k < on.length; k++) data.bones.forEach((_, i) => {
      if (Math.hypot(on[k]![i * 3]! - off[k]![i * 3]!, on[k]![i * 3 + 1]! - off[k]![i * 3 + 1]!) > 1e-3 || Math.abs(angleDelta(on[k]![i * 3 + 2]!, off[k]![i * 3 + 2]!)) > 1e-3) sim.add(i);
    });
  }
  let maxPos = 0, maxRot = 0, worst: { bone: string; time: number } | null = null;
  let simPos = 0, simRot = 0, simSettled = 0, simWorst: { bone: string; time: number } | null = null, finite = true;
  const settledFrom = Math.floor(unity.length * 0.75);
  // SkeletonRenderer.Initialize updates the world transform once (Physics.Update) at the setup pose: the simulation
  // starts there and takes the jump to the first animated pose as movement.
  if (physics) sk.updateWorldTransform(spine.Physics.update);
  for (let k = 0; k < unity.length; k++) {
    if (k > 0) {
      if (physics) { sk.update(dt); sk.time = Math.fround(sk.time); }
      state.update(dt);
      for (const e of state.tracks) if (e) { e.trackTime = Math.fround(e.trackTime); e.animationLast = Math.fround(e.animationLast); e.nextAnimationLast = Math.fround(e.nextAnimationLast); }
    }
    state.apply(sk);
    sk.updateWorldTransform(physics ? spine.Physics.update : spine.Physics.none);
    const u = unity[k]!;
    sk.bones.forEach((b, i) => {
      const p = b.appliedPose;
      const e = Math.hypot(p.worldX - u[i * 3]!, p.worldY - u[i * 3 + 1]!), r = Math.abs(angleDelta(p.getWorldRotationX(), u[i * 3 + 2]!));
      if (sim.has(i)) {
        if (![u[i * 3], u[i * 3 + 1], u[i * 3 + 2]].every((v) => Number.isFinite(v))) finite = false;
        if (e > simPos) { simPos = e; simWorst = { bone: b.data.name, time: +(k / fps).toFixed(3) }; }
        if (k >= settledFrom) simSettled = Math.max(simSettled, e);
        simRot = Math.max(simRot, r);
        return;
      }
      if (e > maxPos) { maxPos = e; worst = { bone: b.data.name, time: +(k / fps).toFixed(3) }; }
      maxRot = Math.max(maxRot, r);
    });
  }
  // A higher track replaces what a lower one keys on the same timelines (alpha 1): the lower track's motion there is gone.
  const ids = (a: spine.Animation) => new Set(a.timelines.flatMap((t) => t.getPropertyIds()));
  const sets = animations.map((a) => ids(data.findAnimation(a)!));
  const overrides: { track: number; hides: number; timelines: number }[] = [];
  for (let hi = 1; hi < animations.length; hi++) for (let lo = 0; lo < hi; lo++) {
    const shared = [...sets[hi]!].filter((p) => sets[lo]!.has(p)).length;
    if (shared) overrides.push({ track: hi, hides: lo, timelines: shared });
  }
  const phys = physics ? {
    bones: [...sim].map((i) => data.bones[i]!.name), maxPositionError: +simPos.toPrecision(3), settledPositionError: +simSettled.toPrecision(3), maxRotationError: +simRot.toPrecision(3),
    worst: simWorst, finite, ok: finite && simSettled <= PHYSICS_SETTLED, startup: physicsStartup(data, animations, sim, unity, fps),
  } : null;
  return { animations, seconds, frames: unity.length, maxPositionError: +maxPos.toPrecision(3), maxRotationError: +maxRot.toPrecision(3), worst, ok: maxPos <= 0.01 && maxRot <= 0.05 && (!phys || phys.ok), overrides, ...(phys ? { physics: phys } : {}) };
}

/**
 * spine-core playing the tracks: physics off ("none"), started at the setup pose as SkeletonRenderer.Initialize does
 * ("setup"), or reset at the first animated pose ("reset"). World x, y and rotation of every bone per frame (as the Unity
 * report holds them).
 */
function playTracks(data: spine.SkeletonData, animations: string[], frames: number, fps: number, physics: "none" | "setup" | "reset"): number[][] {
  const sk = new spine.Skeleton(data);
  sk.setupPose();
  const state = new spine.AnimationState(new spine.AnimationStateData(data));
  animations.forEach((a, i) => state.setAnimation(i, a, true));
  if (physics === "setup") sk.updateWorldTransform(spine.Physics.update);
  const out: number[][] = [];
  for (let k = 0; k < frames; k++) {
    if (k > 0) { sk.update(1 / fps); state.update(1 / fps); }
    state.apply(sk);
    sk.updateWorldTransform(physics === "none" ? spine.Physics.none : physics === "reset" && k === 0 ? spine.Physics.reset : spine.Physics.update);
    out.push(sk.bones.flatMap((b) => [b.appliedPose.worldX, b.appliedPose.worldY, b.appliedPose.getWorldRotationX()]));
  }
  return out;
}

/**
 * The spawn kick: the largest offset of a simulated bone between physics started at the setup pose and physics reset
 * at the first animated pose (spine-core), when it stays under 1 unit, and the same offset in Unity's own frames up to
 * then (Unity starts at the setup pose too; after the kick its fixed steps round apart from spine-core's).
 */
function physicsStartup(data: spine.SkeletonData, animations: string[], sim: Set<number>, unity: number[][], fps: number): { maxOffset: number; bone: string | null; settlesAt: number | null; unityMaxOffset: number } {
  const frames = unity.length, a = playTracks(data, animations, frames, fps, "setup"), b = playTracks(data, animations, frames, fps, "reset");
  let maxOffset = 0, bone: string | null = null, last = -1;
  for (let k = 0; k < frames; k++) for (const i of sim) {
    const d = Math.hypot(a[k]![i * 3]! - b[k]![i * 3]!, a[k]![i * 3 + 1]! - b[k]![i * 3 + 1]!);
    if (d > maxOffset) { maxOffset = d; bone = data.bones[i]!.name; }
    if (d > 1) last = k;
  }
  let unityMaxOffset = 0;
  for (let k = 0; k <= Math.min(last, frames - 1); k++) for (const i of sim) {
    const d = Math.hypot(unity[k]![i * 3]! - b[k]![i * 3]!, unity[k]![i * 3 + 1]! - b[k]![i * 3 + 1]!);
    if (Number.isFinite(d)) unityMaxOffset = Math.max(unityMaxOffset, d);
  }
  return { maxOffset: +maxOffset.toPrecision(3), bone, settlesAt: last < 0 ? 0 : last === frames - 1 ? null : +((last + 1) / fps).toFixed(2), unityMaxOffset: +unityMaxOffset.toPrecision(3) };
}

/** Unity's SkeletonMecanim frames against the simulation, and the largest single-frame jump Unity shows. */
export function compareMecanim(r: UnityReport, dir: string, files: string[], spec: { from: string; to: string; duration: number; at: number; seconds: number; trace?: string; mode: MecanimMode; autoReset: boolean }[]): UnityMecanimTransition[] {
  const data = runtimeData(dir, files);
  const names = r.skeletons[0]?.bones ?? data.bones.map((b) => b.name);
  return (r.mecanim ?? []).map((u, i) => {
    const m = spec[i]!;
    const sim = mecanimFrames(data, { first: m.from, second: m.to, switchAt: m.at, mix: m.duration, seconds: m.seconds, fps: MECANIM_FPS, mecanimMode: m.mode, autoReset: m.autoReset });
    let maxPos = 0;
    const n = Math.min(sim.length, u.frames.length);
    for (let k = 0; k < n; k++) for (let b = 0; b < names.length; b++) maxPos = Math.max(maxPos, Math.hypot(sim[k]![b * 3]! - u.frames[k]![b * 3]!, sim[k]![b * 3 + 1]! - u.frames[k]![b * 3 + 1]!));
    const step = (k: number, b: number) => Math.hypot(u.frames[k]![b * 3]! - u.frames[k - 1]![b * 3]!, u.frames[k]![b * 3 + 1]! - u.frames[k - 1]![b * 3 + 1]!);
    const start = Math.round(m.at * MECANIM_FPS);
    let pop: UnityMecanimTransition["pop"] = null;
    for (let k = Math.max(2, start); k < u.frames.length - 1; k++) {
      for (let b = 0; b < names.length; b++) {
        const s0 = step(k, b), nb = Math.max(step(k - 1, b), step(k + 1, b));
        if (s0 > 1 && s0 > 3 * nb && (!pop || s0 > pop.step)) {
          const time = +((k - start) / MECANIM_FPS).toFixed(3);
          pop = { bone: names[b]!, step: +s0.toFixed(2), time, afterTransition: time >= m.duration - 1.5 / MECANIM_FPS };
        }
      }
    }
    let trace: UnityMecanimTransition["trace"];
    if (m.trace) {
      const b = names.indexOf(m.trace);
      if (b < 0) throw new UserError(`mecanimTransitions trace: bone "${m.trace}" not found`);
      const from = Math.max(0, start - 2), pick = (f: number[][]) => f.slice(from, n).map((row) => [+row[b * 3]!.toFixed(3), +row[b * 3 + 1]!.toFixed(3)] as [number, number]);
      trace = { bone: m.trace, fps: MECANIM_FPS, unity: pick(u.frames), simulation: pick(sim as unknown as number[][]) };
    }
    return { from: m.from, to: m.to, duration: m.duration, at: m.at, mode: m.mode, autoReset: m.autoReset, frames: u.frames.length, maxPositionError: +maxPos.toPrecision(3), pop, ...(trace ? { trace } : {}) };
  });
}
// Calibrated: correct renders sit at mean IoU >= 0.95 and mean colour <= 0.06 (edges differ: Spine uses MSAA); a
// straight-alpha atlas in spine-unity drops spineboy to 0.83 / 0.14.
const VIS_MEAN_IOU = 0.93, VIS_MIN_IOU = 0.9, VIS_COLOR = 0.07;

export function compare(r: UnityReport, dir: string, files: string[], version: string, format: string, seconds: number): UnityCheckResult {
  const notes = [
    "Compared in Spine units (SkeletonDataAsset scale set to 1), physics off on both sides, each animation applied over the setup pose.",
    `Unity read the ${format} export through spine-unity's own importer (SkeletonDataAsset, atlas asset and materials were created).`,
  ];
  const s = r.skeletons[0];
  const base: Omit<UnityCheckResult, "animations" | "parity" | "imported"> = {
    unity: { version: r.unityVersion, spineUnity: r.spineUnityVersion, editor: version },
    tolerance: { position: POS_TOL, rotationDegrees: ROT_TOL }, errors: r.errors, warnings: r.warnings, seconds: +seconds.toFixed(1), notes,
  };
  if (!s || !s.loaded || !s.animations) return { ...base, imported: null, animations: [], parity: false };

  // spine-core reads the same exported files with the same atlas.
  const atlas = new spine.TextureAtlas(readFileSync(join(dir, files.find((f) => f.endsWith(".atlas"))!), "utf8"));
  const loader = new spine.AtlasAttachmentLoader(atlas);
  const skel = files.find((f) => f.endsWith(".json")) ?? files.find((f) => f.endsWith(".skel"))!;
  const data = skel.endsWith(".json")
    ? new spine.SkeletonJson(loader).readSkeletonData(readFileSync(join(dir, skel), "utf8"))
    : new spine.SkeletonBinary(loader).readSkeletonData(new Uint8Array(readFileSync(join(dir, skel))));
  const sk = new spine.Skeleton(data);
  const animations: UnityAnimationParity[] = s.animations.map((ua) => {
    const anim = data.findAnimation(ua.name);
    let maxPos = 0, maxRot = 0;
    if (!anim) return { name: ua.name, duration: ua.duration, maxPositionError: Infinity, maxRotationError: Infinity, ok: false };
    // Unity's own float sample times: keys are stored as floats on both sides, so instants on a key agree.
    for (let k = 0; k < ua.frames.length; k++) {
      const t = Math.fround(ua.times[k]!); // printed as the shortest round-trip float string
      sk.setupPose();
      anim.apply(sk, t, t, false, null, 1, spine.MixFrom.setup, false, false, false);
      sk.updateWorldTransform(spine.Physics.none);
      const frame = ua.frames[k]!;
      sk.bones.forEach((b, i) => {
        const p = b.appliedPose;
        maxPos = Math.max(maxPos, Math.hypot(p.worldX - frame[i * 3]!, p.worldY - frame[i * 3 + 1]!));
        maxRot = Math.max(maxRot, Math.abs(angleDelta(p.getWorldRotationX(), frame[i * 3 + 2]!)));
      });
    }
    return { name: ua.name, duration: ua.duration, maxPositionError: +maxPos.toPrecision(3), maxRotationError: +maxRot.toPrecision(3), ok: maxPos <= POS_TOL && maxRot <= ROT_TOL && Math.abs(anim.duration - ua.duration) < 1e-4 };
  });
  return {
    ...base,
    imported: { asset: s.asset, atlases: s.atlases, materials: s.materials, bones: s.bones?.length ?? 0, slots: s.slots ?? 0 },
    animations,
    parity: r.errors.length === 0 && animations.length === data.animations.length && animations.every((a) => a.ok),
  };
}

