import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Config } from "../config.js";
import type { SpineCli } from "./cli.js";
import { pruneDir, UserError } from "./project.js";
import { analyseEnergy, referenceTiming, type TimingComparison } from "./reftiming.js";
import { FONT_CANDIDATES, need, run } from "./showcase.js";
import { analysisFps, decodeVideo, holdPattern, median, probeVideo, rawMotion, type Crop, type DecodedVideo, type VideoInfo } from "./videodecode.js";
import { rasterizeSvg } from "./svgraster.js";
import { removeQuiet } from "../platform.js";

export interface VideoInspectOptions {
  video: string;
  start?: number;
  end?: number;
  /** Region to analyse (the character or the effect, without on-screen counters and UI). */
  crop?: Crop;
  fps?: number;
  /** Compare one segment (or a time range) with a Spine animation: timing, speed, offset. */
  verify?: { project: string; skeleton?: string; animation: string; segment?: number; start?: number; end?: number; crop?: Crop };
  sheet?: boolean;
}

export interface Segment {
  index: number;
  from: number;
  to: number;
  seconds: number;
  /** How the segment starts: the clip start, a hard cut or a gradual transition (fade, slide). */
  startsWith: "start" | "cut" | "transition" | "speed";
  /** Frames each new image stays on screen (1 = on ones, 2 = on twos, 8 = e.g. on twos slowed to 0.25x). */
  holdFrames: number | null;
  holdConsistency: number;
  motion: { mean: number; max: number };
  peaks: number[];
  holds: { from: number; to: number }[];
  /** An image held longer than the segment's pattern (a capture stutter, or a held pose). */
  stutters: number[];
  /** A single step about twice its steady neighbours (a dropped frame, or a pop in the animation). */
  jumps: number[];
}

export interface VideoEvent { frame: number; time: number; kind: "cut" | "transition" | "speed" | "flash" | "black" | "motion-peak" | "audio-onset" | "stutter" | "jump" | "burst"; detail?: string; deltaFrames?: number }

export interface VideoInspectResult {
  video: string;
  info: VideoInfo;
  analysed: { fps: number; start: number; end: number; frames: number; crop?: Crop };
  quality: { ok: boolean; findings: string[] };
  segments: Segment[];
  /** Everything worth stopping on, in order, with the frames since the previous event. */
  events: VideoEvent[];
  audio: { onsets: { frame: number; time: number; nearestVisual?: { frame: number; kind: string; offsetFrames: number } }[] } | null;
  /** Per-frame curves, thinned to about 300 points (`step` frames apart). */
  /** activityCenter has every other point (step x 2 frames apart). */
  curves: { step: number; motion: number[]; luma: number[]; clipped: number[]; activityArea: number[]; activityCenter: [number, number][]; audio?: number[] };
  verify?: TimingComparison & { segment?: number; range: { start: number; end: number } };
  notes: string[];
  png?: Buffer;
}


