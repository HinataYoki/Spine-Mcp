import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { PNG } from "pngjs";
import type { Config } from "../config.js";
import { cliFailed, type CliResult, type SpineCli } from "./cli.js";
import { pruneDir, UserError } from "./project.js";
import type { SkeletonJson } from "./types.js";
import { isLockError, removeQuiet, retryLocked } from "../platform.js";

export interface RenderOptions {
  skeleton: string;
  animation: string;
  fps?: number;
  /** Percent, as in Spine's export dialog (100 = 1:1). */
  scale?: number;
  skin?: string;
  /** Opaque background as RRGGBBAA hex (default transparent). */
  background?: string;
  /**
   * Reuse an earlier render with the same fingerprint (project bytes, image files, settings, editor version). Only for
   * user-facing previews: verification renders on copies whose images change between calls leave it off.
   */
  cache?: { imagesDir: string | null; refresh?: boolean };
}

export interface RenderResult {
  dir: string;
  frames: string[];
  cli: CliResult;
  /** True when the frames came from the render cache (no CLI call). */
  cached?: boolean;
}

/** The skeleton's images folder as Spine resolves it (relative to the project), or null when there is none on disk. */
export function projectImagesDir(project: string, doc: SkeletonJson): string | null {
  const dir = resolve(dirname(project), doc.skeleton.images ?? "./images/");
  return existsSync(dir) && statSync(dir).isDirectory() ? dir : null;
}

/** Bump when the render recipe changes so old cache entries stop matching. */
const RECIPE = 1;

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : e.isFile() ? [p] : [];
  });
}

/** Fingerprint of everything a render depends on: project bytes, each image file (path, size, mtime), settings, editor. */
export function renderFingerprint(project: string, imagesDir: string, settings: unknown, spineVersion: string): string {
  const h = createHash("sha256").update(`${RECIPE}|${spineVersion}|${JSON.stringify(settings)}|`).update(readFileSync(project));
  for (const f of filesUnder(imagesDir).sort()) {
    const st = statSync(f);
    h.update(`|${relative(imagesDir, f)}:${st.size}:${st.mtimeMs}`);
  }
  return h.digest("hex").slice(0, 16);
}

const MARKER = "render.json";
let tmpSeq = 0;
const cachedCli = (): CliResult => ({ command: [], exitCode: 0, seconds: 0, lines: [], warnings: [], errors: [], timedOut: false, raw: "" });

/**
 * Renders animation frames with Spine's own renderer (`export-png`). Headless renders have no MSAA and no physics
 * warm-up (GOTCHAS G10), so use them for checking, not for final video.
 */
/** libGDX Color as Spine's export settings serialize it. */
const hexToGdxColor = (hex: string) => {
  const v = hex.replace("#", "").padEnd(8, "f");
  const [r, g, b, a] = [0, 2, 4, 6].map((i) => +(parseInt(v.slice(i, i + 2), 16) / 255).toFixed(4));
  return { r, g, b, a };
};

