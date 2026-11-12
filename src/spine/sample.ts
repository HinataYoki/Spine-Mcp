import { spine } from "./runtime.js";

export interface BoneFrame {
  /** World position. */
  x: number;
  y: number;
  /** World rotation in degrees (X axis). */
  rotation: number;
  /** Applied local pose (after constraints). */
  local: { x: number; y: number; rotation: number; scaleX: number; scaleY: number };
}

export interface SampledAnimation {
  animation: string;
  duration: number;
  /** Effective sampling rate: the requested FPS adjusted so a whole number of steps spans the duration. */
  fps: number;
  /** Frame count including frame 0 and the frame at `duration` (which wraps to the loop start). */
  frames: number;
  warmupLoops: number;
  bones: string[];
  /** samples[frame][boneIndex in `bones`] */
  samples: BoneFrame[][];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  nanFrames: number[];
}

export interface SampleOptions {
  fps?: number;
  /** Bones to record; all bones when omitted. */
  bones?: string[];
  skin?: string;
  /** Loops to run before recording so physics settles (GOTCHAS G15). Defaults to 1 when the skeleton has physics. */
  warmupLoops?: number;
  onFrame?: (skeleton: spine.Skeleton, frame: number) => void;
}

export function sampleAnimation(data: spine.SkeletonData, animation: string, opts: SampleOptions = {}): SampledAnimation {
  const anim = data.findAnimation(animation);
  if (!anim) throw new Error(`Animation "${animation}" not found. Available: ${data.animations.map((a) => a.name).join(", ")}`);
  const fps = opts.fps ?? (data.fps || 30);
  const skeleton = new spine.Skeleton(data);
  if (opts.skin) {
    if (!data.findSkin(opts.skin)) throw new Error(`Skin "${opts.skin}" not found`);
    skeleton.setSkin(opts.skin);
  }
  skeleton.setupPose();
  const names = opts.bones?.length ? opts.bones : data.bones.map((b) => b.name);
  const bones = names.map((n) => {
    const b = skeleton.findBone(n);
    if (!b) throw new Error(`Bone "${n}" not found`);
    return b;
  });

  // Whole steps per loop so warm-up ends on the loop boundary and the last sample lands exactly on `duration`
  // even when duration * fps is not an integer (e.g. a 30 fps animation sampled at 24 fps).
  const steps = Math.max(1, Math.round(anim.duration * fps));
  const dt = anim.duration > 0 ? anim.duration / steps : 1 / fps;
  const frames = steps + 1;
  const hasPhysics = data.constraints.some((c) => c instanceof spine.PhysicsConstraintData);
  const warmupLoops = opts.warmupLoops ?? (hasPhysics && anim.duration > 0 ? 1 : 0);

  // Each frame's animation time comes from integers, so the loop wraps exactly (no float drift from summing dt):
  // step k of every loop is at (k mod steps) * duration / steps, and the frame after the last one is time 0 again.
  // Physics still advances incrementally through skeleton.update(dt).
  const timeOf = (k: number) => (anim.duration > 0 ? ((k % steps) * anim.duration) / steps : 0);
  let k = 0, last = 0;
  const step = (first: boolean) => {
    if (!first) {
      k++;
      skeleton.update(dt);
    }
    const t = timeOf(k);
    // lastTime -> time so keys between frames fire (physics reset keys, events).
    anim.apply(skeleton, first ? t : last, t, true, null, 1, spine.MixFrom.setup, false, false, false);
    last = t;
    skeleton.updateWorldTransform(first ? spine.Physics.reset : spine.Physics.update);
  };

  step(true);
  for (let i = 0, n = steps * warmupLoops; i < n; i++) step(false);

  const samples: BoneFrame[][] = [];
  const nanFrames: number[] = [];
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let f = 0; f < frames; f++) {
    // Warm-up ends exactly on a loop boundary, so frame 0 is the current pose.
    if (f > 0) step(false);
    let nan = false;
    const row = bones.map((b) => {
      const p = b.appliedPose;
      const frame: BoneFrame = {
        x: p.worldX, y: p.worldY, rotation: p.getWorldRotationX(),
        local: { x: p.x, y: p.y, rotation: p.rotation, scaleX: p.scaleX, scaleY: p.scaleY },
      };
      if (!Number.isFinite(frame.x) || !Number.isFinite(frame.y) || !Number.isFinite(frame.rotation)) nan = true;
      return frame;
    });
    if (nan) nanFrames.push(f);
    samples.push(row);
    opts.onFrame?.(skeleton, f);
    const r = skeleton.getBoundsRect();
    if (Number.isFinite(r.x) && Number.isFinite(r.width)) {
      bounds.minX = Math.min(bounds.minX, r.x);
      bounds.minY = Math.min(bounds.minY, r.y);
      bounds.maxX = Math.max(bounds.maxX, r.x + r.width);
      bounds.maxY = Math.max(bounds.maxY, r.y + r.height);
    }
  }
  const effectiveFps = anim.duration > 0 ? +(steps / anim.duration).toFixed(3) : fps;
  return { animation: anim.name, duration: anim.duration, fps: effectiveFps, frames, warmupLoops, bones: names, samples, bounds, nanFrames };
}