/** Per-frame light, highlights, colour histogram and the box of changed pixels. */
export function frameMetrics(d: DecodedVideo) {
  const n = d.grey.length;
  const luma: number[] = [], clipped: number[] = [], black: boolean[] = [], area: number[] = [], center: [number, number][] = [], changedShare: number[] = [];
  const hist: Float64Array[] = [];
  for (let k = 0; k < n; k++) {
    const g = d.grey[k]!;
    let s = 0, c = 0, mx = 0;
    for (let i = 0; i < g.length; i++) { s += g[i]!; if (g[i]! >= 245) c++; if (g[i]! > mx) mx = g[i]!; }
    luma.push(s / g.length / 255); clipped.push(c / g.length); black.push(s / g.length < 8 && mx < 40);
    const rgb = d.rgb[k]!, h = new Float64Array(64);
    for (let i = 0; i < rgb.length; i += 3) h[(rgb[i]! >> 6) * 16 + (rgb[i + 1]! >> 6) * 4 + (rgb[i + 2]! >> 6)]! += 1;
    const px = rgb.length / 3;
    for (let i = 0; i < 64; i++) h[i]! /= px;
    hist.push(h);
    if (k === 0) { area.push(0); center.push([0.5, 0.5]); changedShare.push(0); continue; }
    const p = d.grey[k - 1]!;
    let x0 = d.greyW, y0 = d.greyH, x1 = -1, y1 = -1, changed = 0;
    for (let y = 0; y < d.greyH; y++) for (let x = 0; x < d.greyW; x++) {
      const i = y * d.greyW + x;
      if (Math.abs(g[i]! - p[i]!) > 20) { changed++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    changedShare.push(changed / (d.greyW * d.greyH));
    if (changed < 3) { area.push(0); center.push(center[center.length - 1]!); continue; }
    area.push(+(((x1 - x0 + 1) * (y1 - y0 + 1)) / (d.greyW * d.greyH)).toFixed(4));
    center.push([+(((x0 + x1) / 2) / d.greyW).toFixed(3), +(((y0 + y1) / 2) / d.greyH).toFixed(3)]);
  }
  return { luma, clipped, black, area, center, hist, changedShare };
}

const histDist = (a: Float64Array, b: Float64Array) => { let s = 0; for (let i = 0; i < 64; i++) s += Math.abs(a[i]! - b[i]!); return s / 2; };

/** Hard cuts, gradual transitions (fades, slides) and one-frame blips (black or flash frames, not segments). */
export function findBoundaries(n: number, motion: number[], hist: Float64Array[], black: boolean[], fps: number) {
  const step = hist.map((h, k) => (k ? histDist(h, hist[k - 1]!) : 0));
  const medStep = median(step), medMotion = median(motion);
  const cuts: number[] = [];
  for (let k = 1; k < n; k++) {
    const nb = Math.max(step[k - 1] ?? 0, step[k + 1] ?? 0), nm = Math.max(motion[k - 1] ?? 0, motion[k + 1] ?? 0);
    // A cut changes the picture in one frame; colour evidence alone (histogram bins flipping in a fade) is not enough.
    const byColour = step[k]! > Math.max(0.25, 6 * medStep) && step[k]! > 3 * nb && motion[k]! > 0.03 && motion[k]! > 2.5 * nm;
    const byPicture = motion[k]! > Math.max(0.08, 4 * medMotion) && motion[k]! > 3 * nm;
    if (byColour || byPicture) cuts.push(k);
  }
  // A frame that differs from both neighbours and comes back is a blip (black frame, single flash), not two cuts.
  const blips: number[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i]!, b = cuts[i + 1]!;
    // Compression smears the first frame after a flash: compare a couple of frames on.
    const back = Math.min(...[b, b + 1, b + 2].filter((x) => x < n).map((x) => histDist(hist[a - 1]!, hist[x]!)));
    if (b - a <= 3 && a > 0 && b < n && back < 0.2) { blips.push(a); cuts.splice(i, 2); i--; }
  }
  // Several "cuts" a few frames apart are an effect's hit frames or strobing, not scene changes.
  const bursts: { from: number; to: number; frames: number[] }[] = [];
  const gap = Math.max(6, Math.round(fps / 8));
  for (let i = 0; i < cuts.length;) {
    let j = i;
    while (j + 1 < cuts.length && cuts[j + 1]! - cuts[j]! <= gap) j++;
    if (j - i + 1 >= 3) { bursts.push({ from: cuts[i]!, to: cuts[j]!, frames: cuts.slice(i, j + 1) }); cuts.splice(i, j - i + 1); } else i = j + 1;
  }
  // Gradual transitions: the picture's colours move far over a quarter second without any single big step, and stay moved.
  const W = Math.max(4, Math.round(fps * 0.25));
  const transitions: { from: number; to: number }[] = [];
  for (let k = W; k < n - W; k++) {
    if (cuts.some((c) => c > k - W && c <= k) || blips.some((b) => b > k - W - 1 && b <= k + 1)) continue;
    const far = histDist(hist[k]!, hist[k - W]!);
    let sum = 0, big = 0;
    for (let j = k - W + 1; j <= k; j++) { sum += step[j]!; big = Math.max(big, step[j]!); }
    const persists = histDist(hist[Math.min(n - 1, k + W)]!, hist[k - W]!) > 0.25;
    if (far > 0.3 && big < 0.6 * far && sum > 0.6 * far && persists) {
      const last = transitions[transitions.length - 1];
      if (last && k - W <= last.to + 1) last.to = k; else transitions.push({ from: k - W, to: k });
    }
  }
  // The window overhangs the blend on both sides: keep the frames where the colours actually move.
  for (const t of transitions) {
    let mx = 0;
    for (let k = t.from; k <= t.to; k++) mx = Math.max(mx, step[k]!);
    while (t.from < t.to && step[t.from]! < 0.3 * mx) t.from++;
    while (t.to > t.from && step[t.to]! < 0.3 * mx) t.to--;
  }
  const blackFrames = black.map((b, k) => (b ? k : -1)).filter((k) => k >= 0);
  return { cuts, transitions, blips, blackFrames, bursts };
}

/** Where the hold pattern changes for good inside a span (real time -> slowed, without a cut): split points. */
export function speedChanges(motion: number[], from: number, to: number): number[] {
  const hp = holdPattern(motion, from, to);
  if (!hp.repeats.size || hp.changes.length < 8) return [];
  const ch = hp.changes, runs = ch.slice(1).map((k, i) => k - ch[i]!);
  // Pose holds (an image kept for a long time) are acting, not playback speed.
  const med = (a: number[]) => { const short = a.filter((r) => r <= 12); return short.length ? median(short) : median(a); };
  const out: number[] = [];
  for (let i = 3; i + 3 <= runs.length; i++) {
    const before = med(runs.slice(Math.max(0, i - 4), i)), after = med(runs.slice(i, i + 4));
    if (Math.max(before, after) / Math.max(1, Math.min(before, after)) >= 1.5 && Math.abs(before - after) >= 1) {
      const at = ch[i]!;
      // A new speed must last: at least four images and 12 frames on each side.
      if (at - from >= 12 && to - at >= 12 && (!out.length || at - out[out.length - 1]! >= 12)) out.push(at);
      i += 3;
    }
  }
  return out;
}

/** Step of the foreground centroid (grey pixels away from the segment's median background), in grey-frame pixels. */
export function centroidSteps(d: DecodedVideo, from: number, to: number): number[] {
  const len = to - from + 1, px = d.greyW * d.greyH;
  const sample = Array.from({ length: Math.min(31, len) }, (_, i) => d.grey[from + Math.floor((i * (len - 1)) / Math.max(1, Math.min(31, len) - 1))]!);
  const bg = new Uint8Array(px), col = new Array<number>(sample.length);
  for (let i = 0; i < px; i++) { for (let j = 0; j < sample.length; j++) col[j] = sample[j]![i]!; col.sort((a, b) => a - b); bg[i] = col[col.length >> 1]!; }
  const cent: [number, number][] = [];
  for (let k = from; k <= to; k++) {
    const g = d.grey[k]!;
    let sx = 0, sy = 0, c = 0;
    for (let y = 0; y < d.greyH; y++) for (let x = 0; x < d.greyW; x++) { const i = y * d.greyW + x; if (Math.abs(g[i]! - bg[i]!) > 25) { sx += x; sy += y; c++; } }
    cent.push(c > 10 ? [sx / c, sy / c] : cent[cent.length - 1] ?? [0, 0]);
  }
  return cent.map((p, i) => (i ? Math.hypot(p[0] - cent[i - 1]![0], p[1] - cent[i - 1]![1]) : 0));
}

/** Changes spread over the repeats before them, so peaks and holds read the motion rate, not the repeat pattern. */
function spread(motion: number[], from: number, to: number, repeats: Set<number>): number[] {
  const out = motion.slice(from, to + 1);
  let last = from;
  for (let k = from + 1; k <= to; k++) {
    if (repeats.has(k)) continue;
    const len = k - last;
    if (len > 1 && len <= 8) for (let j = last + 1; j <= k; j++) out[j - from] = motion[k]! / len;
    last = k;
  }
  return out;
}

function audioRms(d: DecodedVideo, n: number): number[] | null {
  if (!d.pcm) return null;
  const spf = d.pcmRate / d.fps;
  return Array.from({ length: n }, (_, k) => {
    const a = Math.floor(k * spf), b = Math.min(d.pcm!.length, Math.floor((k + 1) * spf));
    let s = 0;
    for (let i = a; i < b; i++) s += d.pcm![i]! * d.pcm![i]!;
    return b > a ? Math.sqrt(s / (b - a)) / 32768 : 0;
  });
}

function onsets(rms: number[]): number[] {
  const base = median(rms);
  const out: number[] = [];
  for (let k = 1; k < rms.length; k++) {
    const thr = Math.max(0.02, 4 * base);
    if (rms[k]! > thr && rms[k - 1]! <= thr && rms[k]! > 2 * Math.max(1e-6, rms[k - 1]!)) {
      if (!out.length || k - out[out.length - 1]! > 3) out.push(k);
    }
  }
  return out;
}

/** Frames of the normalised stream as PNG files (frame k = index k after the fps filter), labelled or not. */
export function extractFrames(video: string, o: { fps: number; start: number; end?: number; crop?: Crop; frames: number[]; width?: number; out: string; prefix: string }): string[] {
  const sorted = [...new Set(o.frames)].sort((a, b) => a - b);
  if (!sorted.length) return [];
  const crop = o.crop ? `,crop=${o.crop.width}:${o.crop.height}:${o.crop.x}:${o.crop.y}` : "";
  const scale = o.width ? `,scale=${o.width}:-2` : "";
  // Chunks keep the select expression short.
  const files: string[] = [];
  for (let c = 0; c < sorted.length; c += 60) {
    const part = sorted.slice(c, c + 60);
    const expr = part.map((k) => `eq(n\\,${k})`).join("+");
    const pattern = join(o.out, `${o.prefix}${c}_%04d.png`);
    run("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(o.start), ...(o.end ? ["-to", String(o.end)] : []), "-i", video,
      "-vf", `fps=${o.fps}${crop},select='${expr}'${scale}`, "-fps_mode", "passthrough", pattern]);
    const made = readdirSync(o.out).filter((f) => f.startsWith(`${o.prefix}${c}_`)).sort();
    made.forEach((f) => files.push(join(o.out, f)));
  }
  return files;
}