export async function renderFrames(config: Config, cli: SpineCli, project: string, o: RenderOptions): Promise<RenderResult> {
  const rendersDir = join(config.workDir, "renders");
  pruneDir(rendersDir, 40);
  const safeAnim = o.animation.replace(/[^\w.-]+/g, "_");
  const settings = {
    class: "export-png", exportType: "animation", skeletonType: "single", skeleton: o.skeleton,
    animationType: "single", animation: o.animation,
    skinType: o.skin ? "single" : "current", skinNone: false, skin: o.skin ?? null,
    maxBounds: true, renderImages: true, renderBones: false, renderOthers: false,
    scale: o.scale ?? 50, fitWidth: 0, fitHeight: 0, enlarge: false, background: o.background ? hexToGdxColor(o.background) : null,
    fps: o.fps ?? 30, lastFrame: false, cropWidth: 0, cropHeight: 0, rangeStart: -1, rangeEnd: -1,
    packAtlas: null, pad: false, msaa: 4, smoothing: 8, renderSelection: false, open: false,
  };
  const listFrames = (d: string) => readdirSync(d).filter((f) => /^frame.*\.png$/.test(f)).sort().map((f) => join(d, f));

  const fp = o.cache?.imagesDir ? renderFingerprint(project, o.cache.imagesDir, settings, config.spineVersion) : null;
  const dir = join(rendersDir, `${basename(project, ".spine")}-${safeAnim}-${fp ? `c${fp}` : new Date().toISOString().replace(/[:.]/g, "-")}`);
  /** The frames of a complete cache entry, or null (missing or damaged: render again). */
  const entry = (): string[] | null => {
    try {
      const frames = listFrames(dir);
      return frames.length && frames.length === (JSON.parse(readFileSync(join(dir, MARKER), "utf8")) as { frames: number }).frames ? frames : null;
    } catch {
      return null;
    }
  };
  const hit = fp && !o.cache?.refresh ? entry() : null;
  if (hit) {
    const now = new Date();
    utimesSync(dir, now, now); // keeps pruning least-recently-used
    return { dir, frames: hit, cli: cachedCli(), cached: true };
  }

  // Render into a temp folder and move it into place only when complete, so a partial render is never a cache hit.
  const work = fp ? `${dir}.tmp-${process.pid}-${Date.now()}-${++tmpSeq}` : dir;
  mkdirSync(work, { recursive: true });
  const settingsPath = join(work, "export-png.json");
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  // For image export -o is a file prefix, not a folder (GOTCHAS G03).
  const result = await cli.run(["-i", project, "-o", join(work, "frame"), "-e", settingsPath]);
  let frames = listFrames(work);
  if (cliFailed(result) || frames.length === 0) {
    if (fp) rmSync(work, { recursive: true, force: true });
    throw new UserError(`PNG render failed (exit ${result.exitCode}, ${frames.length} frames): ${[...result.errors, ...result.lines.slice(-3)].join(" | ")}`);
  }
  const raced = fp && !o.cache?.refresh ? entry() : null;
  if (raced) {
    // An identical render running in parallel finished first: keep its frames (a caller may be reading them).
    rmSync(work, { recursive: true, force: true });
    return { dir, frames: raced, cli: result, cached: false };
  }
  if (fp) {
    writeFileSync(join(work, MARKER), JSON.stringify({ project, fingerprint: fp, frames: frames.length }));
    try {
      retryLocked(() => { rmSync(dir, { recursive: true, force: true }); renameSync(work, dir); });
      frames = listFrames(dir);
    } catch (e) {
      // Windows: the folder is held for a moment (a reader, antivirus): use a complete entry if there is one, else
      // these frames where they are (not cached this time).
      if (!isLockError(e) && !["ENOTEMPTY", "EEXIST"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
      const done = entry();
      if (done) { removeQuiet(work); return { dir, frames: done, cli: result, cached: false }; }
      return { dir: work, frames, cli: result, cached: false };
    }
  }
  return { dir, frames, cli: result, ...(fp ? { cached: false } : {}) };
}

export interface ContactSheetOptions {
  columns?: number;
  maxFrames?: number;
  /** Max cell edge in pixels; frames are downscaled to fit. */
  cell?: number;
  background?: [number, number, number];
}

/** Evenly picks frames and tiles them row-major into one PNG; `picked` holds the frame indices shown. */
export function contactSheet(framePaths: string[], o: ContactSheetOptions = {}): { png: Buffer; picked: number[]; columns: number } {
  const { maxFrames = 12, cell = 256, background = [235, 235, 235] } = o;
  const picked = pickEven(framePaths.length, maxFrames);
  const images = picked.map((i) => PNG.sync.read(readFileSync(framePaths[i]!)));
  const columns = o.columns ?? Math.min(picked.length, Math.ceil(Math.sqrt(picked.length * 1.5)));
  const rows = Math.ceil(picked.length / columns);
  const srcW = Math.max(...images.map((im) => im.width));
  const srcH = Math.max(...images.map((im) => im.height));
  const k = Math.min(1, cell / Math.max(srcW, srcH));
  const cw = Math.max(1, Math.round(srcW * k));
  const ch = Math.max(1, Math.round(srcH * k));
  const gap = 4;
  const out = new PNG({ width: columns * cw + (columns + 1) * gap, height: rows * ch + (rows + 1) * gap });
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = background[0]; out.data[i + 1] = background[1]; out.data[i + 2] = background[2]; out.data[i + 3] = 255;
  }
  images.forEach((im, n) => {
    const ox = gap + (n % columns) * (cw + gap);
    const oy = gap + Math.floor(n / columns) * (ch + gap);
    // Cell backdrop slightly lighter than the sheet so frame edges are visible.
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) blend(out, ox + x, oy + y, [250, 250, 250, 255]);
    // Box-filter downscale with alpha compositing over the cell backdrop.
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const sx0 = Math.floor(x / k), sy0 = Math.floor(y / k);
        const sx1 = Math.min(im.width, Math.max(sx0 + 1, Math.floor((x + 1) / k)));
        const sy1 = Math.min(im.height, Math.max(sy0 + 1, Math.floor((y + 1) / k)));
        let r = 0, g = 0, b = 0, a = 0, cnt = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          for (let sx = sx0; sx < sx1; sx++) {
            if (sx >= im.width || sy >= im.height) continue;
            const p = (sy * im.width + sx) * 4;
            const pa = im.data[p + 3]! / 255;
            r += im.data[p]! * pa; g += im.data[p + 1]! * pa; b += im.data[p + 2]! * pa; a += pa; cnt++;
          }
        }
        if (cnt && a > 0) blend(out, ox + x, oy + y, [r / a, g / a, b / a, (a / cnt) * 255]);
      }
    }
  });
  return { png: PNG.sync.write(out), picked, columns };
}

function blend(img: PNG, x: number, y: number, [r, g, b, a]: [number, number, number, number]) {
  const p = (y * img.width + x) * 4;
  const t = a / 255;
  img.data[p] = Math.round(r * t + img.data[p]! * (1 - t));
  img.data[p + 1] = Math.round(g * t + img.data[p + 1]! * (1 - t));
  img.data[p + 2] = Math.round(b * t + img.data[p + 2]! * (1 - t));
  img.data[p + 3] = 255;
}

export function pickEven(count: number, max: number): number[] {
  if (count <= max) return [...Array(count).keys()];
  if (max <= 1) return [0];
  return [...Array(max).keys()].map((i) => Math.round((i * (count - 1)) / (max - 1)));
}
