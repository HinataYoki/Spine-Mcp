import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { removeQuiet, runFile } from "../platform.js";
import type { SpineCli } from "./cli.js";
import { budgetReport } from "./budget.js";
import { exportRuntime } from "./export.js";
import { readSkeletonJson, UserError } from "./project.js";
import { loadSkeletonData } from "./runtime.js";
import { CHECK_SCRIPT, HUB_EDITORS, PERF_SCRIPTS, ensureProject, ensureRuntimes, installedUnityVersions, pinnedRuntime, runtimeBranch, unityBinary, unityQueued } from "./unity.js";

export interface UnityPerfOptions {
  project: string;
  unityVersion?: string;
  /** A 40-character commit or a Unity project path: the player is built on that spine-unity. */
  spineUnity?: string;
  /** Animations to measure (default: the first one). */
  animations?: string[];
  /** Skeleton counts (default 1, 10, 50). */
  counts?: number[];
  /** Measured frames per run (default 120) after warmup frames (default 30). */
  frames?: number;
  warmup?: number;
  /** Skin to wear (default: the default skin). */
  skin?: string;
  /** single: spine-unity's main-thread update; threaded: its SkeletonUpdateSystem (default both). */
  modes?: ("single" | "threaded")[];
}

export interface PerfStats { median: number; p95: number; mean: number; max: number }

export interface PerfRawRun {
  animation: string; count: number; mode: string;
  frameMs: PerfStats | null; updateMs: PerfStats | null; lateUpdateMs: PerfStats | null;
  gcBytesPerFrame: number; vertices: [number, number] | null; meshChanged: boolean;
  threadedSystem: boolean; registered: [number, number]; pose: [number, number];
}

export interface PerfRawReport {
  unityVersion: string; backend: string; system: { processor: string; cores: number; os: string; graphics: string };
  frames: number; warmup: number; control: PerfRawRun | null; baseline: PerfRawRun | null; runs: PerfRawRun[]; errors: string[];
  /** The skin measured and the skeleton's other skins (added on the TypeScript side). */
  skin?: string; skins?: string[];
  /** spine_budget's peak metrics per measured animation (added on the TypeScript side from the same export). */
  budget?: Record<string, { vertexTransforms: number; clippedTriangles: number; drawCalls: number }>;
}

export interface PerfRun {
  animation: string; count: number; mode: string;
  /**
   * Main-thread time in Update and LateUpdate above the empty loop (median and 95th percentile, ms): the frame budget
   * the skeletons take. With threading it is what the main thread still spends, waiting for the workers included.
   */
  mainThreadMs: number; p95Ms: number;
  /** mainThreadMs per skeleton, microseconds. */
  usPerSkeleton: number;
  /** Whole frame time above the empty loop (median, ms); the headless player paces frames in ~0.1 ms steps, so it is coarse. */
  frameMs: number;
  /** Managed allocations per frame above the empty loop, bytes (resolution: gcResolution). */
  gcBytesPerFrame: number;
  vertices: [number, number] | null;
}

export interface PerfReport {
  machine: { processor: string; cores: number; os: string; backend: string; unity: string };
  frames: number; baselineMs: number; gcResolution: number;
  runs: PerfRun[];
  animations: { animation: string; budget?: { vertexTransforms: number; clippedTriangles: number; drawCalls: number }; usPerSkeleton: Record<string, number>; threadedSpeedup: number | null; gcBytesPerFrame: number }[];
  warnings: string[];
  notes: string[];
}

// The managed heap is counted in 4 KB steps: allocations are resolved to 4096 / frames bytes per frame.
const HEAP_STEP = 4096;
// A known 1000-byte array per frame (plus its header) must read within this share of 1024 bytes.
const CONTROL_BYTES = 1024, CONTROL_TOLERANCE = 0.5;

const round = (v: number, d = 3) => +v.toFixed(d);

