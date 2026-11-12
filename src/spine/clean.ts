import { BONE_CHANNELS, keyTime, valueAt } from "./curves.js";
import { animationDuration } from "./inspect.js";
import { loadSkeletonData, spine } from "./runtime.js";
import { boneValueKind, fitBezier, roundHalfAway, snapTime, type ValueKind } from "./tidy.js";
import type { AnimationJson, Key, SkeletonJson } from "./types.js";

const DENSE_KEYS = 12;
const DENSE_GAP_FRAMES = 2;
const TOLERANCE: Record<ValueKind, number> = { angle: 0.75, translate: 0.75, scale: 0.01, unit: 0.03, deform: 0.03, fine: 0.01, precise: 0.001 };

export interface ThinReport { timelines: number; before: number; after: number }

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

export function denseTimeline(keys: Key[], fps: number): boolean {
  if (keys.length < DENSE_KEYS) return false;
  return median(keys.slice(1).map((k, i) => (keyTime(k) - keyTime(keys[i]!)) * fps)) <= DENSE_GAP_FRAMES + 0.01;
}

export function thinDenseTimelines(anim: AnimationJson, fps: number, bones?: string[]): ThinReport {
  const report: ThinReport = { timelines: 0, before: 0, after: 0 };
  for (const [bone, timelines] of Object.entries(anim.bones ?? {})) {
    if (bones && !bones.includes(bone)) continue;
    for (const [prop, keys] of Object.entries(timelines)) {
      const spec = BONE_CHANNELS[prop], kind = boneValueKind(prop);
      if (!spec || !kind || !denseTimeline(keys, fps) || keys.some((k) => k.curve === "stepped")) continue;
      const first = snapTime(keyTime(keys[0]!), fps), last = snapTime(keyTime(keys.at(-1)!), fps);
      const frames = Math.round((last - first) * fps);
      if (frames < 2) continue;
      const times = Array.from({ length: frames + 1 }, (_, f) => snapTime(first + f / fps, fps));
      const series = spec.fields.map((field, c) => times.map((t) => valueAt(keys, field, c, spec.neutral, t)));
      const fit = fitBezier(times, series.map((values) => ({ values, tol: TOLERANCE[kind], kind })));
      if (fit.keys.length >= keys.length) continue;
      report.timelines++;
      report.before += keys.length;
      report.after += fit.keys.length;
      timelines[prop] = fit.keys.map((i, n) => {
        const key: Key = times[i] ? { time: times[i] } : {};
        spec.fields.forEach((field, c) => (key[field] = fit.values[n]![c]!));
        if (fit.curves[n]) key.curve = fit.curves[n]!;
        return key;
      });
    }
  }
  return report;
}

export function poseDrift(skeleton: SkeletonJson, before: AnimationJson, after: AnimationJson, fps: number): { pixels: number; bone: string; time: number } | null {
  let data;
  try { data = loadSkeletonData({ ...skeleton, animations: { before, after } }); } catch { return null; }
  const a = new spine.Skeleton(data), b = new spine.Skeleton(data);
  const duration = Math.max(animationDuration(before), animationDuration(after));
  const frames = Math.max(1, Math.round(duration * fps));
  let worst = { pixels: 0, bone: "", time: 0 };
  for (let f = 0; f <= frames; f++) {
    const t = Math.min(duration, f / fps);
    for (const [sk, name] of [[a, "before"], [b, "after"]] as const) {
      sk.setupPose();
      data.findAnimation(name)!.apply(sk, t, t, false, null, 1, spine.MixFrom.setup, false, false, false);
      sk.updateWorldTransform(spine.Physics.none);
    }
    a.bones.forEach((bone, i) => {
      const other = b.bones[i]!;
      const d = Math.hypot(bone.appliedPose.worldX - other.appliedPose.worldX, bone.appliedPose.worldY - other.appliedPose.worldY);
      if (d > worst.pixels) worst = { pixels: d, bone: bone.data.name, time: t };
    });
  }
  return { pixels: roundHalfAway(worst.pixels, 2), bone: worst.bone, time: roundHalfAway(worst.time, 3) };
}
