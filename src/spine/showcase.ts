import { execFileSync, fontCandidates, removeQuiet } from "../platform.js";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { Config } from "../config.js";
import type { SpineCli } from "./cli.js";
import { loadProject, pickSkeleton, pruneDir, UserError } from "./project.js";
import { projectImagesDir, renderFrames, type RenderResult } from "./render.js";

export interface ShowcaseItem {
  animation: string;
  /** Caption under the cell (default: the animation name; "" hides it). */
  label?: string;
  skin?: string;
}

export interface ShowcaseOptions {
  project: string;
  /** 1-4 animations shown side by side, each looping until the longest one ends. */
  items: ShowcaseItem[];
  /** Absolute output file: .webp (animated, alpha), .gif or .mp4. */
  output: string;
  skeleton?: string;
  /** Output width in px for the whole strip (default 320 per item). */
  width?: number;
  fps?: number;
  /** Render scale in percent (default 50). Every item uses the same scale, so sizes stay comparable. */
  scale?: number;
  /** "transparent" (webp only) or a hex colour (default #F4F5FF). */
  background?: string;
  /** Hold the last frame this many seconds before the loop restarts (webp, gif). */
  hold?: number;
  /** Times to play the longest animation (default 1). */
  loops?: number;
  /** Align cells on the floor (default) or centre them. */
  align?: "bottom" | "center";
  overwrite?: boolean;
}

export interface ShowcaseResult {
  output: string;
  format: "webp" | "gif" | "mp4";
  bytes: number;
  frames: number;
  fps: number;
  seconds: number;
  size: { width: number; height: number };
  items: { animation: string; frames: number }[];
  previewPng: Buffer;
}

export const FONT_CANDIDATES = fontCandidates(true);

const BREW: Record<string, string> = { magick: "imagemagick", img2webp: "webp", ffmpeg: "ffmpeg" };
const WINGET: Record<string, string> = { magick: "winget install ImageMagick.ImageMagick", img2webp: "libwebp from developers.google.com/speed/webp, its bin folder on PATH", ffmpeg: "winget install Gyan.FFmpeg" };
const installHint = (bin: string) => (process.platform === "win32" ? WINGET[bin] : process.platform === "linux" ? `apt install ${BREW[bin]}` : `brew install ${BREW[bin]}`);

export function need(bin: string, why: string) {
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore" });
  } catch {
    throw new UserError(`${bin} is required for ${why} (${installHint(bin)})`);
  }
}

/** Runs an encoder; its own error text becomes the tool error. */
export function run(bin: string, args: string[], cwd?: string) {
  try {
    execFileSync(bin, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024, ...(cwd ? { cwd } : {}) });
  } catch (e) {
    const err = e as { stderr?: Buffer; stdout?: Buffer };
    throw new UserError(`${bin} failed: ${`${err.stderr ?? ""}${err.stdout ?? ""}`.trim().split("\n").slice(-3).join(" | ")}`);
  }
}

const isDark = (hex: string) => {
  const v = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
  return 0.299 * r! + 0.587 * g! + 0.114 * b! < 128;
};

/**
 * Renders 1-4 animations with Spine's own renderer and assembles a README-ready animation: cells side by side at the
 * same scale, labelled, each looping until the longest ends. Only `output` is written; the project is not modified.
 */