/** Per run cost above the empty player loop, the checks behind the numbers (mesh built, threading on, same pose), and a summary per animation. */
export function perfReport(raw: PerfRawReport): PerfReport {
  const warnings = raw.errors.map((e) => `Player: ${e.split("\n")[0]}`), notes: string[] = [];
  const main = (r: PerfRawRun | null, k: "median" | "p95") => (r?.updateMs?.[k] ?? 0) + (r?.lateUpdateMs?.[k] ?? 0);
  const base = main(raw.baseline, "median"), baseP95 = main(raw.baseline, "p95"), baseFrame = raw.baseline?.frameMs?.median ?? 0, baseGc = raw.baseline?.gcBytesPerFrame ?? 0;
  const resolution = round(HEAP_STEP / Math.max(1, raw.frames), 1);
  const control = raw.control ? raw.control.gcBytesPerFrame - baseGc : null;
  if (control === null || Math.abs(control - CONTROL_BYTES) > CONTROL_TOLERANCE * CONTROL_BYTES + resolution) warnings.push(`The allocation control read ${control === null ? "nothing" : `${round(control, 0)} bytes`} for about ${CONTROL_BYTES} per frame: the GC numbers below are not reliable on this player.`);
  const runs: PerfRun[] = raw.runs.map((r) => {
    const cost = Math.max(0, main(r, "median") - base);
    return {
      animation: r.animation, count: r.count, mode: r.mode, mainThreadMs: round(cost, 4), p95Ms: round(Math.max(0, main(r, "p95") - baseP95), 4),
      usPerSkeleton: r.count ? round((cost * 1000) / r.count, 2) : 0, frameMs: round(Math.max(0, (r.frameMs?.median ?? 0) - baseFrame), 3),
      gcBytesPerFrame: round(Math.max(0, r.gcBytesPerFrame - baseGc), 1), vertices: r.vertices,
    };
  });
  // The numbers mean something only when the work happened: meshes built, threading on when asked, the same result.
  for (const r of raw.runs) {
    const at = `${r.animation} x${r.count} ${r.mode}`;
    if (r.count > 0 && (!r.vertices || r.vertices[1] === 0)) warnings.push(`${at}: no mesh was generated, so this run measured no rendering work.`);
    if (r.mode === "threaded" && (r.registered[0] !== r.count || r.registered[1] !== r.count)) warnings.push(`${at}: spine-unity's threaded update ran ${r.registered[0]} animation(s) and ${r.registered[1]} renderer(s) of ${r.count}; the rest stayed on the main thread.`);
    if (r.mode === "threaded") {
      // Worker threads may finish after LateUpdate: the whole frame then shows work the main-thread window does not.
      const frame = Math.max(0, (r.frameMs?.median ?? 0) - (raw.baseline?.frameMs?.median ?? 0)), mainMs = Math.max(0, main(r, "median") - base);
      if (frame > 0.3 && frame > 1.3 * mainMs) warnings.push(`${at}: the whole frame (${round(frame, 3)} ms) is well above the main thread's ${round(mainMs, 3)} ms: worker threads run past LateUpdate, so judge this run by its frame time.`);
      const single = raw.runs.find((x) => x.animation === r.animation && x.count === r.count && x.mode === "single");
      if (single && Math.hypot(single.pose[0] - r.pose[0], single.pose[1] - r.pose[1]) > 1e-3) warnings.push(`${at}: the threaded pose differs from the single-threaded one (${single.pose.join(", ")} vs ${r.pose.join(", ")}): it did not do the same work.`);
    }
  }
  const animations = [...new Set(runs.map((r) => r.animation))].map((animation) => {
    const mine = runs.filter((r) => r.animation === animation && r.count > 0);
    const top = Math.max(...mine.map((r) => r.count));
    const single = mine.find((r) => r.count === top && r.mode === "single"), threaded = mine.find((r) => r.count === top && r.mode === "threaded");
    const worst = mine.reduce<PerfRun | null>((w, r) => (!w || r.gcBytesPerFrame > w.gcBytesPerFrame ? r : w), null);
    const gc = worst?.gcBytesPerFrame ?? 0;
    if (worst && gc >= 2 * resolution) warnings.push(`${animation}: ${round(gc, 0)} bytes of managed garbage per frame with ${worst.count} skeleton(s) (about ${round(gc / Math.max(1, worst.count), 0)} each), so the collector runs regularly and each run is a frame spike. Measured on spineboy: clipping and attachment swaps allocate (G121)${raw.budget?.[animation]?.clippedTriangles ? `; this animation clips ${raw.budget[animation]!.clippedTriangles} triangles at its peak` : ""}.`);
    // Threading has a fixed cost: below some count the main thread spends more than it did alone.
    const slower = mine.filter((r) => r.mode === "threaded").filter((t) => { const s1 = mine.find((x) => x.mode === "single" && x.count === t.count); return s1 && t.mainThreadMs > s1.mainThreadMs; }).map((t) => t.count);
    if (slower.length) notes.push(`${animation}: the threaded update costs the main thread more than the single-threaded one at ${slower.join(", ")} skeleton(s) (its fixed scheduling cost); it pays off above that.`);
    return {
      animation, ...(raw.budget?.[animation] ? { budget: raw.budget[animation] } : {}),
      usPerSkeleton: Object.fromEntries(mine.filter((r) => r.mode === "single").map((r) => [String(r.count), r.usPerSkeleton])),
      threadedSpeedup: single && threaded && threaded.mainThreadMs > 0 ? round(single.mainThreadMs / threaded.mainThreadMs, 2) : null,
      gcBytesPerFrame: gc,
    };
  });
  if (raw.skin === "default" && raw.skins?.length) notes.push(`Measured with the default skin; this skeleton also has ${raw.skins.slice(0, 5).join(", ")}${raw.skins.length > 5 ? ", ..." : ""}: pass perf.skin to measure the one the game shows (the default skin may draw little).`);
  notes.push(`Measured in a headless ${raw.backend} player built with Unity ${raw.unityVersion} on ${raw.system.processor} (${raw.system.cores} cores, ${raw.system.os}), not on a phone: compare animations, counts and modes with each other; absolute milliseconds on a device (usually IL2CPP, slower cores) are higher.`);
  notes.push(`Per run: ${raw.frames} frames at a fixed 1/30 s step after ${raw.warmup} warm-up frames, start times staggered per skeleton. mainThreadMs = Update + LateUpdate on the main thread (median) minus the empty loop; usPerSkeleton divides it by the count; threadedSpeedup compares the main thread alone and with spine-unity's threaded update at the largest count. GC = the managed heap's growth with the collector off, resolved to ${resolution} bytes per frame.`);
  return { machine: { processor: raw.system.processor, cores: raw.system.cores, os: raw.system.os, backend: raw.backend, unity: raw.unityVersion }, frames: raw.frames, baselineMs: round(base, 4), gcResolution: resolution, runs, animations, warnings, notes };
}

