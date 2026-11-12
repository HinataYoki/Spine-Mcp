import { iterateTimelines } from "./inspect.js";
import type { AnimationJson, Key } from "./types.js";

export interface KeyHygiene {
  keys: number;
  offFrame: number;
  offFrameExamples: string[];
  dense: string[];
  longValues: number;
  longValueExamples: string[];
  lateEnds: string[];
}

const HALF_STEP_KINDS = /^bone\.(rotate|translate|translatex|translatey|shear|shearx|sheary)$/;
const HUNDREDTH_KINDS = /^(bone\.(scale|scalex|scaley)|slot\.alpha|ik|transform|path\.mix|physics|slider)/;
const VALUE_FIELDS = ["value", "x", "y", "mix", "mixRotate", "mixX", "mixY", "mixScaleX", "mixScaleY", "mixShearY", "softness", "inertia", "strength", "damping", "massInverse", "wind", "gravity"];
const DENSE_KEYS = 12;
const DENSE_GAP_FRAMES = 2;

const frameOf = (time: number, fps: number) => time * fps;
const offGrid = (time: number, fps: number) => Math.abs(frameOf(time, fps) - Math.round(frameOf(time, fps))) > 0.01;
const notMultiple = (v: number, step: number) => Math.abs(v / step - Math.round(v / step)) > 1e-4;
const short = (v: number) => +v.toFixed(6);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

function valueStep(kind: string): number | null {
  if (HALF_STEP_KINDS.test(kind)) return 0.5;
  if (HUNDREDTH_KINDS.test(kind)) return 0.01;
  return null;
}

export function keyHygiene(anim: AnimationJson, fps: number): KeyHygiene {
  const out: KeyHygiene = { keys: 0, offFrame: 0, offFrameExamples: [], dense: [], longValues: 0, longValueExamples: [], lateEnds: [] };
  const ends: { id: string; end: number }[] = [];
  for (const t of iterateTimelines(anim)) {
    if (!t.keys.length) continue;
    const id = `${t.kind} ${t.owner}`.trim();
    out.keys += t.keys.length;
    for (const k of t.keys) {
      const time = k.time ?? 0;
      if (offGrid(time, fps)) {
        out.offFrame++;
        if (out.offFrameExamples.length < 6) out.offFrameExamples.push(`${id} at ${short(time)}s (frame ${+frameOf(time, fps).toFixed(2)})`);
      }
    }
    if (t.keys.length >= DENSE_KEYS) {
      const gaps = t.keys.slice(1).map((k, i) => ((k.time ?? 0) - (t.keys[i]!.time ?? 0)) * fps);
      if (median(gaps) <= DENSE_GAP_FRAMES + 0.01) out.dense.push(`${id} (${t.keys.length} keys)`);
    }
    const step = valueStep(t.kind);
    if (step !== null) {
      for (const k of t.keys) {
        for (const f of VALUE_FIELDS) {
          const v = (k as Key)[f];
          if (typeof v !== "number" || !notMultiple(v, step)) continue;
          out.longValues++;
          if (out.longValueExamples.length < 6) out.longValueExamples.push(`${id} ${f} ${short(v)}`);
        }
      }
    }
    if (t.kind !== "events" && t.kind !== "drawOrder" && t.kind !== "drawOrderFolder" && t.keys.length > 1) ends.push({ id, end: t.keys.at(-1)!.time ?? 0 });
  }
  if (ends.length >= 3) {
    const counts = new Map<number, number>();
    for (const e of ends) counts.set(short(e.end), (counts.get(short(e.end)) ?? 0) + 1);
    const [common, n] = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]!;
    if (n >= ends.length / 2) {
      for (const e of ends) if (e.end - common > 0.5 / fps && e.end - common <= Math.max(0.25 * common, 2 / fps)) out.lateEnds.push(`${e.id} ends at ${short(e.end)}s`);
    }
  }
  return out;
}