export async function makeShowcase(config: Config, cli: SpineCli, o: ShowcaseOptions): Promise<ShowcaseResult> {
  if (!isAbsolute(o.output)) throw new UserError(`output must be an absolute path: ${o.output}`);
  const ext = extname(o.output).toLowerCase().slice(1);
  if (ext !== "webp" && ext !== "gif" && ext !== "mp4") throw new UserError("output must end with .webp, .gif or .mp4");
  const format = ext as "webp" | "gif" | "mp4";
  if (!o.items.length || o.items.length > 4) throw new UserError("items: give 1 to 4 animations");
  if (existsSync(o.output) && !o.overwrite) throw new UserError(`${o.output} already exists. Pass overwrite: true to replace it.`);
  const background = o.background ?? "#F4F5FF";
  const transparent = background === "transparent";
  if (transparent && format !== "webp") throw new UserError("A transparent background needs .webp output (GIF has 1-bit alpha, MP4 none)");
  if (!transparent && !/^#[0-9a-fA-F]{6}$/.test(background)) throw new UserError('background must be "transparent" or a hex colour like #F4F5FF');
  need("magick", "showcase compositing");
  need(format === "webp" ? "img2webp" : "ffmpeg", `${format} encoding`);

  const fps = o.fps ?? 24;
  const loaded = await loadProject(config, cli, o.project);
  const sk = pickSkeleton(loaded, o.skeleton);
  const renders: RenderResult[] = [];
  for (const item of o.items) {
    if (!sk.doc.animations?.[item.animation]) throw new UserError(`Animation "${item.animation}" not found in skeleton "${sk.name}"`);
    renders.push(await renderFrames(config, cli, o.project, { skeleton: sk.name, animation: item.animation, fps, scale: o.scale ?? 50, skin: item.skin, cache: { imagesDir: projectImagesDir(o.project, sk.doc) } }));
  }

  const root = join(config.workDir, "showcase");
  pruneDir(root, 10);
  const work = join(root, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(work, { recursive: true });
  try {
    // Common cell size from the renders (Spine crops each animation to its own max bounds).
    const dims = renders.map((r) => execFileSync("magick", ["identify", "-format", "%w %h", r.frames[0]!], { encoding: "utf8" }).split(" ").map(Number));
    const cellW = Math.max(...dims.map((d) => d[0]!)), cellH = Math.max(...dims.map((d) => d[1]!));
    const font = FONT_CANDIDATES.find((f) => existsSync(f));
    const ink = transparent ? "#3A3F66" : isDark(background) ? "#E8EAFF" : "#2A2F55";
    const labels = o.items.map((item, i) => {
      // A blank label draws none. ImageMagick reads "label:@file" as a file and "%" as an escape: the text stays literal.
      const text = (item.label ?? item.animation).trim();
      if (!text || !font) return null;
      const file = join(work, `label${i}.png`);
      const size = Math.max(14, Math.round(cellW / 14));
      execFileSync("magick", ["-background", "none", "-fill", ink, "-font", font, "-pointsize", String(size), `label:${text.replace(/\\/g, "\\\\").replace(/%/g, "%%").replace(/^@/, "\\@")}`,
        "-gravity", "center", "-extent", `${cellW}x${Math.round(size * 2)}`, file]);
      return file;
    });
    const longest = Math.max(...renders.map((r) => r.frames.length));
    const total = longest * Math.max(1, o.loops ?? 1);
    const gravity = o.align === "center" ? "center" : "south";
    const gap = Math.round(cellW * 0.06);
    const width = o.width ?? 320 * o.items.length;
    const frames: string[] = [];
    for (let k = 0; k < total; k++) {
      const args: string[] = [];
      renders.forEach((r, i) => {
        // Fixed spacers (not -smush, which packs cells through their transparent pixels).
        if (i) args.push("-size", `${gap}x${cellH}`, "xc:none");
        args.push("(", r.frames[k % r.frames.length]!, "-background", "none", "-gravity", gravity, "-extent", `${cellW}x${cellH}`);
        if (labels[i]) args.push(labels[i]!, "-append");
        args.push(")");
      });
      const out = join(work, `f${String(k).padStart(4, "0")}.png`);
      args.push("-background", "none", "-gravity", "north", "+append", "+repage");
      if (!transparent) args.push("-background", background, "-flatten");
      args.push("-resize", `${width}x`, `PNG32:${out}`); // RGBA: img2webp cannot read grey+alpha PNGs
      execFileSync("magick", args);
      frames.push(out);
    }
    if (format === "mp4") {
      // H.264 needs even dimensions.
      const [fw, fh] = execFileSync("magick", ["identify", "-format", "%w %h", frames[0]!], { encoding: "utf8" }).split(" ").map(Number);
      const even = `${fw! + (fw! % 2)}x${fh! + (fh! % 2)}`;
      for (const f of frames) execFileSync("magick", [f, "-background", background, "-gravity", "center", "-extent", even, f]);
    }

    mkdirSync(dirname(o.output), { recursive: true });
    const frameMs = Math.round(1000 / fps);
    if (format === "webp") {
      // Frame names relative to their folder: hundreds of full paths pass Windows' 32k command line limit.
      const names = frames.map((f) => basename(f));
      const tail = o.hold ? ["-d", String(Math.round(o.hold * 1000)), names[names.length - 1]!] : [];
      run("img2webp", ["-loop", "0", "-lossy", "-q", "80", "-m", "4", "-d", String(frameMs), ...(o.hold ? names.slice(0, -1) : names), ...tail, "-o", resolve(o.output)], work);
    } else if (format === "gif") {
      const holdFrames = o.hold ? Math.round(o.hold * fps) : 0;
      const filter = `${holdFrames ? `tpad=stop_mode=clone:stop=${holdFrames},` : ""}split[a][b];[b]palettegen=max_colors=256:stats_mode=full[p];[a][p]paletteuse=dither=bayer:bayer_scale=5`;
      run("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(work, "f%04d.png"), "-filter_complex", filter, "-loop", "0", o.output]);
    } else {
      run("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(work, "f%04d.png"), "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", o.output]);
    }
    const [w, h] = execFileSync("magick", ["identify", "-format", "%w %h", frames[0]!], { encoding: "utf8" }).split(" ").map(Number);
    const preview = frames[Math.floor(frames.length / 2)]!;
    return {
      output: o.output, format, bytes: statSync(o.output).size, frames: frames.length, fps,
      seconds: +(frames.length / fps + (o.hold ?? 0)).toFixed(2), size: { width: w!, height: h! },
      items: o.items.map((it, i) => ({ animation: it.animation, frames: renders[i]!.frames.length })),
      previewPng: readFileSync(preview),
    };
  } finally {
    removeQuiet(work);
  }
}