/** Runs the perf player and reports cost per skeleton, threaded speedup and garbage per frame, next to spine_budget's metrics. */
export async function unityPerf(config: Config, cli: SpineCli, o: UnityPerfOptions): Promise<PerfReport> {
  return perfReport(await unityPerfRaw(config, cli, o));
}

/** Where Unity Hub installs the standalone player module the perf player is built with. */
function standaloneModule(version: string): string {
  const editor = join(HUB_EDITORS, version);
  return process.platform === "darwin" ? join(editor, "PlaybackEngines", "MacStandaloneSupport") : join(editor, "Editor", "Data", "PlaybackEngines", "windowsstandalonesupport");
}

/** The player's executable inside its build folder (macOS: the .app's MacOS folder; Windows: the .exe). */
function playerExecutable(buildDir: string): string | null {
  if (process.platform === "darwin") {
    const macos = join(buildDir, "SpineMcpPerf.app", "Contents", "MacOS");
    const exe = existsSync(macos) ? readdirSync(macos)[0] : undefined;
    return exe ? join(macos, exe) : null;
  }
  const exe = join(buildDir, "SpineMcpPerf.exe");
  return existsSync(exe) ? exe : null;
}

/**
 * The cached perf player for a Unity version: built once, rebuilt when the scripts, the spine-unity branch or the
 * editor change (a stamp next to the build).
 */
async function ensurePerfPlayer(root: string, version: string, pin?: string): Promise<string> {
  if (process.platform !== "darwin" && process.platform !== "win32") throw new UserError("perf builds a macOS or Windows player; this platform has none.");
  if (!process.env.UNITY_BIN && !existsSync(standaloneModule(version))) throw new UserError(`perf needs Unity ${version}'s ${process.platform === "darwin" ? "Mac" : "Windows"} Build Support module (Unity Hub > Installs > Add modules).`);
  const branch = runtimeBranch();
  const runtimes = await ensureRuntimes(root, branch, pin);
  const project = ensureProject(root, version, runtimes, "gamma", false, false, true, pin);
  const buildDir = join(project, "Build");
  const stamp = createHash("sha1").update([PERF_SCRIPTS.player, PERF_SCRIPTS.build, CHECK_SCRIPT].map((f) => readFileSync(f, "utf8")).join("\n")).update(`${version}|${branch}|${pin ?? ""}`).digest("hex");
  const stampFile = join(buildDir, "stamp.txt");
  const existing = playerExecutable(buildDir);
  if (existing && existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp) return existing;
  removeQuiet(buildDir);
  mkdirSync(buildDir, { recursive: true });
  const report = join(root, `perf-build-${Date.now()}.json`), log = join(root, `unity-perf-build-${Date.now()}.log`);
  try {
    await runFile(unityBinary(version), ["-batchmode", "-nographics", "-projectPath", project, "-executeMethod", "SpineMcpPerfBuild.Build",
      "-spineMcpPerfPlayer", join(buildDir, process.platform === "darwin" ? "SpineMcpPerf.app" : "SpineMcpPerf.exe"), "-spineMcpOut", report, "-logFile", log], { timeout: 30 * 60_000 });
  } catch (e) {
    const r = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) as { error?: string } : null;
    throw new UserError(`Building the perf player failed: ${r?.error?.split("\n")[0] ?? (e as Error).message.split("\n")[0]} (log: ${log})`);
  } finally {
    removeQuiet(report);
  }
  const exe = playerExecutable(buildDir);
  if (!exe) throw new UserError(`The perf player build produced no executable in ${buildDir} (log: ${log})`);
  writeFileSync(stampFile, stamp);
  return exe;
}

