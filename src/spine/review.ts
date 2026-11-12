import { execFileSync, removeQuiet } from "../platform.js";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import type { Config } from "../config.js";
import type { SpineCli } from "./cli.js";
import { loadProject, pickSkeleton, pruneDir, UserError } from "./project.js";
import { projectImagesDir, renderFrames, type RenderResult } from "./render.js";
import { FONT_CANDIDATES, need, run } from "./showcase.js";

export interface ReviewOptions {
  project: string;
  skeleton?: string;
  /** 1-6 animations, one after another. */
  animations: string[];
  /** Playback speeds per animation, in order (default [1, 0.5]: real time, then half speed). */
  speeds?: number[];
  /** Times each animation plays per speed (default 1). */
  loops?: number;
  /** Render rate (default: the project's dopesheet fps, else 30). */
  fps?: number;
  /** Render scale in percent (default 50). */
  scale?: number;
  skin?: string;
  /** Opaque background (default #808080, neutral for judging values). */
  background?: string;
  /** Audio laid under every real-time pass from the animation's start (slow passes stay silent). */
  audio?: string;
  /** Seconds into the audio file that line up with the animation's frame 0 (default 0). */
  audioOffset?: number;
  /** A one-second title card first (e.g. "Hero idle v3 · 2026-10-17"). */
  title?: string;
  output: string;
  overwrite?: boolean;
}

export interface ReviewSegment { animation: string; speed: number; start: number; end: number; frames: number }

export interface ReviewResult {
  output: string;
  bytes: number;
  seconds: number;
  fps: number;
  size: { width: number; height: number };
  audio: boolean;
  segments: ReviewSegment[];
  notes: string[];
  previewPng: Buffer;
}

const HEADER = 40;
const even = (n: number) => n + (n % 2);
/** ImageMagick reads %, @ and \ in -annotate text as escapes. */
const escapeText = (t: string) => t.replace(/\\/g, "\\\\").replace(/%/g, "%%").replace(/^@/, "\\@");

/**
 * A review cut like an animation lead wants it: every frame from Spine's own renderer, labelled with animation, speed,
 * frame and time, each animation in real time and then slowed down, optional audio under the real-time passes, H.264.
 */
