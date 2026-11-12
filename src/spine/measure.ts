import type { SampledAnimation } from "./sample.js";

export interface BoneMotion {
  bone: string;
  /** Applied local rotation range (degrees). */
  rotation: { min: number; max: number; range: number };
  /** World position extent (skeleton units). */
  position: { minX: number; maxX: number; minY: number; maxY: number; pathLength: number };
  maxSpeed: number;
  maxAngularSpeed: number;
  /** Frames reached by a single-step spike (much larger than both neighbouring steps): candidates for pops/snaps. */
  pops: number[];
  /** Spans where the bone is (nearly) still, in frames [start, end]. */
  holds: [number, number][];
  /** Step across the loop seam (last frame -> wrapped frame 0) vs the neighbouring steps: ~1 is smooth, >>1 is a pop.
   * Only meaningful for looping animations. */
  seam: { position: number; rotation: number; ratio: number };
  moving: boolean;
}

export interface MotionReport {
  animation: string;
  duration: number;
  fps: number;
  frames: number;
  warmupLoops: number;
  bounds: SampledAnimation["bounds"];
  bones: BoneMotion[];
}

/** Shortest signed difference between two angles in degrees. */
export const angleDelta = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;

export interface MeasureOptions {
  /** Per-frame movement (units or degrees) below which a bone counts as still. */
  holdEpsilon?: number;
  /** Minimum frames for a hold. */
  minHoldFrames?: number;
  /** A step this many times larger than both neighbouring steps is a pop. */
  popFactor?: number;
  /** Steps below this (units + degrees per frame) are never pops or seam jumps. */
  minJump?: number;
}

export function measureMotion(s: SampledAnimation, opts: MeasureOptions = {}): MotionReport {
  const { holdEpsilon = 0.05, minHoldFrames = 3, popFactor = 3, minJump = 1 } = opts;
  const bones = s.bones.map((bone, bi): BoneMotion => {
    const f = s.samples.map((row) => row[bi]!);
    const rots = (f.length > 2 ? f.slice(0, -1) : f).map((x) => x.local.rotation);
    const allSteps: number[] = [];
    const allAngSteps: number[] = [];
    for (let i = 1; i < f.length; i++) {
      allSteps.push(Math.hypot(f[i]!.x - f[i - 1]!.x, f[i]!.y - f[i - 1]!.y));
      allAngSteps.push(Math.abs(angleDelta(f[i - 1]!.rotation, f[i]!.rotation)));
    }
    // The last step goes into the wrapped frame 0: it is the loop seam, not motion inside the animation
    // (for one-shots it is meaningless), so it only feeds `seam`.
    const steps = allSteps.length > 1 ? allSteps.slice(0, -1) : allSteps;
    const angSteps = allAngSteps.length > 1 ? allAngSteps.slice(0, -1) : allAngSteps;
    const path = steps.reduce((a, b) => a + b, 0);
    // Combined per-frame motion so a rotating-in-place bone is not reported as still.
    const motion = steps.map((d, i) => d + angSteps[i]!);
    // Local test: global medians are skewed by holds and slow drift (sweep finding on long holds).
    const pops: number[] = [];
    for (let i = 1; i < motion.length - 1; i++) {
      if (motion[i]! > minJump && motion[i]! > popFactor * Math.max(motion[i - 1]!, motion[i + 1]!)) pops.push(i + 1);
    }

    const holds: [number, number][] = [];
    let start = -1;
    motion.forEach((m, i) => {
      if (m < holdEpsilon) {
        if (start < 0) start = i;
      } else {
        if (start >= 0 && i - start >= minHoldFrames) holds.push([start, i]);
        start = -1;
      }
    });
    if (start >= 0 && motion.length - start >= minHoldFrames) holds.push([start, motion.length]);

    // The final sample is at `duration`, which the looping track wraps to the start pose.
    const seamPos = allSteps[allSteps.length - 1] ?? 0;
    const seamRot = allAngSteps[allAngSteps.length - 1] ?? 0;
    // Expected step at the seam: the mean of the step into the last frame and the step out of frame 0.
    const seamStep = seamPos + seamRot;
    const expected = motion.length ? ((motion[motion.length - 1] ?? 0) + (motion[0] ?? 0)) / 2 : 0;
    const seamRatio = seamStep > 1e-6 ? seamStep / Math.max(expected, 0.05) : 0;
    const inner = f.length > 2 ? f.slice(0, -1) : f;
    const xs = inner.map((x) => x.x);
    const ys = inner.map((x) => x.y);
    const r = (n: number) => +n.toFixed(3);
    return {
      bone,
      rotation: { min: r(Math.min(...rots)), max: r(Math.max(...rots)), range: r(Math.max(...rots) - Math.min(...rots)) },
      position: { minX: r(Math.min(...xs)), maxX: r(Math.max(...xs)), minY: r(Math.min(...ys)), maxY: r(Math.max(...ys)), pathLength: r(path) },
      maxSpeed: r(Math.max(0, ...steps) * s.fps),
      maxAngularSpeed: r(Math.max(0, ...angSteps) * s.fps),
      pops,
      holds,
      seam: { position: r(seamPos), rotation: r(seamRot), ratio: r(seamRatio) },
      moving: path > holdEpsilon * f.length || Math.max(0, ...angSteps) > holdEpsilon,
    };
  });
  return {
    animation: s.animation, duration: +s.duration.toFixed(4), fps: s.fps, frames: s.frames, warmupLoops: s.warmupLoops,
    bounds: { minX: +s.bounds.minX.toFixed(2), minY: +s.bounds.minY.toFixed(2), maxX: +s.bounds.maxX.toFixed(2), maxY: +s.bounds.maxY.toFixed(2) },
    bones,
  };
}