/** Runs the perf player on a fresh export of the project: raw per-run frame times, GC and the checks behind them. */
export async function unityPerfRaw(config: Config, cli: SpineCli, o: UnityPerfOptions): Promise<PerfRawReport> {
  // A run keeps every skeleton alive at once and plays every frame: keep it within minutes.
  if ((o.counts ?? []).some((c) => !Number.isInteger(c) || c < 1 || c > 500) || (o.frames !== undefined && (!Number.isInteger(o.frames) || o.frames < 60 || o.frames > 3000))) throw new UserError("perf: counts from 1 to 500 skeletons, frames from 60 to 3000.");
  const root = join(config.workDir, "unity");
  return unityQueued(root, async () => {
    const versions = installedUnityVersions();
    const version = o.unityVersion ?? versions.find((v) => existsSync(standaloneModule(v))) ?? versions[0];
    if (!version) throw new UserError("No Unity editor found in Unity Hub. Set UNITY_BIN to a Unity binary.");
    const exe = await ensurePerfPlayer(root, version, o.spineUnity ? pinnedRuntime(o.spineUnity).commit : undefined);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(root, `perf-${stamp}`), out = join(root, `perf-${stamp}.json`);
    try {
      const ex = await exportRuntime(config, cli, { project: o.project, outputDir: dir, format: "json", premultipliedAlpha: true });
      if (!ex.files.some((f) => f.name.endsWith(".atlas"))) throw new UserError("The export has no atlas.");
      const doc = readSkeletonJson(join(dir, ex.files.find((f) => f.name.endsWith(".json"))!.name));
      const animations = o.animations?.length ? o.animations : Object.keys(doc.animations ?? {}).slice(0, 1);
      for (const a of animations) if (!doc.animations?.[a]) throw new UserError(`Animation "${a}" not found. It has: ${Object.keys(doc.animations ?? {}).join(", ")}`);
      if (o.skin && !(doc.skins ?? []).some((s) => s.name === o.skin)) throw new UserError(`Skin "${o.skin}" not found. It has: ${(doc.skins ?? []).map((s) => s.name).join(", ")}`);
      const budget = budgetReport(loadSkeletonData(doc), {}, { fps: 30, pagesKnown: false, ...(o.skin ? { skin: o.skin } : {}) });
      const args = ["-batchmode", "-nographics", "-logFile", join(root, `unity-perf-${stamp}.log`), "-spineMcpPerfDir", dir, "-spineMcpPerfOut", out,
        "-spineMcpPerfFrames", String(o.frames ?? 120), "-spineMcpPerfWarmup", String(o.warmup ?? 30),
        "-spineMcpPerfCounts", (o.counts ?? [1, 10, 50]).join("|"), "-spineMcpPerfModes", (o.modes ?? ["single", "threaded"]).join("|"),
        "-spineMcpPerfAnimations", animations.join("|"), ...(o.skin ? ["-spineMcpPerfSkin", o.skin] : [])];
      try { await runFile(exe, args, { timeout: 20 * 60_000 }); } catch (e) { if (!existsSync(out)) throw new UserError(`The perf player failed: ${(e as Error).message.split("\n")[0]}`); }
      if (!existsSync(out)) throw new UserError("The perf player wrote no report.");
      const raw = JSON.parse(readFileSync(out, "utf8")) as PerfRawReport;
      raw.skin = o.skin ?? "default";
      raw.skins = (doc.skins ?? []).map((k) => k.name).filter((n) => n !== "default");
      raw.budget = Object.fromEntries(animations.map((a) => { const m = budget.animations.find((x) => x.name === a)?.max; return [a, { vertexTransforms: m?.vertexTransforms ?? 0, clippedTriangles: m?.clippedTriangles ?? 0, drawCalls: m?.drawCalls ?? 0 }]; }));
      return raw;
    } finally {
      removeQuiet(dir);
      removeQuiet(out);
    }
  });
}

