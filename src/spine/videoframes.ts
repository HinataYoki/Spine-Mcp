import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Config } from "../config.js";
import { pruneDir, UserError } from "./project.js";
import { FONT_CANDIDATES, need, run } from "./showcase.js";
import { analysisFps, decodeVideo, probeVideo, rawMotion, type Crop } from "./videodecode.js";
import { extractFrames } from "./videoinspect.js";
import { removeQuiet } from "../platform.js";

export interface VideoFramesOptions {
  video: string;
  /** Exact frames (indices on the constant-rate stream, as spine_video_inspect numbers them). */
  frames?: number[];
  /** A run of frames, every `step` (default 1). */
  range?: { from: number; to: number; step?: number };
  start?: number;
  end?: number;
  fps?: number;
  crop?: Crop;
  /** frames: the frames; diff: changed pixels against the previous frame in red; onion: all of them blended into one. */
  mode?: "frames" | "diff" | "onion";
  /** Tile width in px (default 320). */
  width?: number;
  columns?: number;
}

export interface VideoFramesResult {
  fps: number;
  start: number;
  frames: { frame: number; time: number; motion: number; light: number; clipped: number; changed: number }[];
  mode: "frames" | "diff" | "onion";
  notes: string[];
  png: Buffer;
}

const MAX = 48;

/** Exact frames of a video, labelled with frame number, time and what changed: the step-through of a breakdown, as a sheet. */
export async function videoFrames(config: Config, o: VideoFramesOptions): Promise<VideoFramesResult> {
  if (!isAbsolute(o.video) || !existsSync(o.video)) throw new UserError(`video must be an absolute path to an existing file: ${o.video}`);
  need("ffmpeg", "frame extraction");
  need("magick", "frame sheets");
  const info = probeVideo(o.video);
  const fps = analysisFps(info, o.fps);
  const start = o.start ?? 0;
  let wanted = o.frames ?? [];
  if (o.range) {
    const step = Math.max(1, o.range.step ?? 1);
    for (let k = o.range.from; k <= o.range.to && wanted.length <= MAX; k += step) wanted.push(k);
  }
  wanted = [...new Set(wanted.filter((k) => Number.isInteger(k) && k >= 0))].sort((a, b) => a - b);
  if (!wanted.length) throw new UserError("Give frames or range (frame indices from spine_video_inspect).");
  const truncated = wanted.length > MAX;
  wanted = wanted.slice(0, MAX);
  const mode = o.mode ?? "frames";
  const root = join(config.workDir, "video");
  pruneDir(root, 6);
  const work = join(root, `frames-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(work, { recursive: true });
  try {
    // Numbers from the same decode spine_video_inspect uses, so frame k here is frame k there.
    const d = decodeVideo(o.video, info, { fps, start: o.start, end: o.end, crop: o.crop, work, audio: false });
    const n = d.grey.length;
    const missing = wanted.filter((k) => k >= n);
    if (missing.length === wanted.length) throw new UserError(`The analysed span has ${n} frames (0-${n - 1}); asked for ${missing.slice(0, 5).join(", ")}.`);
    wanted = wanted.filter((k) => k < n);
    const motion = rawMotion(d.grey);
    const meta = wanted.map((k) => {
      const g = d.grey[k]!, p = d.grey[Math.max(0, k - 1)]!;
      let s = 0, c = 0, ch = 0;
      for (let i = 0; i < g.length; i++) { s += g[i]!; if (g[i]! >= 245) c++; if (Math.abs(g[i]! - p[i]!) > 20) ch++; }
      return { frame: k, time: +(k / fps).toFixed(3), motion: +motion[k]!.toFixed(4), light: +(s / g.length / 255).toFixed(3), clipped: +(c / g.length).toFixed(3), changed: k ? +(ch / g.length).toFixed(4) : 0 };
    });
    const width = o.width ?? 320;
    const files = extractFrames(o.video, { fps, start, end: o.end, crop: o.crop, frames: wanted, width, out: work, prefix: "f" });
    if (files.length !== wanted.length) throw new UserError(`Extracted ${files.length} of ${wanted.length} frames; check the range.`);
    const font = FONT_CANDIDATES.find((f) => existsSync(f));
    const fontArgs = font ? ["-font", font] : [];
    let out: string;
    if (mode === "onion") {
      out = join(work, "onion.png");
      run("magick", [...files, "-evaluate-sequence", "mean", "-background", "#1d1f33", "-fill", "white", ...fontArgs, "-pointsize", "13", "-gravity", "south", "-splice", "0x22", "-annotate", "+0+4",
        `onion of ${files.length} frames: f${wanted[0]}-f${wanted[wanted.length - 1]}`, out]);
    } else {
      let shown = files;
      if (mode === "diff") {
        const prevIdx = wanted.map((k) => Math.max(0, k - 1));
        const prevs = extractFrames(o.video, { fps, start, end: o.end, crop: o.crop, frames: prevIdx, width, out: work, prefix: "p" });
        const byFrame = new Map([...new Set(prevIdx)].sort((a, b) => a - b).map((k, i) => [k, prevs[i]!]));
        shown = files.map((f, i) => {
          const prev = byFrame.get(prevIdx[i]!)!;
          const outFile = join(work, `d_${String(i).padStart(3, "0")}.png`);
          // Pixels that changed since the previous frame, painted red over the frame.
          run("magick", [f, "(", f, prev, "-compose", "difference", "-composite", "-colorspace", "gray", "-threshold", "8%", "-colorspace", "sRGB", "-type", "TrueColor", "-fill", "#ff2a2a", "-opaque", "white", "-transparent", "black", ")", "-compose", "over", "-composite", outFile]);
          return outFile;
        });
      }
      const labelled = shown.map((f, i) => {
        const m = meta[i]!;
        run("magick", [f, "-background", "#1d1f33", "-fill", "white", ...fontArgs, "-pointsize", "13", "-gravity", "south", "-splice", "0x36", "-annotate", "+0+3",
          `f${m.frame}   ${m.time.toFixed(3)}s\nmotion ${m.motion}   light ${m.light}${m.clipped > 0.01 ? `   clip ${(m.clipped * 100).toFixed(0)}%` : ""}`, f]);
        return f;
      });
      out = join(work, "sheet.png");
      run("magick", ["montage", ...fontArgs, ...labelled, "-tile", `${Math.max(1, Math.min(o.columns ?? 6, labelled.length))}x`, "-geometry", "+3+3", "-background", "#ffffff", out]);
    }
    return {
      fps, start, frames: meta, mode,
      notes: [
        `Frame k = frame k of the clip at a constant ${fps} fps from ${start}s (the numbering of spine_video_inspect). motion: change since the previous frame (0 = repeat); light: mean brightness; changed: share of pixels that changed.`,
        ...(mode === "diff" ? ["Red: pixels that changed since the previous frame."] : []),
        ...(truncated ? [`Only the first ${MAX} frames are shown; narrow the range or raise step.`] : []),
        ...(missing.length ? [`Frames past the end skipped: ${missing.slice(0, 5).join(", ")}.`] : []),
      ],
      png: readFileSync(out),
    };
  } finally {
    removeQuiet(work);
  }
}
