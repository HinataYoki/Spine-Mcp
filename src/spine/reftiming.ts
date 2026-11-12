import { execFileSync, removeQuiet } from "../platform.js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Config } from "../config.js";
import type { SpineCli } from "./cli.js";
import { loadProject, pickSkeleton, pruneDir, UserError } from "./project.js";
import { renderFrames } from "./render.js";
import { FONT_CANDIDATES, need, run } from "./showcase.js";
import { holdPattern, rawMotion } from "./videodecode.js";
import { rasterizeSvg } from "./svgraster.js";

export interface ReferenceTimingOptions {
  /** Absolute path to a video (mp4, mov, webm, gif...). */
  video: string;
  /** Seconds to analyse (default: the whole clip). */
  start?: number;
  end?: number;
  /** Region of interest in source pixels (the character, not the UI around it). */
  crop?: { x: number; y: number; width: number; height: number };
  /** Analysis rate (default: the video's rate, at most 60). */
  fps?: number;
  /** Compare against a Spine animation rendered through the same pixel pipeline. */
  compare?: { project: string; skeleton?: string; animation: string; scale?: number };
  /** Contact sheet of the marked frames plus the motion graph (default true). */
  sheet?: boolean;
  /** Speed ratios searched (default [0.5, 2]); widen for slowed playback (e.g. [0.5, 10]). */
  speedRange?: [number, number];
  /**
   * Frames each image stays on screen in the reference (a slowed or stepped segment: 8 for a 0.25x slow-motion of an
   * animation on twos). Its motion arrives as one spike per new image; spreading it over the hold makes a curve the
   * animation can be aligned with.
   */
  hold?: number;
}

/** Centred moving average over `w` frames (w <= 1 returns the curve unchanged). */
export function spreadHold(v: number[], w: number): number[] {
  if (!(w > 1)) return v;
  const half = Math.floor(w / 2);
  return v.map((_, k) => { let s = 0, n = 0; for (let j = k - half; j < k - half + w; j++) if (j >= 0 && j < v.length) { s += v[j]!; n++; } return n ? s / n : 0; });
}

export interface MotionTrack {
  fps: number;
  frames: number;
  duration: number;
  /** Mean absolute frame-to-frame change (0-1) per frame, thinned to at most 300 values. */
  energy: number[];
  energyStep: number;
  /** Frames where motion peaks: accents, contacts, extremes of fast moves. */
  peaks: { frame: number; time: number; energy: number }[];
  /** Runs with almost no motion (holds, settles). */
  holds: { from: number; to: number; seconds: number }[];
  /** Hard cuts (scene changes) removed from the analysis. */
  cuts: number[];
  /** Repeat period of the motion when it cycles. */
  period?: { frames: number; seconds: number; confidence: number };
}

export interface TimingComparison {
  animation: string;
  spine: MotionTrack;
  /** Reference time = scale x Spine time + offset (seconds). */
  scale: number;
  offset: number;
  matched: { spine: number; reference: number; diffFrames: number }[];
  unmatchedReferencePeaks: number[];
  unmatchedSpinePeaks: number[];
  method: "beats" | "correlation";
  /** The animation's peaks were repeated this many times (the reference holds several loops). */
  loopsCompared: number;
  summary: string;
}

export interface ReferenceTimingResult {
  video: { path: string; width: number; height: number; fps: number; duration: number };
  analysed: { start: number; end: number; crop?: ReferenceTimingOptions["crop"] };
  reference: MotionTrack;
  /** The frame table: every marked frame with its time and what happens there. */
  table: { frame: number; time: number; mark: string }[];
  comparison?: TimingComparison;
  notes: string[];
  png?: Buffer;
}

const W = 160;

function probe(video: string) {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate:format=duration", "-of", "json", video], { encoding: "utf8" });
  const j = JSON.parse(out) as { streams: { width: number; height: number; avg_frame_rate: string; r_frame_rate: string }[]; format: { duration?: string } };
  const s = j.streams[0];
  if (!s) throw new UserError(`No video stream in ${video}`);
  const rate = (r: string) => { const [a, b] = r.split("/").map(Number); return b ? a! / b : a!; };
  const fps = rate(s.avg_frame_rate) || rate(s.r_frame_rate) || 30;
  return { width: s.width, height: s.height, fps: +fps.toFixed(3), duration: +(Number(j.format.duration) || 0).toFixed(3) };
}