function overviewSvg(r: { n: number; fps: number; motion: number[]; luma: number[]; clipped: number[]; area: number[]; audio: number[] | null; segments: Segment[]; events: VideoEvent[] }, w: number) {
  const rows: [string, number[], string][] = [["motion", r.motion, "#1d1f33"], ["light", r.luma, "#f3a712"], ["clipped whites", r.clipped, "#e4572e"], ["changed area", r.area, "#2e86ab"], ...(r.audio ? [["audio", r.audio, "#17a398"] as [string, number[], string]] : [])];
  const rowH = 70, pad = 110, h = rows.length * rowH + 40;
  const X = (k: number) => pad + ((w - pad - 16) * k) / Math.max(1, r.n - 1);
  const parts = [`<rect width="${w}" height="${h}" fill="#ffffff"/>`];
  r.segments.forEach((s, i) => { if (i % 2) parts.push(`<rect x="${X(s.from)}" y="10" width="${Math.max(1, X(s.to) - X(s.from))}" height="${rows.length * rowH}" fill="#f1f3f9"/>`); });
  rows.forEach(([name, vals, col], i) => {
    const top = 14 + i * rowH, bottom = top + rowH - 16;
    const max = Math.max(1e-6, ...vals);
    parts.push(`<text x="8" y="${top + 14}" font-size="12" fill="#333">${name}</text>`);
    parts.push(`<line x1="${pad}" y1="${bottom}" x2="${w - 16}" y2="${bottom}" stroke="#d8d8e0"/>`);
    const step = Math.max(1, Math.ceil(vals.length / 900));
    let px = X(0), py = bottom - ((bottom - top) * vals[0]!) / max;
    for (let k = step; k < vals.length; k += step) {
      const x = X(k), y = bottom - ((bottom - top) * vals[k]!) / max;
      parts.push(`<line x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${col}" stroke-width="1.5"/>`);
      px = x; py = y;
    }
  });
  const colours: Record<string, string> = { burst: "#ff7a00", cut: "#d81159", transition: "#8e5cd9", speed: "#2e86ab", flash: "#f3a712", black: "#000000", "audio-onset": "#17a398", stutter: "#e4572e", jump: "#e4572e" };
  for (const e of r.events) {
    const c = colours[e.kind];
    if (c) parts.push(`<line x1="${X(e.frame)}" y1="10" x2="${X(e.frame)}" y2="${rows.length * rowH + 4}" stroke="${c}" stroke-width="1"/>`);
  }
  const secs = (r.n - 1) / r.fps, tick = secs > 60 ? 10 : secs > 20 ? 5 : secs > 6 ? 1 : 0.5;
  for (let t = 0; t <= secs + 1e-9; t += tick) parts.push(`<text x="${X(t * r.fps) - 10}" y="${h - 8}" font-size="11" fill="#555">${+t.toFixed(1)}s</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${parts.join("")}</svg>`;
}

/**
 * Frame-by-frame inspection of a video (a showreel, a breakdown, a capture, a render): encoding checks, segments with
 * their hold pattern (on ones, on twos, slowed), cuts and transitions, flashes, black frames, stutters and drops, motion
 * peaks and holds, audio onsets against the picture, per-frame curves, and an overview sheet.
 */
export async function inspectVideo(config: Config, cli: SpineCli, o: VideoInspectOptions): Promise<VideoInspectResult> {
  if (!isAbsolute(o.video) || !existsSync(o.video)) throw new UserError(`video must be an absolute path to an existing file: ${o.video}`);
  need("ffmpeg", "video inspection");
  need("magick", "video contact sheets");
  const info = probeVideo(o.video);
  const fps = analysisFps(info, o.fps);
  const root = join(config.workDir, "video");
  pruneDir(root, 6);
  const work = join(root, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(work, { recursive: true });
  try {
    const d = decodeVideo(o.video, info, { fps, start: o.start, end: o.end, crop: o.crop, work });
    const n = d.grey.length;
    if (n < 4) throw new UserError("Fewer than 4 frames to inspect; check start and end.");
    const motion = rawMotion(d.grey);
    const m = frameMetrics(d);
    const b = findBoundaries(n, motion, m.hist, m.black, fps);

    // Transition extents from a finer colour histogram (coarse bins flip in jumps during a blend).
    const fineHist = (k: number) => {
      const rgb = d.rgb[k]!, h = new Float64Array(512);
      for (let i = 0; i < rgb.length; i += 3) h[(rgb[i]! >> 5) * 64 + (rgb[i + 1]! >> 5) * 8 + (rgb[i + 2]! >> 5)]! += 1;
      const px = rgb.length / 3;
      for (let i = 0; i < 512; i++) h[i]! /= px;
      return h;
    };
    const W = Math.max(4, Math.round(fps * 0.25));
    for (const t of b.transitions) {
      const a = Math.max(1, t.from - W), z = Math.min(n - 1, t.to + W);
      const hs = new Map<number, Float64Array>();
      const H = (k: number) => hs.get(k) ?? hs.set(k, fineHist(k)).get(k)!;
      const steps: number[] = [];
      for (let k = a; k <= z; k++) { let sd = 0; const x = H(k), y = H(k - 1); for (let i = 0; i < 512; i++) sd += Math.abs(x[i]! - y[i]!); steps.push(sd / 2); }
      const mx = Math.max(...steps);
      let f = 0, l = steps.length - 1;
      while (f < l && steps[f]! < 0.35 * mx) f++;
      while (l > f && steps[l]! < 0.35 * mx) l--;
      t.from = a + f; t.to = a + l;
    }
    // Segments between cuts and transitions.
    const starts: { at: number; kind: Segment["startsWith"] }[] = [{ at: 0, kind: "start" as const }, ...b.cuts.map((c) => ({ at: c, kind: "cut" as const })), ...b.transitions.map((t) => ({ at: t.from, kind: "transition" as const }))]
      .filter((s) => s.at < n).sort((x, y) => x.at - y.at).filter((s, i, a) => i === 0 || s.at - a[i - 1]!.at >= 3);
    // Flash and black frames are not part of the picture's rhythm: neutral motion for the hold analysis.
    const holdMotion = [...motion];
    const ignored = new Set<number>();
    for (const k of [...b.blips, ...b.blackFrames, ...b.bursts.flatMap((x) => x.frames)]) for (let j = k - 1; j <= k + 3; j++) if (j >= 0 && j < n) ignored.add(j);
    for (let k = 1; k < n; k++) {
      const prevLight = median(m.luma.slice(Math.max(0, k - 6), k));
      if (m.luma[k]! - prevLight > 0.12) for (let j = k; j <= Math.min(n - 1, k + 3); j++) ignored.add(j);
    }
    for (const k of ignored) holdMotion[k] = Math.max(motion[k - 1] ?? 0, motion[k + 4] ?? 0, 0.01);
    // Speed changes inside each span become segment starts too.
    for (const [i, s] of [...starts].entries()) {
      const to = (starts[i + 1]?.at ?? n) - 1;
      for (const at of speedChanges(holdMotion, s.at, to)) starts.push({ at, kind: "speed" as const });
    }
    starts.sort((x, y) => x.at - y.at);
    // A blend is one segment: speed changes inside or right at the edges of a transition are the blend itself.
    for (let i = starts.length - 1; i >= 0; i--) {
      const st = starts[i]!;
      if (st.kind === "speed" && b.transitions.some((t) => st.at >= t.from - W && st.at <= t.to + W)) starts.splice(i, 1);
    }
    // The picture after a blend starts a segment of its own (unless a cut is already there).
    for (const t of b.transitions) if (!starts.some((st) => Math.abs(st.at - (t.to + 1)) <= 2) && t.to + 1 < n) starts.push({ at: t.to + 1, kind: "transition" as const });
    starts.sort((x, y) => x.at - y.at);
    // Neighbouring spans at the same hold pattern are one segment (a speed split that did not change the speed).
    for (let i = starts.length - 1; i > 0; i--) {
      if (starts[i]!.kind !== "speed") continue;
      const prevTo = starts[i]!.at - 1, prevFrom = starts[i - 1]!.at, nextTo = (starts[i + 1]?.at ?? n) - 1;
      const a = holdPattern(holdMotion, prevFrom, prevTo).hold, c = holdPattern(holdMotion, starts[i]!.at, nextTo).hold;
      if (a === c) starts.splice(i, 1);
    }
    const segments: Segment[] = [];
    const events: VideoEvent[] = [];
    const motionPeaks: number[] = [];
    starts.forEach((s, i) => {
      const from = s.at, to = (starts[i + 1]?.at ?? n) - 1;
      // Inside a transition the picture blends: measure from where it ends.
      const hp = holdPattern(holdMotion, from, to);
      const sm = spread(motion, from, to, hp.repeats);
      const cs = centroidSteps(d, from, to);
      const track = analyseEnergy(sm, fps);
      const changeMotion = hp.changes.map((k) => motion[k]!);
      const stutters: number[] = [], drops: number[] = [];
      if (hp.hold && hp.consistency >= 0.6 && hp.changes.length > 6) {
        for (let j = 1; j < hp.changes.length; j++) {
          const gap = hp.changes[j]! - hp.changes[j - 1]!;
          if (gap > hp.hold && gap < 3 * hp.hold) stutters.push(hp.changes[j - 1]! + hp.hold);
        }
        for (let j = 2; j < hp.changes.length - 2; j++) {
          const k = hp.changes[j]!;
          const around = [changeMotion[j - 2]!, changeMotion[j - 1]!, changeMotion[j + 1]!, changeMotion[j + 2]!];
          const ref = median(around);
          if (ignored.has(k)) continue;
          const ratio = changeMotion[j]! / Math.max(1e-6, ref);
          const steadyMotion = Math.max(...around) < 1.8 * Math.min(...around);
          // Pixel change saturates for big moves; the foreground centroid's step stays linear in the displacement.
          // Compared with the two neighbouring steps (local speed), so accelerating motion still reads ~1.
          const cPrev = cs[hp.changes[j - 1]! - from] ?? 0, cNext = cs[hp.changes[j + 1]! - from] ?? 0, cK = cs[k - from] ?? 0;
          const cLocal = cK / Math.max(1e-6, (cPrev + cNext) / 2);
          const mLocal = changeMotion[j]! / Math.max(1e-6, (changeMotion[j - 1]! + changeMotion[j + 1]!) / 2);
          const neighboursAgree = Math.max(cPrev, cNext) < 2.5 * Math.max(0.1, Math.min(cPrev, cNext));
          // Large changed areas (screen-wide effects, particles) move the centroid on their own: no centroid verdict there.
          const local = m.changedShare[k]! < 0.2;
          if ((ref > 0.002 && ratio > 1.6 && ratio < 3 && steadyMotion) || (local && (cPrev + cNext) / 2 > 0.3 && neighboursAgree && cLocal > 1.7 && cLocal < 2.8 && mLocal > 1.25)) drops.push(k);
        }
      }
      segments.push({
        index: i, from, to, seconds: +((to - from + 1) / fps).toFixed(3), startsWith: s.kind, holdFrames: hp.hold, holdConsistency: hp.consistency,
        motion: { mean: +(motion.slice(from, to + 1).reduce((a, v) => a + v, 0) / (to - from + 1)).toFixed(4), max: +Math.max(...motion.slice(from + 1, to + 1), 0).toFixed(4) },
        peaks: track.peaks.map((p) => p.frame + from).slice(0, 12), holds: track.holds.map((h) => ({ from: h.from + from, to: h.to + from })).slice(0, 6),
        stutters: stutters.slice(0, 8), jumps: drops.slice(0, 8),
      });
      const blend = s.kind === "transition" ? b.transitions.find((t) => t.from === from) : undefined;
      if (s.kind !== "start") events.push({ frame: from, time: 0, kind: s.kind, detail: `segment ${i} starts${s.kind === "speed" ? ` (images now held ${hp.hold} frames)` : blend ? ` (a ${blend.to - blend.from + 1}-frame blend)` : ""}` });
      for (const p of track.peaks.slice(0, 40)) motionPeaks.push(p.frame + from);
      for (const st of stutters.slice(0, 20)) events.push({ frame: st, time: 0, kind: "stutter", detail: `an image held ${(hp.hold ?? 1) + 1}+ frames in a segment on ${hp.hold}s (capture stutter or held pose)` });
      for (const dr of drops.slice(0, 20)) events.push({ frame: dr, time: 0, kind: "jump", detail: "one step about twice its steady neighbours (a dropped frame, or a pop in the animation)" });
    });
    for (const k of b.blackFrames) events.push({ frame: k, time: 0, kind: "black" });
    for (const bu of b.bursts) events.push({ frame: bu.from, time: 0, kind: "burst", detail: `${bu.frames.length} big picture changes in ${bu.to - bu.from + 1} frames (an effect's hit frames, or strobing): ${bu.frames.slice(0, 8).join(", ")}` });
    // Flashes: light jumps well above the last few frames and comes back.
    for (let k = 1; k < n; k++) {
      const prev = median(m.luma.slice(Math.max(0, k - 6), k));
      const prevClip = median(m.clipped.slice(Math.max(0, k - 6), k));
      if ((m.luma[k]! - prev > 0.12 || m.clipped[k]! - prevClip > 0.15) && !m.black[k]) {
        const last = events.filter((e) => e.kind === "flash").pop();
        if (last && k - last.frame < Math.round(fps / 4)) continue;
        let peak = k;
        for (let j = k; j < Math.min(n, k + Math.round(fps / 2)); j++) if (m.luma[j]! > m.luma[peak]!) peak = j;
        events.push({ frame: k, time: 0, kind: "flash", detail: `peak at frame ${peak}, light ${m.luma[peak]!.toFixed(2)}, ${(m.clipped[peak]! * 100).toFixed(0)}% clipped` });
      }
    }
    const rms = audioRms(d, n);
    let audio: VideoInspectResult["audio"] = null;
    if (rms) {
      // Motion peaks live in the segments, not the event list, but sound often lands on them.
      const visual = [...events.filter((e) => e.kind === "cut" || e.kind === "flash" || e.kind === "transition" || e.kind === "burst"), ...motionPeaks.map((f) => ({ frame: f, kind: "motion-peak" }))];
      audio = {
        onsets: onsets(rms).slice(0, 60).map((k) => {
          const near = visual.map((e) => ({ e, d: e.frame - k })).filter((x) => Math.abs(x.d) <= Math.round(fps / 3)).sort((x, y) => Math.abs(x.d) - Math.abs(y.d))[0];
          return { frame: k, time: +(k / fps).toFixed(3), ...(near ? { nearestVisual: { frame: near.e.frame, kind: near.e.kind, offsetFrames: near.d } } : {}) };
        }),
      };
      for (const on of audio.onsets) events.push({ frame: on.frame, time: 0, kind: "audio-onset", ...(on.nearestVisual ? { detail: `${on.nearestVisual.kind} ${on.nearestVisual.offsetFrames >= 0 ? "+" : ""}${on.nearestVisual.offsetFrames} frames` } : {}) });
    }
    events.sort((x, y) => x.frame - y.frame);
    events.forEach((e, i) => { e.time = +(e.frame / fps).toFixed(3); if (i) e.deltaFrames = e.frame - events[i - 1]!.frame; });

    // Encoding and delivery checks.
    const findings: string[] = [];
    if (info.declaredFps && Math.abs(info.declaredFps - info.fps) > 0.5) findings.push(`Variable frame rate: declared ${info.declaredFps} fps, average ${info.fps} fps (analysed at a constant ${fps} fps). Editors and players may drift; re-encode at a constant rate for delivery.`);
    if (!STANDARD_OK(info.fps)) findings.push(`Unusual frame rate ${info.fps} fps.`);
    if (info.pixFmt && info.pixFmt !== "yuv420p") findings.push(`Pixel format ${info.pixFmt}: some players and sites need yuv420p.`);
    if (info.width % 2 || info.height % 2) findings.push(`Odd size ${info.width}x${info.height}: H.264 players expect even sizes.`);
    if (info.audio && Math.abs(info.audio.duration - info.duration) > 1.5 / info.fps) findings.push(`Audio ${info.audio.duration}s vs video ${info.duration}s.`);
    if (b.blackFrames.length && b.blackFrames.length < 6) findings.push(`Black frame(s) at ${b.blackFrames.slice(0, 10).join(", ")}.`);
    const allStutters = segments.flatMap((s) => s.stutters), allDrops = segments.flatMap((s) => s.jumps);
    if (allStutters.length) findings.push(`${allStutters.length} stutter(s) (an image held longer than its segment's pattern): frames ${allStutters.slice(0, 10).join(", ")}.`);
    if (allDrops.length) findings.push(`${allDrops.length} jump(s) (one step about twice its steady neighbours: a dropped frame, or a pop in the animation): frames ${allDrops.slice(0, 10).join(", ")}.`);

    const thin = Math.max(1, Math.ceil(n / 200));
    const pick = <T>(a: T[]) => a.filter((_, k) => k % thin === 0);
    const curves = {
      step: thin, motion: pick(motion).map((v) => +v.toFixed(4)), luma: pick(m.luma).map((v) => +v.toFixed(3)), clipped: pick(m.clipped).map((v) => +v.toFixed(3)),
      activityArea: pick(m.area).map((v) => +v.toFixed(3)), activityCenter: pick(m.center).filter((_, i) => i % 2 === 0).map(([x, y]) => [+x.toFixed(2), +y.toFixed(2)] as [number, number]), ...(rms ? { audio: pick(rms).map((v) => +v.toFixed(3)) } : {}),
    };

    let verify: VideoInspectResult["verify"];
    if (o.verify) {
      const seg = o.verify.segment !== undefined ? segments[o.verify.segment] : undefined;
      if (o.verify.segment !== undefined && !seg) throw new UserError(`No segment ${o.verify.segment}; the video has ${segments.length}.`);
      const base = o.start ?? 0;
      const vs = o.verify.start ?? (seg ? base + seg.from / fps : base), ve = o.verify.end ?? (seg ? base + (seg.to + 1) / fps : (o.end ?? info.duration));
      // A segment holding each image h frames is the animation (on ones to on fours) slowed by h/4 to h: search there.
      const h = seg?.holdFrames ?? 1;
      const speedRange: [number, number] = h > 2 ? [(h / 4) * 0.85, h * 1.15] : [0.5, 2];
      const r = await referenceTiming(config, cli, { video: o.video, start: vs, end: ve, crop: o.verify.crop ?? o.crop, fps, compare: { project: o.verify.project, skeleton: o.verify.skeleton, animation: o.verify.animation }, sheet: false, speedRange, hold: h });
      if (r.comparison) verify = { ...r.comparison, ...(seg ? { segment: seg.index } : {}), range: { start: +vs.toFixed(3), end: +ve.toFixed(3) } };
    }

    let png: Buffer | undefined;
    if (o.sheet !== false) {
      const font = FONT_CANDIDATES.find((f) => existsSync(f));
      const graph = join(work, "overview.png");
      rasterizeSvg(overviewSvg({ n, fps, motion, luma: m.luma, clipped: m.clipped, area: m.area, audio: rms, segments, events }, 1200), join(work, "overview.mvg"), graph, font);
      const shown = segments.slice(0, 16);
      const mids = shown.map((s) => Math.round((s.from + s.to) / 2));
      const thumbs = extractFrames(o.video, { fps, start: o.start ?? 0, end: o.end, crop: o.crop, frames: mids, width: 240, out: work, prefix: "seg" });
      const labelled = thumbs.map((t, i) => {
        const s = shown[i]!;
        run("magick", [t, "-background", "#1d1f33", "-fill", "white", ...(font ? ["-font", font] : []), "-pointsize", "12", "-gravity", "south", "-splice", "0x34", "-annotate", "+0+3",
          `S${s.index}  f${s.from}-${s.to}  ${s.seconds}s\n${s.holdFrames === null ? "still" : `on ${s.holdFrames}s`}${s.startsWith !== "start" ? `  (${s.startsWith})` : ""}`, t]);
        return t;
      });
      const sheet = join(work, "sheet.png");
      if (labelled.length) {
        const montage = join(work, "montage.png");
        run("magick", ["montage", ...(font ? ["-font", font] : []), ...labelled, "-tile", "8x", "-geometry", "+4+4", "-background", "#ffffff", montage]);
        run("magick", [graph, montage, "-background", "#ffffff", "-gravity", "center", "-append", sheet]);
      } else run("magick", [graph, sheet]);
      png = readFileSync(sheet);
    }
    const listed = events.slice(0, 100);
    const shownSegments = segments.slice(0, 60);
    return {
      video: o.video, info, analysed: { fps, start: o.start ?? 0, end: o.end ?? info.duration, frames: n, ...(o.crop ? { crop: o.crop } : {}) },
      quality: { ok: findings.length === 0, findings }, segments: shownSegments, events: listed, audio, curves, ...(verify ? { verify } : {}),
      notes: [
        `Frame k = frame k of the clip at a constant ${fps} fps from ${o.start ?? 0}s; spine_video_frames shows any of them exactly.`,
        "Hold pattern: frames each new image stays on screen (1 = on ones, 2 = on twos; a slowed playback multiplies it). Stutters and drops are judged against each segment's own pattern.",
        ...(o.crop ? [] : ["No crop: on-screen counters, playheads or UI change every frame and hide repeats; crop to the character or effect for hold patterns, stutters and drops."]),
        ...(events.length > listed.length ? [`${events.length - listed.length} more events not listed; inspect a narrower range (start/end).`] : []),
        ...(segments.length > shownSegments.length ? [`${segments.length - shownSegments.length} more segments not listed; inspect a narrower range (start/end).`] : []),
      ],
      ...(png ? { png } : {}),
    };
  } finally {
    removeQuiet(work);
  }
}

const STANDARD_OK = (f: number) => [12, 15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120].some((r) => Math.abs(f - r) < 0.05);
