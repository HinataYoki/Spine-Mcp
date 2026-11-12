import { measureMotion, type BoneMotion } from "./measure.js";
import type { spine } from "./runtime.js";
import { sampleAnimation } from "./sample.js";
import { timingReport } from "./timing.js";
import type { AnimationJson } from "./types.js";

export interface BoneDelta {
  bone: string;
  rotationRange: [number, number];
  pathLength: [number, number];
  maxAngularSpeed: [number, number];
  /** b / a of total activity (path length + rotation range); 1 = same amount of motion. */
  activityRatio: number;
}

const activity = (m?: BoneMotion) => (m ? m.position.pathLength + m.rotation.range : 0);
const r = (n: number) => +n.toFixed(3);

/** Numeric A/B of two animations on the same skeleton: amplitude, speed and timing structure. */
export function compareMotion(data: spine.SkeletonData, docAnims: Record<string, AnimationJson>, a: string, b: string, opts: { fps?: number; bones?: string[]; limit?: number } = {}) {
  const ma = measureMotion(sampleAnimation(data, a, { fps: opts.fps, bones: opts.bones }));
  const mb = measureMotion(sampleAnimation(data, b, { fps: opts.fps, bones: opts.bones }));
  const byName = (m: typeof ma) => new Map(m.bones.map((x) => [x.bone, x]));
  const A = byName(ma), B = byName(mb);
  const names = [...new Set([...A.keys(), ...B.keys()])].filter((n) => A.get(n)?.moving || B.get(n)?.moving);
  const deltas: BoneDelta[] = names.map((n) => {
    const x = A.get(n), y = B.get(n);
    const ax = activity(x), by = activity(y);
    return {
      bone: n,
      rotationRange: [r(x?.rotation.range ?? 0), r(y?.rotation.range ?? 0)],
      pathLength: [r(x?.position.pathLength ?? 0), r(y?.position.pathLength ?? 0)],
      maxAngularSpeed: [r(x?.maxAngularSpeed ?? 0), r(y?.maxAngularSpeed ?? 0)],
      activityRatio: ax > 1e-6 ? r(by / ax) : by > 1e-6 ? Infinity : 1,
    };
  });
  deltas.sort((p, q) => Math.abs(Math.log(q.activityRatio || 1e-6)) - Math.abs(Math.log(p.activityRatio || 1e-6)));
  const ta = timingReport(a, docAnims[a]!, opts.bones), tb = timingReport(b, docAnims[b]!, opts.bones);
  const totalA = names.reduce((s, n) => s + activity(A.get(n)), 0), totalB = names.reduce((s, n) => s + activity(B.get(n)), 0);
  return {
    a, b,
    duration: [ma.duration, mb.duration],
    overallActivityRatio: totalA > 0 ? r(totalB / totalA) : null,
    timing: {
      keyPoses: [ta.keyPoses.length, tb.keyPoses.length],
      meanPoseInterval: [ta.poseIntervals.mean, tb.poseIntervals.mean],
      meanSegment: [ta.segments.meanDuration, tb.segments.meanDuration],
      byEase: [ta.segments.byEase, tb.segments.byEase],
    },
    bones: deltas.slice(0, opts.limit ?? 15),
    otherBones: Math.max(0, deltas.length - (opts.limit ?? 15)),
  };
}