/** Small grey frames at a constant rate (game captures are often variable frame rate). */
function greyFrames(inputArgs: string[], fps: number, crop: ReferenceTimingOptions["crop"] | undefined, file: string): { frames: Uint8Array[]; w: number; h: number } {
  const vf = [`fps=${fps}`, ...(crop ? [`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`] : []), `scale=${W}:-2:flags=area`, "format=gray"].join(",");
  run("ffmpeg", ["-y", "-loglevel", "error", ...inputArgs, "-vf", vf, "-f", "rawvideo", file]);
  const buf = readFileSync(file);
  // Height from the first frame's size: scale=160:-2 keeps the aspect ratio.
  const probeH = (() => {
    const t = `${file}.png`;
    run("ffmpeg", ["-y", "-loglevel", "error", ...inputArgs, "-vf", vf.replace(",format=gray", ""), "-frames:v", "1", t]);
    const dims = execFileSync("magick", ["identify", "-format", "%h", t], { encoding: "utf8" });
    rmSync(t, { force: true });
    return Number(dims);
  })();
  const n = Math.floor(buf.length / (W * probeH));
  return { frames: Array.from({ length: n }, (_, k) => buf.subarray(k * W * probeH, (k + 1) * W * probeH)), w: W, h: probeH };
}

function energyOf(frames: Uint8Array[]): number[] {
  const e = rawMotion(frames);
  // Repeated frames (60 fps capture of a 30 fps game, slow motion by duplication) read as zero motion followed by a
  // double step: spread each change over the run of repeats before it, so the curve shows the motion rate. A regular
  // repeat pattern (on twos, slowed x4) sets how long a run may be; otherwise up to 3 repeats.
  const hp = holdPattern(e, 0, e.length - 1);
  const limit = hp.hold && hp.hold > 1 && hp.consistency >= 0.6 ? hp.hold : 4;
  const out = [...e];
  let last = 0;
  for (let k = 1; k < e.length; k++) {
    if (hp.repeats.size ? hp.repeats.has(k) : e[k]! < 1e-4) continue;
    const len = k - last;
    if (len > 1 && len <= limit) for (let j = last + 1; j <= k; j++) out[j] = e[k]! / len;
    last = k;
  }
  return out;
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };
const quantile = (v: number[], q: number) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))]! : 0; };