export async function makeReview(config: Config, cli: SpineCli, o: ReviewOptions): Promise<ReviewResult> {
  if (!isAbsolute(o.output) || extname(o.output).toLowerCase() !== ".mp4") throw new UserError(`output must be an absolute path ending in .mp4: ${o.output}`);
  if (existsSync(o.output) && !o.overwrite) throw new UserError(`${o.output} already exists. Pass overwrite: true to replace it.`);
  if (!o.animations.length || o.animations.length > 6) throw new UserError("animations: give 1 to 6");
  const speeds = o.speeds?.length ? o.speeds : [1, 0.5];
  if (speeds.some((s) => !(s > 0 && s <= 4))) throw new UserError("speeds must be between 0 (exclusive) and 4");
  if (o.audio && (!isAbsolute(o.audio) || !existsSync(o.audio))) throw new UserError(`audio must be an absolute path to an existing file: ${o.audio}`);
  const background = o.background ?? "#808080";
  if (!/^#[0-9a-fA-F]{6}$/.test(background)) throw new UserError("background must be a hex colour like #808080");
  need("magick", "review frames");
  need("ffmpeg", "review encoding");
  const font = FONT_CANDIDATES.find((f) => existsSync(f));

  const loaded = await loadProject(config, cli, o.project);
  const sk = pickSkeleton(loaded, o.skeleton);
  for (const a of o.animations) if (!sk.doc.animations?.[a]) throw new UserError(`Animation "${a}" not found in skeleton "${sk.name}"`);
  const fps = o.fps ?? (sk.doc.skeleton.fps || 30);
  const loops = Math.max(1, Math.min(8, o.loops ?? 1));
  const renders: RenderResult[] = [];
  for (const a of o.animations) renders.push(await renderFrames(config, cli, o.project, { skeleton: sk.name, animation: a, fps, scale: o.scale ?? 50, skin: o.skin, background: `${background.slice(1)}ff`, cache: { imagesDir: projectImagesDir(o.project, sk.doc) } }));

  const root = join(config.workDir, "review");
  pruneDir(root, 6);
  const work = join(root, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(work, { recursive: true });
  try {
    const dims = renders.map((r) => execFileSync("magick", ["identify", "-format", "%w %h", r.frames[0]!], { encoding: "utf8" }).split(" ").map(Number));
    const w = even(Math.max(480, ...dims.map((d) => d[0]!))), h = even(Math.max(...dims.map((d) => d[1]!)) + HEADER);
    const fontArgs = font ? ["-font", font] : [];

    // Every output frame is one source frame, padded to a common size (feet on the floor) under a label strip.
    type Job = { src: string; text: string };
    const jobs: Job[] = [];
    const segments: ReviewSegment[] = [];
    if (o.title) jobs.push(...Array.from({ length: Math.round(fps) }, () => ({ src: "", text: o.title! })));
    o.animations.forEach((a, i) => {
      const frames = renders[i]!.frames;
      const n = frames.length;
      for (const speed of speeds) {
        const start = jobs.length / fps;
        const out = Math.ceil(n / speed);
        for (let loop = 0; loop < loops; loop++) {
          for (let j = 0; j < out; j++) {
            const k = Math.min(n - 1, Math.floor(j * speed));
            jobs.push({ src: frames[k]!, text: `${a}   ${speed === 1 ? "real time" : `${speed}x`}   frame ${k + 1}/${n}   ${(k / fps).toFixed(2)}s` });
          }
        }
        segments.push({ animation: a, speed, start: +start.toFixed(3), end: +(jobs.length / fps).toFixed(3), frames: out * loops });
      }
    });
    const ink = "#ffffff", strip = "#1d1f33";
    for (let c = 0; c < jobs.length; c += 40) {
      const args: string[] = [];
      jobs.slice(c, c + 40).forEach((job, i) => {
        const outFile = join(work, `f_${String(c + i).padStart(5, "0")}.png`);
        if (!job.src) {
          args.push("(", "-size", `${w}x${h}`, `xc:${strip}`, ...fontArgs, "-fill", ink, "-pointsize", "28", "-gravity", "center", "-annotate", "+0+0", escapeText(job.text), "-write", outFile, ")", "+delete");
        } else {
          args.push("(", job.src, "-background", background, "-gravity", "south", "-extent", `${w}x${h - HEADER}`, "-background", strip, "-gravity", "north", "-splice", `0x${HEADER}`,
            ...fontArgs, "-fill", ink, "-pointsize", "18", "-gravity", "northwest", "-annotate", "+14+10", escapeText(job.text), "-write", outFile, ")", "+delete");
        }
      });
      args.push("-size", "1x1", "xc:none", "null:");
      run("magick", args);
    }

    // Audio: the file under each real-time pass, from the animation's start; slow passes silent.
    const audioArgs: string[] = [];
    let filter = "";
    if (o.audio) {
      const parts: string[] = [];
      segments.forEach((s, i) => {
        if (s.speed !== 1) return;
        const dur = (s.end - s.start) / loops;
        for (let loop = 0; loop < loops; loop++) {
          const at = Math.round((s.start + loop * dur) * 1000);
          parts.push(`[a${i}_${loop}]`);
          filter += `[1:a]atrim=start=${o.audioOffset ?? 0}:duration=${dur.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${at}|${at}[a${i}_${loop}];`;
        }
      });
      if (parts.length) {
        // Padded to the exact video length (apad + -shortest stalls ffmpeg 7+).
        filter += `${parts.join("")}amix=inputs=${parts.length}:normalize=0,apad=whole_dur=${(jobs.length / fps).toFixed(3)}[aout]`;
        audioArgs.push("-i", o.audio, "-filter_complex", filter, "-map", "0:v", "-map", "[aout]", "-c:a", "aac", "-b:a", "160k");
      }
    }
    mkdirSync(join(o.output, ".."), { recursive: true });
    run("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(work, "f_%05d.png"), ...audioArgs,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium", "-movflags", "+faststart", o.output]);
    const previewIdx = Math.min(jobs.length - 1, Math.round((segments[0]!.start + segments[0]!.end) / 2 * fps));
    const preview = readFileSync(join(work, `f_${String(previewIdx).padStart(5, "0")}.png`));
    return {
      output: o.output, bytes: statSync(o.output).size, seconds: +(jobs.length / fps).toFixed(3), fps, size: { width: w, height: h },
      audio: audioArgs.length > 0, segments,
      notes: [
        `Rendered by Spine at ${fps} fps, ${o.scale ?? 50}%; slow passes repeat frames (no in-betweens are invented). Labels: animation, speed, frame, time.`,
        ...(o.audio ? ["Audio plays under each real-time pass from the animation's frame 0 (plus audioOffset); slow passes are silent so sync is judged at real speed."] : []),
        "Headless Spine renders have no physics warm-up: physics parts can settle during the first loop (use loops: 2, or bake the physics).",
      ],
      previewPng: preview,
    };
  } finally {
    removeQuiet(work);
  }
}
