import { BONE_CHANNELS, channelHandles, keyTime, keyValue } from "./curves.js";
import { animationDuration } from "./inspect.js";
import type { AnimationJson, Key } from "./types.js";

export type Ease = "linear" | "stepped" | "ease-in" | "ease-out" | "ease-in-out" | "custom" | "hold";

export interface Segment {
  from: number;
  to: number;
  duration: number;
  ease: Ease;
}

export interface BoneTiming {
  bone: string;
  kind: string;
  keys: number;
  times: number[];
  segments: Segment[];
}

export interface TimingReport {
  animation: string;
  duration: number;
  /** Key times shared by bones, i.e. the pose structure: [time, number of bone timelines keyed there]. */
  keyPoses: [number, number][];
  /** Gaps between consecutive key poses (seconds). */
  poseIntervals: { min: number; max: number; mean: number; median: number };
  segments: { total: number; byEase: Record<Ease, number>; meanDuration: number; holds: number; holdTime: number };
  bones: BoneTiming[];
}

/** Classifies a segment's ease from its normalized bezier handles (first channel that moves). */
export function classifySegment(a: Key, b: Key, fields: string[], neutral: number): Ease {
  if (a.curve === "stepped") return "stepped";
  const ta = keyTime(a), dt = keyTime(b) - ta;
  const ch = fields.findIndex((f) => Math.abs(keyValue(b, f, neutral) - keyValue(a, f, neutral)) > 1e-6);
  if (ch < 0) return "hold";
  const h = channelHandles(a.curve, ch);
  if (!h || dt <= 0) return "linear";
  const va = keyValue(a, fields[ch]!, neutral), dv = keyValue(b, fields[ch]!, neutral) - va;
  const x1 = (h[0] - ta) / dt, y1 = (h[1] - va) / dv, x2 = (h[2] - ta) / dt, y2 = (h[3] - va) / dv;
  const slowStart = y1 < x1 - 0.1, slowEnd = y2 > x2 + 0.1;
  const fastStart = y1 > x1 + 0.1, fastEnd = y2 < x2 - 0.1;
  if (slowStart && slowEnd) return "ease-in-out";
  if (slowStart && !fastEnd) return "ease-in";
  if (slowEnd && !fastStart) return "ease-out";
  if (Math.abs(y1 - x1) <= 0.1 && Math.abs(y2 - x2) <= 0.1) return "linear";
  return "custom";
}

const r = (n: number) => +n.toFixed(4);

export function timingReport(name: string, anim: AnimationJson, bones?: string[]): TimingReport {
  const duration = animationDuration(anim);
  const poseCount = new Map<number, number>();
  const byEase: Record<Ease, number> = { linear: 0, stepped: 0, "ease-in": 0, "ease-out": 0, "ease-in-out": 0, custom: 0, hold: 0 };
  const out: BoneTiming[] = [];
  let total = 0, sumDur = 0, holdTime = 0;
  for (const [bone, timelines] of Object.entries(anim.bones ?? {})) {
    if (bones && !bones.includes(bone)) continue;
    for (const [kind, keys] of Object.entries(timelines)) {
      const spec = BONE_CHANNELS[kind];
      if (!spec) continue;
      const times = keys.map((k) => r(keyTime(k)));
      for (const t of times) poseCount.set(t, (poseCount.get(t) ?? 0) + 1);
      const segments: Segment[] = [];
      for (let i = 0; i < keys.length - 1; i++) {
        const ease = classifySegment(keys[i]!, keys[i + 1]!, spec.fields, spec.neutral);
        const seg = { from: times[i]!, to: times[i + 1]!, duration: r(times[i + 1]! - times[i]!), ease };
        segments.push(seg);
        byEase[ease]++;
        total++;
        sumDur += seg.duration;
        if (ease === "hold") holdTime += seg.duration;
      }
      out.push({ bone, kind, keys: keys.length, times, segments });
    }
  }
  const keyPoses = [...poseCount.entries()].sort((a, b) => a[0] - b[0]);
  const gaps = keyPoses.slice(1).map(([t], i) => r(t - keyPoses[i]![0]));
  const sorted = [...gaps].sort((a, b) => a - b);
  return {
    animation: name, duration: r(duration), keyPoses,
    poseIntervals: gaps.length
      ? { min: sorted[0]!, max: sorted.at(-1)!, mean: r(gaps.reduce((a, b) => a + b, 0) / gaps.length), median: sorted[Math.floor(sorted.length / 2)]! }
      : { min: 0, max: 0, mean: 0, median: 0 },
    segments: { total, byEase, meanDuration: total ? r(sumDur / total) : 0, holds: byEase.hold, holdTime: r(holdTime) },
    bones: out,
  };
}