/** Peaks, holds, cuts and the repeat period of a motion energy curve. */
export function analyseEnergy(raw: number[], fps: number): MotionTrack {
  const n = raw.length;
  const med = median(raw);
  // A cut changes most of the picture at once: many times the usual change.
  // A cut changes most of the picture in one frame: a large step, several times both neighbouring steps.
  const cuts = raw.map((v, k) => (k > 0 && v > Math.max(0.08, 4 * med) && v > 3 * Math.max(raw[k - 1] ?? 0, raw[k + 1] ?? 0) ? k : -1)).filter((k) => k >= 0);
  const e = raw.map((v, k) => (cuts.includes(k) ? (raw[k - 1] ?? 0) : v));
  const smooth = e.map((_, k) => (e[Math.max(0, k - 1)]! + 2 * e[k]! + e[Math.min(n - 1, k + 1)]!) / 4);
  const lo = median(smooth), hi = quantile(smooth, 0.95);
  const peakLevel = lo + 0.35 * (hi - lo);
  const peaks: MotionTrack["peaks"] = [];
  for (let k = 1; k < n - 1; k++) {
    if (smooth[k]! < peakLevel || smooth[k]! < smooth[k - 1]! || smooth[k]! < smooth[k + 1]!) continue;
    const last = peaks[peaks.length - 1];
    if (last && k - last.frame < 3) { if (smooth[k]! > last.energy) peaks[peaks.length - 1] = { frame: k, time: +(k / fps).toFixed(4), energy: +smooth[k]!.toFixed(4) }; continue; }
    peaks.push({ frame: k, time: +(k / fps).toFixed(4), energy: +smooth[k]!.toFixed(4) });
  }
  // Holds: near-still runs, measured from the stillest frames rather than the typical one.
  const still = quantile(smooth, 0.1);
  const holdLevel = Math.max(0.002, still + 0.06 * (hi - still));
  const holds: MotionTrack["holds"] = [];
  for (let k = 0; k < n;) {
    if (smooth[k]! >= holdLevel) { k++; continue; }
    let j = k;
    while (j + 1 < n && smooth[j + 1]! < holdLevel) j++;
    if (j - k + 1 >= 3) holds.push({ from: k, to: j, seconds: +((j - k + 1) / fps).toFixed(3) });
    k = j + 1;
  }
  // Repeat period: the strongest autocorrelation lag.
  let period: MotionTrack["period"];
  if (n >= 16) {
    const mean = e.reduce((s, v) => s + v, 0) / n;
    const d = e.map((v) => v - mean);
    const var0 = d.reduce((s, v) => s + v * v, 0) || 1;
    // Smooth curves correlate with themselves at small lags: wait for the correlation to drop, then take the best lag.
    const cs: number[] = [];
    let best = 0, bestLag = 0, dropped = false, firstLag = 0;
    for (let lag = 2; lag <= Math.floor(n / 2); lag++) {
      let s = 0;
      for (let k = 0; k + lag < n; k++) s += d[k]! * d[k + lag]!;
      const c = s / var0 * (n / (n - lag));
      cs[lag] = c;
      if (!dropped) { if (c < 0.1) { dropped = true; firstLag = lag; } continue; }
      if (c > best) { best = c; bestLag = lag; }
    }
    // Multiples of the period correlate as well: take the first lag that comes close to the best.
    for (let lag = firstLag + 1; lag < bestLag; lag++) {
      if (cs[lag]! >= 0.85 * best && cs[lag]! >= (cs[lag - 1] ?? -1) && cs[lag]! >= (cs[lag + 1] ?? -1)) { best = cs[lag]!; bestLag = lag; break; }
    }
    if (best > 0.6) period = { frames: bestLag, seconds: +(bestLag / fps).toFixed(3), confidence: +Math.min(1, best).toFixed(2) };
  }
  const step = Math.max(1, Math.ceil(n / 300));
  return {
    fps, frames: n, duration: +(n / fps).toFixed(3), energy: raw.filter((_, k) => k % step === 0).map((v) => +v.toFixed(4)), energyStep: step,
    peaks, holds, cuts, ...(period ? { period } : {}),
  };
}

/**
 * Reference time = a x spine time + b. Hypotheses come from peak pairs (and scale 1 shifts); the ones that land the
 * most peaks are ranked by how well the whole motion curves agree (peaks alone jitter by a frame).
 */
