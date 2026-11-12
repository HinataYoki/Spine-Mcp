import { execFileSync } from "../platform.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "./project.js";
import { run } from "./showcase.js";

export interface VideoInfo {
  width: number;
  height: number;
  /** Average frame rate (frames / duration). */
  fps: number;
  /** Declared (container) frame rate; differs from fps for variable frame rate files. */
  declaredFps: number;
  duration: number;
  codec: string;
  pixFmt: string;
  frames: number | null;
  audio: { codec: string; sampleRate: number; channels: number; duration: number } | null;
}

export interface Crop { x: number; y: number; width: number; height: number }

export interface DecodedVideo {
  /** Analysis rate: every index k below is frame k of the clip resampled to this constant rate from `start`. */
  fps: number;
  start: number;
  grey: Uint8Array[];
  greyW: number;
  greyH: number;
  rgb: Uint8Array[];
  rgbW: number;
  rgbH: number;
  /** Mono 8 kHz audio for the same span, or null. */
  pcm: Int16Array | null;
  pcmRate: number;
}

const rate = (r: string) => { const [a, b] = r.split("/").map(Number); return b ? a! / b : a!; };

export function probeVideo(video: string): VideoInfo {
  if (!existsSync(video)) throw new UserError(`video not found: ${video}`);
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,pix_fmt,nb_frames,sample_rate,channels,duration:format=duration", "-of", "json", video], { encoding: "utf8" });
  const j = JSON.parse(out) as { streams: Record<string, string | number>[]; format: { duration?: string } };
  const v = j.streams.find((s) => s.codec_type === "video");
  if (!v) throw new UserError(`No video stream in ${video}`);
  const a = j.streams.find((s) => s.codec_type === "audio");
  const duration = Number(j.format.duration) || Number(v.duration) || 0;
  return {
    width: Number(v.width), height: Number(v.height),
    fps: +(rate(String(v.avg_frame_rate)) || rate(String(v.r_frame_rate)) || 30).toFixed(3),
    declaredFps: +(rate(String(v.r_frame_rate)) || 0).toFixed(3),
    duration: +duration.toFixed(3), codec: String(v.codec_name), pixFmt: String(v.pix_fmt ?? ""),
    frames: v.nb_frames ? Number(v.nb_frames) : null,
    audio: a ? { codec: String(a.codec_name), sampleRate: Number(a.sample_rate), channels: Number(a.channels), duration: +(Number(a.duration) || duration).toFixed(3) } : null,
  };
}