export function alignPeaks(ref: number[], sp: number[], fps: number, curves?: { ref: number[]; spine: number[]; cycle: number }, range: [number, number] = [0.5, 2], tolFrames = 1.5): { scale: number; offset: number; matched: [number, number][] } | null {
  if (ref.length < 1 || sp.length < 1) return null;
  const tol = tolFrames / fps;
  const score = (a: number, b: number) => {
    const used = new Set<number>(), matched: [number, number][] = [];
    let err = 0;
    for (const s of sp) {
      const t = a * s + b;
      let bi = -1, bd = Infinity;
      ref.forEach((r, i) => { const dd = Math.abs(r - t); if (dd < bd && !used.has(i)) { bd = dd; bi = i; } });
      if (bi >= 0 && bd <= tol) { used.add(bi); matched.push([s, ref[bi]!]); err += bd; }
    }
    return { n: matched.length, err, matched };
  };
  // Agreement of the motion curves under a hypothesis (Pearson over the reference frames).
  const agree = (a: number, b: number) => {
    if (!curves) return 0;
    const xs: number[] = [], ys: number[] = [];
    curves.ref.forEach((v, k) => {
      const ts = (k / fps - b) / a;
      if (ts < 0) return;
      const local = curves.cycle > 0 ? ts % curves.cycle : ts;
      const j = Math.round(local * fps);
      if (j < curves.spine.length) { xs.push(v); ys.push(curves.spine[j]!); }
    });
    if (xs.length < 4) return -1;
    const mx = xs.reduce((s2, v) => s2 + v, 0) / xs.length, my = ys.reduce((s2, v) => s2 + v, 0) / ys.length;
    let sxy = 0, sxx = 0, syy = 0;
    xs.forEach((x, i) => { sxy += (x - mx) * (ys[i]! - my); sxx += (x - mx) ** 2; syy += (ys[i]! - my) ** 2; });
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
  };
  const cycle = curves?.cycle ?? 0;
  const cands = new Map<string, { a: number; b: number; n: number; err: number }>();
  const consider = (a: number, b: number) => {
    if (!(a >= range[0] && a <= range[1])) return;
    // The first cycle starts at most half a cycle before the clip (other starts are the same hypothesis shifted).
    if (cycle > 0 && b < -0.5 * a * cycle) return;
    const key = `${a.toFixed(3)}|${b.toFixed(3)}`;
    if (cands.has(key)) return;
    const s = score(a, b);
    cands.set(key, { a, b, n: s.n, err: s.err });
  };
  for (const r of ref) for (const s of sp) consider(1, r - s);
  for (let i = 0; i < ref.length; i++) for (let j = i + 1; j < ref.length; j++) for (let k = 0; k < sp.length; k++) for (let l = k + 1; l < sp.length; l++) {
    const a = (ref[j]! - ref[i]!) / (sp[l]! - sp[k]!);
    consider(a, ref[i]! - a * sp[k]!);
  }
  if (!cands.size) return null;
  const all = [...cands.values()];
  const maxN = Math.max(...all.map((c) => c.n));
  const top = all.filter((c) => c.n >= Math.max(1, maxN - 1));
  const ranked = top.map((c) => ({ ...c, r: agree(c.a, c.b) })).sort((x, y) => (curves ? y.r - x.r : 0) || y.n - x.n || x.err - y.err);
  let { a, b } = ranked[0]!;
  // Fine search around the best hypothesis on the dense motion curves (peaks jitter by a frame, curves do not).
  if (curves) {
    const peaksFit = score(a, b), n0 = peaksFit.n;
    // The peaks leave the scale open by their tolerance over the span they cover: two peaks of a slowed, held
    // segment (8-frame holds, a quarter second apart in the animation) about 14%. Search that, never less than 8%.
    const spTimes = peaksFit.matched.map((m) => m[0]);
    const span = spTimes.length > 1 ? a * (Math.max(...spTimes) - Math.min(...spTimes)) : 0;
    const reach = Math.min(0.25, Math.max(0.08, span > 0 ? (2 * tol) / span : 0));
    // A scale turns about the matched peaks, not about the clip's start: the offset that keeps them in place moves
    // with it (it moved 10 frames between 3.56 and 3.9 on a peak a second into the clip, outside a fixed window).
    const pivot = spTimes.length ? spTimes.reduce((s2, v) => s2 + v, 0) / spTimes.length : 0;
    const bReach = Math.max(3, Math.ceil(tol * fps) + 1);
    let bestR = agree(a, b), ba = a, bb = b;
    for (let da = -reach; da <= reach + 1e-9; da += 0.0025) {
      const ca = a * (1 + da);
      if (ca < range[0] || ca > range[1]) continue;
      for (let db = -bReach; db <= bReach; db += 0.5) {
        const cb = b + (a - ca) * pivot + db / fps;
        if (cycle > 0 && cb < -0.5 * ca * cycle) continue;
        const r = agree(ca, cb);
        if (r > bestR + 1e-4 && score(ca, cb).n >= n0 - 1) { bestR = r; ba = ca; bb = cb; }
      }
    }
    // Only a clear gain moves the answer off the peak-based one.
    if (bestR > agree(a, b) + 0.01) { a = ba; b = bb; }
    // A held peak can sit a hold away from where the curves put it: the peaks that chose this hypothesis stay its
    // evidence (their diffFrames show how far each lands), rather than the answer falling back to scale 1.
    const refined = score(a, b);
    return { scale: a, offset: b, matched: refined.n >= n0 ? refined.matched : peaksFit.matched };
  }
  // Least squares over the matched pairs, kept only when it lands as many peaks with less error.
  const first = score(a, b);
  if (first.matched.length >= 3) {
    const xs = first.matched.map((m) => m[0]), ys = first.matched.map((m) => m[1]);
    const mx = xs.reduce((s2, v) => s2 + v, 0) / xs.length, my = ys.reduce((s2, v) => s2 + v, 0) / ys.length;
    const sxx = xs.reduce((s2, v) => s2 + (v - mx) ** 2, 0);
    if (sxx > 1e-9) {
      const la = xs.reduce((s2, v, i) => s2 + (v - mx) * (ys[i]! - my), 0) / sxx, lb = my - la * mx;
      const second = score(la, lb);
      if (la >= range[0] && la <= range[1] && second.n >= first.n && second.err < first.err && agree(la, lb) >= agree(a, b) - 0.02) { a = la; b = lb; }
    }
  }
  return { scale: a, offset: b, matched: score(a, b).matched };
}

/** Fallback when there are too few peaks: the best offset (scale 1) by correlating the energy curves. */
function correlate(ref: number[], sp: number[]): number {
  let best = -Infinity, bestLag = 0;
  for (let lag = -sp.length + 1; lag < ref.length; lag++) {
    let s = 0, c = 0;
    for (let k = 0; k < sp.length; k++) { const r = ref[k + lag]; if (r !== undefined) { s += r * sp[k]!; c++; } }
    if (c >= Math.min(sp.length, ref.length) / 2 && s / c > best) { best = s / c; bestLag = lag; }
  }
  return bestLag;
}

function graphSvg(track: MotionTrack, w: number, h: number, other?: { track: MotionTrack; scale: number; offset: number }) {
  const pad = 30;
  const raw = track.energy;
  const max = Math.max(1e-6, ...raw, ...(other ? other.track.energy : []));
  const X = (t: number) => pad + ((w - pad * 2) * t) / Math.max(1e-6, track.duration);
  const Y = (v: number) => h - pad - ((h - pad * 2) * v) / max;
  // Line segments (drawn through svgraster.ts: ImageMagick's SVG reader draws no polyline or path strokes and paints lines black).
  const segs = (vals: number[], step: number, fps: number, map: (t: number) => number, attrs: string) => {
    const pts = vals.map((v, i) => [X(map((i * step) / fps)), Y(v)] as const);
    const end = X(track.duration) + 0.5; // a repeated curve stops where the reference does
    return pts.slice(1).map((p, i) => [pts[i]!, p] as const).filter(([a, b]) => a[0] <= end && b[0] <= end)
      .map(([a, b]) => `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" ${attrs}/>`).join("");
  };
  const parts = [`<rect width="${w}" height="${h}" fill="#ffffff"/>`];
  for (const hd of track.holds) parts.push(`<rect x="${X(hd.from / track.fps)}" y="${pad}" width="${Math.max(1, X(hd.to / track.fps) - X(hd.from / track.fps))}" height="${h - pad * 2}" fill="#e9eef7"/>`);
  parts.push(segs(raw, track.energyStep, track.fps, (t) => t, `stroke="#1d1f33" stroke-width="2"`));
  if (other) {
    // The animation's curve repeated over the clip, mapped to reference time.
    const cyc = other.track.duration;
    for (let c = 0; other.scale * c * cyc + other.offset < track.duration; c++) {
      parts.push(segs(other.track.energy, other.track.energyStep, other.track.fps, (t) => other.scale * (t + c * cyc) + other.offset, `stroke="#e4572e" stroke-width="1.5"`));
    }
  }
  for (const p of track.peaks) parts.push(`<circle cx="${X(p.time)}" cy="${Y(p.energy)}" r="4" fill="#2e86ab"/>`);
  for (const c of track.cuts) parts.push(`<line x1="${X(c / track.fps)}" x2="${X(c / track.fps)}" y1="${pad}" y2="${h - pad}" stroke="#d81159" stroke-dasharray="3,3"/>`);
  const step = track.duration > 8 ? 1 : track.duration > 3 ? 0.5 : 0.25;
  for (let t = 0; t <= track.duration + 1e-9; t += step) parts.push(`<text x="${X(t) - 8}" y="${h - 10}" font-size="11" fill="#555">${+t.toFixed(2)}s</text>`);
  parts.push(`<text x="${pad}" y="18" font-size="12" fill="#1d1f33">motion per frame (reference dark${other ? ", Spine orange, aligned" : ""}); dots = peaks, shaded = holds</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" font-family="Helvetica, Arial, sans-serif">${parts.join("")}</svg>`;
}

/**
 * Timing from a reference video: motion per frame through a fixed pixel pipeline (constant frame rate, region of
 * interest, small grey frames), then peaks, holds, cuts and the repeat period; optionally the same for a Spine
 * animation and the two aligned on their peaks (scale, offset, per-peak differences in frames).
 */
export async function referenceTiming(config: Config, cli: SpineCli, o: ReferenceTimingOptions): Promise<ReferenceTimingResult> {
  if (!isAbsolute(o.video) || !existsSync(o.video)) throw new UserError(`video must be an absolute path to an existing file: ${o.video}`);
  need("ffmpeg", "reference timing");
  need("magick", "reference contact sheets");
  const info = probe(o.video);
  // Variable frame rate captures average to odd rates (29.37): snap to the nearest standard rate within 5%.
  const STANDARD = [12, 15, 24, 25, 30, 48, 50, 60];
  const snapped = STANDARD.find((r) => Math.abs(info.fps - r) / r <= 0.05);
  const fps = Math.min(60, Math.round(o.fps ?? snapped ?? info.fps));
  if (o.crop && (o.crop.x < 0 || o.crop.y < 0 || o.crop.x + o.crop.width > info.width || o.crop.y + o.crop.height > info.height)) throw new UserError(`crop lies outside the ${info.width}x${info.height} video`);
  const start = o.start ?? 0, end = o.end ?? info.duration;
  if (!(end > start)) throw new UserError("end must be after start");
  const root = join(config.workDir, "reference");
  pruneDir(root, 6);
  const work = join(root, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(work, { recursive: true });
  try {
    const input = ["-ss", String(start), "-to", String(end), "-i", o.video];
    const g = greyFrames(input, fps, o.crop, join(work, "ref.gray"));
    if (g.frames.length < 4) throw new UserError("Fewer than 4 frames to analyse; check start, end and the video.");
    const hold = Math.max(1, Math.round(o.hold ?? 1));
    const refEnergy = spreadHold(energyOf(g.frames), hold);
    const reference = analyseEnergy(refEnergy, fps);
    const table = [
      ...reference.peaks.map((p) => ({ frame: p.frame, time: p.time, mark: "peak" })),
      ...reference.holds.flatMap((h) => [{ frame: h.from, time: +(h.from / fps).toFixed(4), mark: `hold ${h.seconds}s` }, { frame: h.to, time: +(h.to / fps).toFixed(4), mark: "hold end" }]),
      ...reference.cuts.map((c) => ({ frame: c, time: +(c / fps).toFixed(4), mark: "cut" })),
    ].sort((a, b) => a.frame - b.frame);

    let comparison: TimingComparison | undefined;
    if (o.compare) {
      const loaded = await loadProject(config, cli, o.compare.project);
      const sk = pickSkeleton(loaded, o.compare.skeleton);
      if (!sk.doc.animations?.[o.compare.animation]) throw new UserError(`Animation "${o.compare.animation}" not found in skeleton "${sk.name}"`);
      const r = await renderFrames(config, cli, o.compare.project, { skeleton: sk.name, animation: o.compare.animation, fps, scale: o.compare.scale ?? 50, background: "7f7f7fff" });
      // Same pipeline as the reference: constant rate, small grey frames.
      const seq = join(work, "spine");
      mkdirSync(seq, { recursive: true });
      r.frames.forEach((f, k) => writeFileSync(join(seq, `f_${String(k).padStart(5, "0")}.png`), readFileSync(f)));
      const sg = greyFrames(["-framerate", String(fps), "-i", join(seq, "f_%05d.png")], fps, undefined, join(work, "spine.gray"));
      const spine = analyseEnergy(energyOf(sg.frames), fps);
      const refPeaks = reference.peaks.map((p) => p.time), spPeaks = spine.peaks.map((p) => p.time);
      // A reference holding several cycles of a loop: repeat the animation's peaks so every cycle can vote.
      const cycles = reference.duration > 1.5 * spine.duration ? Math.min(12, Math.ceil(reference.duration / (spine.duration * Math.min(1, o.speedRange?.[0] ?? 1))) + 1) : 1;
      const tiled = Array.from({ length: cycles }, (_, c) => spPeaks.map((t) => +(t + c * spine.duration).toFixed(4))).flat();
      const al = alignPeaks(refPeaks, tiled, fps, { ref: refEnergy, spine: energyOf(sg.frames), cycle: spine.duration }, o.speedRange ?? [0.5, 2], Math.max(1.5, hold / 2));
      let scale = 1, offset = 0, method: TimingComparison["method"] = "beats", matched: [number, number][] = [];
      if (al && al.matched.length >= Math.min(2, tiled.length)) ({ scale, offset, matched } = al);
      else { method = "correlation"; offset = correlate(refEnergy, energyOf(sg.frames)) / fps; }
      const matchedRef = new Set(matched.map((m) => m[1])), matchedSp = new Set(matched.map((m) => +(m[0] % spine.duration).toFixed(4)));
      const pct = Math.round((scale - 1) * 100);
      const summary = method === "correlation"
        ? `Too few motion peaks to align on beats; by correlation the animation lines up ${offset.toFixed(2)}s into the reference (scale not estimated).`
        : `${matched.length} of ${tiled.length} Spine motion peaks${cycles > 1 ? ` (${cycles} loops)` : ""} line up with the reference${Math.abs(pct) >= 2 ? `; the reference takes ${Math.abs(pct)}% ${pct > 0 ? "longer (your animation is faster)" : "less time (your animation is slower)"}` : " at the same speed"}, starting ${offset.toFixed(2)}s into the clip.`;
      comparison = {
        animation: o.compare.animation, spine, scale: +scale.toFixed(4), offset: +offset.toFixed(4), method,
        matched: matched.slice(0, 60).map(([s, rr]) => ({ spine: s, reference: rr, diffFrames: +((rr - (scale * s + offset)) * fps).toFixed(2) })),
        unmatchedReferencePeaks: refPeaks.filter((t) => !matchedRef.has(t)).slice(0, 40), unmatchedSpinePeaks: spPeaks.filter((t) => !matchedSp.has(+t.toFixed(4))),
        loopsCompared: cycles,
        summary,
      };
    }

    let png: Buffer | undefined;
    if (o.sheet !== false) {
      const marks = table.filter((t) => t.mark !== "hold end").slice(0, 16);
      const font = FONT_CANDIDATES.find((f) => existsSync(f));
      const thumbs: string[] = [];
      for (const [i, m] of marks.entries()) {
        const out = join(work, `t_${String(i).padStart(2, "0")}.png`);
        const vf = [...(o.crop ? [`crop=${o.crop.width}:${o.crop.height}:${o.crop.x}:${o.crop.y}`] : []), "scale=200:-2"].join(",");
        run("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(start + m.time), "-i", o.video, "-frames:v", "1", "-vf", vf, out]);
        if (existsSync(out)) {
          run("magick", [out, "-background", "#1d1f33", "-fill", "white", ...(font ? ["-font", font] : []), "-pointsize", "13", "-gravity", "south", "-splice", "0x20", "-annotate", "+0+3", `f${m.frame}  ${m.time.toFixed(2)}s  ${m.mark}`, out]);
          thumbs.push(out);
        }
      }
      const graphPng = join(work, "graph.png");
      rasterizeSvg(graphSvg(reference, 900, 220, comparison && { track: comparison.spine, scale: comparison.scale, offset: comparison.offset }), join(work, "graph.mvg"), graphPng, font);
      const sheet = join(work, "sheet.png");
      if (thumbs.length) {
        const montage = join(work, "montage.png");
        run("magick", ["montage", ...(font ? ["-font", font] : []), ...thumbs, "-tile", "8x", "-geometry", "+4+4", "-background", "#ffffff", montage]);
        run("magick", [graphPng, montage, "-background", "#ffffff", "-gravity", "center", "-append", sheet]);
      } else {
        run("magick", [graphPng, sheet]);
      }
      png = readFileSync(sheet);
    }
    return {
      video: { path: o.video, ...info }, analysed: { start, end, ...(o.crop ? { crop: o.crop } : {}) }, reference, table: table.slice(0, 120), ...(comparison ? { comparison } : {}),
      notes: [
        `Motion = mean pixel change per frame at ${fps} fps (${W} px wide grey frames${o.crop ? ", cropped" : ""}). Peaks are motion peaks (fast moves, accents, contacts), not proven impacts; holds are near-still runs; cuts are excluded.`,
        "Crop to the character: UI, camera moves and particles also count as motion. Validated on Spine renders (scale, offset, cuts); real game footage is still to be field-checked.",
        ...(o.compare ? ["The Spine animation goes through the same pipeline (Spine's own render, same rate, grey background) and is aligned on motion peaks: reference time = scale x Spine time + offset."] : []),
      ],
      ...(png ? { png } : {}),
    };
  } finally {
    removeQuiet(work);
  }
}