const STANDARD = [12, 15, 24, 25, 30, 48, 50, 60];
/** The analysis rate: the given one, else the video's rate snapped to a standard rate within 5% (variable frame rate captures average to odd rates). */
export function analysisFps(info: VideoInfo, wanted?: number): number {
  if (wanted) return Math.min(120, Math.round(wanted));
  const snapped = STANDARD.find((r) => Math.abs(info.fps - r) / r <= 0.05);
  return Math.min(120, Math.round(snapped ?? info.fps));
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * One ffmpeg pass over [start, end): constant-rate small grey frames (motion), small colour frames (light, colour,
 * transitions) and mono 8 kHz audio. Frame k is index k after the fps filter: the numbering every tool shares.
 */
export function decodeVideo(video: string, info: VideoInfo, o: { fps: number; start?: number; end?: number; crop?: Crop; work: string; greyW?: number; rgbW?: number; audio?: boolean }): DecodedVideo {
  const start = o.start ?? 0, end = o.end ?? info.duration;
  if (!(end > start)) throw new UserError("end must be after start");
  const srcW = o.crop?.width ?? info.width, srcH = o.crop?.height ?? info.height;
  if (o.crop && (o.crop.x < 0 || o.crop.y < 0 || o.crop.x + o.crop.width > info.width || o.crop.y + o.crop.height > info.height)) throw new UserError(`crop lies outside the ${info.width}x${info.height} video`);
  const gw = o.greyW ?? 160, gh = even((srcH * gw) / srcW);
  const cw = o.rgbW ?? 96, ch = even((srcH * cw) / srcW);
  const crop = o.crop ? `crop=${o.crop.width}:${o.crop.height}:${o.crop.x}:${o.crop.y},` : "";
  const greyFile = join(o.work, "grey.raw"), rgbFile = join(o.work, "rgb.raw"), pcmFile = join(o.work, "pcm.raw");
  const withAudio = o.audio !== false && !!info.audio;
  // No -to without an end: it can cut the last frame.
  run("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(start), ...(o.end !== undefined ? ["-to", String(end)] : []), "-i", video,
    "-filter_complex", `[0:v]fps=${o.fps},${crop}split=2[a][b];[a]scale=${gw}:${gh}:flags=area,format=gray[g];[b]scale=${cw}:${ch}:flags=area,format=rgb24[c]`,
    "-map", "[g]", "-f", "rawvideo", greyFile, "-map", "[c]", "-f", "rawvideo", rgbFile,
    ...(withAudio ? ["-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "s16le", pcmFile] : [])]);
  const g = readFileSync(greyFile), c = readFileSync(rgbFile);
  const n = Math.min(Math.floor(g.length / (gw * gh)), Math.floor(c.length / (cw * ch * 3)));
  const pcmBuf = withAudio && existsSync(pcmFile) ? readFileSync(pcmFile) : null;
  return {
    fps: o.fps, start,
    grey: Array.from({ length: n }, (_, k) => g.subarray(k * gw * gh, (k + 1) * gw * gh)), greyW: gw, greyH: gh,
    rgb: Array.from({ length: n }, (_, k) => c.subarray(k * cw * ch * 3, (k + 1) * cw * ch * 3)), rgbW: cw, rgbH: ch,
    pcm: pcmBuf ? new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, Math.floor(pcmBuf.length / 2)) : null, pcmRate: 8000,
  };
}

/** Mean absolute change between consecutive frames (0-1), no smoothing: repeats stay visible. */
export function rawMotion(frames: Uint8Array[]): number[] {
  const e = frames.map((f, k) => {
    if (k === 0) return 0;
    const p = frames[k - 1]!;
    let s = 0;
    for (let i = 0; i < f.length; i++) s += Math.abs(f[i]! - p[i]!);
    return s / f.length / 255;
  });
  if (e.length > 1) e[0] = e[1]!;
  return e;
}

export const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };

/** Repeats (frames that show the same image again) by two clusters of motion values, then the hold pattern. */
export function holdPattern(motion: number[], from: number, to: number) {
  const idx: number[] = [];
  for (let k = from + 1; k <= to; k++) idx.push(k);
  const v = idx.map((k) => motion[k]!);
  if (v.length < 4) return { hold: null as number | null, consistency: 0, repeats: new Set<number>(), changes: idx };
  // Still only when even the moving frames barely change (repeats alone pull the median to zero).
  const sortedV = [...v].sort((a, b) => a - b);
  if (sortedV[Math.floor(sortedV.length * 0.9)]! < 0.0008) return { hold: null, consistency: 0, repeats: new Set(idx), changes: [] };
  const x = v.map((m) => Math.log(m + 1e-5));
  let lo = Math.min(...x), hi = Math.max(...x);
  for (let it = 0; it < 20; it++) {
    const mid = (lo + hi) / 2;
    const a = x.filter((t) => t <= mid), b = x.filter((t) => t > mid);
    if (!a.length || !b.length) break;
    lo = a.reduce((s, t) => s + t, 0) / a.length; hi = b.reduce((s, t) => s + t, 0) / b.length;
  }
  const mid = (lo + hi) / 2;
  const lowShare = x.filter((t) => t <= mid).length / x.length;
  // Repeats only when the two groups are far apart (a compressed repeat is never exactly zero).
  const separated = Math.exp(hi - lo) > 6 && lowShare >= 0.2 && lowShare <= 0.95;
  const repeats = new Set(separated ? idx.filter((_, i) => x[i]! <= mid) : []);
  const changes = idx.filter((k) => !repeats.has(k));
  if (!separated) return { hold: 1, consistency: 1, repeats, changes };
  const runs = changes.slice(1).map((k, i) => k - changes[i]!);
  const counts = new Map<number, number>();
  for (const r of runs) counts.set(r, (counts.get(r) ?? 0) + 1);
  const [mode, c] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [1, 0];
  return { hold: mode, consistency: runs.length ? +(c / runs.length).toFixed(2) : 0, repeats, changes };
}

