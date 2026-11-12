import { animationDuration } from "./inspect.js";
import { repeatAnimation } from "./repeat.js";
import { angleDelta } from "./measure.js";
import { loadSkeletonData, spine } from "./runtime.js";
import { fitBezier, onFrame, projectFps, snapTime, type ValueKind } from "./tidy.js";
import type { AnimationJson, Key, SkeletonJson, TimelineMap } from "./types.js";

export interface BakePhysicsOptions {
  /** Physics-driven bones to bake (default: every bone with a physics constraint). */
  bones?: string[];
  fps?: number;
  /** Loops simulated before the recorded one, so physics settles (default 3 when looping). */
  warmupLoops?: number;
  /** Close the loop (default true): the best-matching cycle is picked and its seam error spread with a smoothstep. */
  loop?: boolean;
  /** Cycles simulated after warm-up to pick the one whose end matches its start best (default 8 when looping). */
  searchCycles?: number;
  /** Max deviation kept when thinning keys (default 0.05 deg, 0.05 units, 0.001 scale). */
  tolerance?: { rotation?: number; position?: number; scale?: number };
  /** Bake N cycles as one animation (the source repeated N times) for motion that repeats only every N loops, or
   * "auto" to detect N (2-4). Default 1. */
  cycles?: number | "auto";
  /** Internal: skip the automatic remedies when a bake is not exact. */
  noRetry?: boolean;
  authored?: boolean;
}

export interface BakePhysicsReport {
  bones: string[];
  constraints: string[];
  fps: number;
  warmupLoops: number;
  keys: number;
  /** Baked animation (physics off) against the simulation it came from, in world space, over all bones. */
  maxPositionError: number;
  maxRotationError: number;
  /** Bone and time of the largest position error. */
  worstAt: string;
  /** Largest seam correction spread over the cycle (0 when not looping). */
  loopCorrection: { position: number; rotation: number };
  /** Which simulated cycle after warm-up was baked (the one closest to periodic). */
  cycle: number;
}

const CH = ["x", "y", "rotation", "scaleX", "scaleY", "shearX", "shearY"] as const;
type Channel = (typeof CH)[number];

const smooth = (u: number) => u * u * (3 - 2 * u);

interface Recorded {
  local: Map<string, Record<Channel, number[]>>;
  world: Float64Array[]; // per frame: [x, y, rotation] per bone
}

/** Simulates the animation like a game (physics on), records one cycle after warm-up. */
function simulate(data: spine.SkeletonData, anim: spine.Animation, bones: spine.BoneData[], fps: number, warmup: number, loop: boolean, cycles: number): Recorded {
  const sk = new spine.Skeleton(data);
  sk.setupPose();
  const steps = Math.max(1, Math.round(anim.duration * fps));
  const dt = anim.duration / steps;
  const timeOf = (k: number) => ((k % steps) * anim.duration) / steps;
  let k = 0, last = 0;
  const step = (first: boolean) => {
    if (!first) {
      k++;
      sk.update(dt);
    }
    const t = loop ? timeOf(k) : Math.min(k * dt, anim.duration);
    // lastTime -> time, so keys between frames fire (physics reset keys respawn particles, e.g. rain).
    anim.apply(sk, first ? t : last, t, loop, null, 1, spine.MixFrom.setup, false, false, false);
    last = t;
    sk.updateWorldTransform(first ? spine.Physics.reset : spine.Physics.update);
  };
  step(true);
  for (let i = 0; i < steps * warmup; i++) step(false);
  const local = new Map(bones.map((b) => [b.name, Object.fromEntries(CH.map((c) => [c, [] as number[]])) as Record<Channel, number[]>]));
  const world: Float64Array[] = [];
  for (let f = 0; f <= steps * cycles; f++) {
    if (f > 0) step(false);
    const w = new Float64Array(sk.bones.length * 3);
    sk.bones.forEach((b, i) => {
      const p = b.appliedPose;
      w[i * 3] = p.worldX;
      w[i * 3 + 1] = p.worldY;
      w[i * 3 + 2] = p.getWorldRotationX();
    });
    world.push(w);
    for (const bd of bones) {
      const p = sk.findBone(bd.name)!.appliedPose;
      p.updateLocalTransform(sk); // physics changed the world transform; read it back as a local pose
      const rec = local.get(bd.name)!;
      for (const c of CH) rec[c].push(p[c]);
    }
  }
  return { local, world };
}

function worldOf(data: spine.SkeletonData, anim: spine.Animation, fps: number): Float64Array[] {
  const sk = new spine.Skeleton(data);
  const steps = Math.max(1, Math.round(anim.duration * fps));
  const out: Float64Array[] = [];
  for (let f = 0; f <= steps; f++) {
    const t = (anim.duration * f) / steps;
    sk.setupPose();
    anim.apply(sk, t, t, false, null, 1, spine.MixFrom.setup, false, false, false);
    sk.updateWorldTransform(spine.Physics.none);
    const w = new Float64Array(sk.bones.length * 3);
    sk.bones.forEach((b, i) => {
      const p = b.appliedPose;
      w[i * 3] = p.worldX;
      w[i * 3 + 1] = p.worldY;
      w[i * 3 + 2] = p.getWorldRotationX();
    });
    out.push(w);
  }
  return out;
}

/**
 * Bakes what physics adds into bone keys: simulates the animation with spine-core (warm-up loops first), reads each
 * physics bone's resulting transform back as local values every frame, closes the loop, thins the keys within a
 * tolerance and keys the physics constraint's mix to 0, so the animation plays the same without simulation.
 */
export function bakePhysics(source: AnimationJson, skeleton: SkeletonJson, o: BakePhysicsOptions = {}): { animation: AnimationJson; notes: string[]; report: BakePhysicsReport } {
  if (typeof o.cycles === "number" && o.cycles > 1) {
    const repeated = repeatAnimation(source, animationDuration(source), o.cycles, skeleton);
    const r = bakePhysics(repeated, skeleton, { ...o, cycles: 1, loop: o.loop ?? true });
    r.notes.unshift(`baked ${o.cycles} cycles as one ${(animationDuration(source) * o.cycles).toFixed(3)} s animation (the source repeated ${o.cycles} times)`);
    return r;
  }
  if (o.cycles === "auto") {
    const single = bakePhysics(source, skeleton, { ...o, cycles: 1 });
    const period = single.notes.join("\n").match(/repeats every (\d+) cycles/)?.[1];
    return period ? bakePhysics(source, skeleton, { ...o, cycles: Number(period) }) : single;
  }
  const fps = o.fps ?? projectFps(skeleton);
  const doc: SkeletonJson = { ...structuredClone(skeleton), animations: { ...(skeleton.animations ?? {}), __bake: source } };
  const data = loadSkeletonData(doc);
  const anim = data.findAnimation("__bake")!;
  if (!(anim.duration > 0)) throw new Error("bakePhysics needs an animation longer than 0 s");
  // Loop by default only when the animation itself loops (its pose at the end matches the start, physics off).
  const ends = worldOf(data, anim, 1 / anim.duration);
  let endGap = 0;
  for (let i = 0; i < ends[0]!.length / 3; i++) endGap = Math.max(endGap, Math.hypot(ends[0]![i * 3]! - ends[1]![i * 3]!, ends[0]![i * 3 + 1]! - ends[1]![i * 3 + 1]!));
  const loop = o.loop ?? endGap < 0.5;
  const warmup = o.warmupLoops ?? (loop ? 3 : 0);
  const constraints = data.constraints.filter((c): c is spine.PhysicsConstraintData => c instanceof spine.PhysicsConstraintData)
    .filter((c) => !o.bones || o.bones.includes(c.bone.name));
  if (!constraints.length) throw new Error(o.bones ? `No physics constraint on: ${o.bones.join(", ")}` : "The skeleton has no physics constraints");
  const bones = constraints.map((c) => c.bone);
  const notes: string[] = [];
  if (o.loop === undefined && !loop) notes.push(`baked straight through (not as a loop): the animation's own pose at the end differs from the start by ${endGap.toFixed(1)} units`);
  // Other constraints that read or drive a baked bone (as constrained bone, transform source, IK/path target): they
  // see the baked pose instead of the live simulation and may not reproduce it exactly.
  const reads = (c: spine.ConstraintData<never, never>) => {
    const any = c as unknown as { bones?: spine.BoneData[]; source?: spine.BoneData; target?: spine.BoneData | spine.SlotData };
    return (any.bones ?? []).some((b) => bones.includes(b)) || (!!any.source && bones.includes(any.source)) || (!!any.target && bones.includes(any.target as spine.BoneData));
  };
  const others = data.constraints.filter((c) => !(c instanceof spine.PhysicsConstraintData) && reads(c as never));
  // Baked physics bones another constraint takes as its source or target.
  const feeds = bones.filter((b) => others.some((c) => {
    const any = c as unknown as { source?: spine.BoneData; target?: spine.BoneData };
    return any.source === b || any.target === b;
  }));

  const cycles = loop ? Math.max(1, o.searchCycles ?? 8) : 1;
  const all = simulate(data, anim, bones, fps, warmup, loop, cycles);
  const steps = Math.max(1, Math.round(anim.duration * fps));
  // Physics is not always periodic (a whipping tip can differ by a lot between loops): bake the cycle whose last frame
  // is closest to its first.
  const seam = (c: number, period = 1) => {
    let worst = 0;
    for (const r of all.local.values()) {
      for (const ch of CH) {
        const a0 = r[ch][c * steps]!, a1 = r[ch][(c + period) * steps]!;
        const d = ch === "rotation" || ch.startsWith("shear") ? Math.abs(angleDelta(a0, a1)) : Math.abs(a1 - a0) * (ch.startsWith("scale") ? 100 : 1);
        worst = Math.max(worst, d);
      }
    }
    return worst;
  };
  let cycle = 0;
  for (let c = 1; c < cycles; c++) if (seam(c) < seam(cycle)) cycle = c;
  const slice = <T,>(arr: T[]) => arr.slice(cycle * steps, (cycle + 1) * steps + 1);
  const rec: Recorded = {
    world: slice(all.world),
    local: new Map([...all.local].map(([n, r]) => [n, Object.fromEntries(CH.map((ch) => [ch, slice(r[ch])])) as Record<Channel, number[]>])),
  };
  const times = Array.from({ length: steps + 1 }, (_, f) => (anim.duration * f) / steps);
  const tol = { rotation: o.tolerance?.rotation ?? 0.05, position: o.tolerance?.position ?? 0.05, scale: o.tolerance?.scale ?? 0.001 };
  const out: AnimationJson = structuredClone(source);
  out.bones ??= {};
  let keyCount = 0, corrPos = 0, corrRot = 0;

  for (const bd of bones) {
    const r = rec.local.get(bd.name)!;
    // Continuous rotations (no +-360 flips between frames), then the seam correction.
    for (const c of ["rotation", "shearX", "shearY"] as const) {
      for (let f = 1; f <= steps; f++) r[c][f] = r[c][f - 1]! + angleDelta(r[c][f - 1]!, r[c][f]!);
    }
    if (loop) {
      for (const c of CH) {
        const s = r[c];
        const d = s[steps]! - s[0]!;
        // Angles: whole turns are not an error (a spinning bone keeps spinning).
        const err = c === "rotation" || c.startsWith("shear") ? d - 360 * Math.round(d / 360) : d;
        for (let f = 0; f <= steps; f++) s[f] = s[f]! - err * smooth(f / steps);
        if (c === "x" || c === "y") corrPos = Math.max(corrPos, Math.abs(err));
        if (c === "rotation") corrRot = Math.max(corrRot, Math.abs(err));
      }
    }
    const setup = bd.setupPose;
    const tl: TimelineMap = { ...(out.bones[bd.name] ?? {}) };
    for (const k of ["rotate", "translate", "translatex", "translatey", "scale", "scalex", "scaley", "shear", "shearx", "sheary"]) delete tl[k];
    const emit = (name: string, fields: string[], series: number[][], tolerances: number[], neutral: number[], hadBefore: boolean, kind: ValueKind) => {
      const constant = series.every((s, c) => s.every((v) => Math.abs(v - neutral[c]!) < tolerances[c]!));
      if (constant && !hadBefore) return;
      const exactKind: ValueKind = "precise";
      const fit = fitBezier(times, series.map((values, c) => ({ values, tol: tolerances[c]!, kind: o.authored ? kind : exactKind })), { loop });
      tl[name] = fit.keys.map((i, n) => {
        const t = onFrame(times[i]!, fps) ? snapTime(times[i]!, fps) : +times[i]!.toFixed(6);
        const key: Key = { ...(t ? { time: t } : {}) };
        fields.forEach((f, c) => (key[f] = fit.values[n]![c]!));
        if (fit.curves[n]) key.curve = fit.curves[n]!;
        return key;
      });
      keyCount += fit.keys.length;
    };
    const had = (k: string) => !!source.bones?.[bd.name]?.[k];
    emit("rotate", ["value"], [r.rotation.map((v) => v - setup.rotation)], [tol.rotation], [0], had("rotate"), "angle");
    emit("translate", ["x", "y"], [r.x.map((v) => v - setup.x), r.y.map((v) => v - setup.y)], [tol.position, tol.position], [0, 0], had("translate") || had("translatex") || had("translatey"), "translate");
    if (setup.scaleX !== 0 && setup.scaleY !== 0) {
      emit("scale", ["x", "y"], [r.scaleX.map((v) => v / setup.scaleX), r.scaleY.map((v) => v / setup.scaleY)], [tol.scale, tol.scale], [1, 1], had("scale") || had("scalex") || had("scaley"), "scale");
    }
    emit("shear", ["x", "y"], [r.shearX.map((v) => v - setup.shearX), r.shearY.map((v) => v - setup.shearY)], [tol.rotation, tol.rotation], [0, 0], had("shear") || had("shearx") || had("sheary"), "angle");
    out.bones[bd.name] = tl;
  }
  // Physics off while this animation plays (it returns when mixing to another animation).
  out.physics = { ...(out.physics ?? {}) };
  for (const c of constraints) out.physics[c.name] = { mix: [{ value: 0 }] };

  // Verify like a game: play the baked animation with the simulation on (same warm-up and cycle). Baked constraints
  // are switched off by their mix keys; any physics left unbaked simulates as before. Every bone, world space.
  const check = loadSkeletonData({ ...doc, animations: { ...doc.animations, __baked: out } });
  const replay = simulate(check, check.findAnimation("__baked")!, [], fps, warmup, loop, cycles).world;
  const baked = replay.slice(cycle * steps, (cycle + 1) * steps + 1);
  let maxPos = 0, maxRot = 0, worstAt = "";
  // When looping, the simulation's last frame is the next cycle's first; compare the cycle itself.
  const n = Math.min(baked.length, rec.world.length) - (loop ? 1 : 0);
  for (let f = 0; f < n; f++) {
    const a = rec.world[f]!, b = baked[f]!;
    for (let i = 0; i < a.length / 3; i++) {
      const dp = Math.hypot(a[i * 3]! - b[i * 3]!, a[i * 3 + 1]! - b[i * 3 + 1]!);
      if (dp > maxPos) { maxPos = dp; worstAt = `${check.bones[i]!.name}@${times[f]!.toFixed(3)}s`; }
      maxRot = Math.max(maxRot, Math.abs(angleDelta(a[i * 3 + 2]!, b[i * 3 + 2]!)));
    }
  }
  notes.push(`baked ${bones.length} physics bone(s) into ${keyCount} keys; physics mix keyed to 0 for ${constraints.map((c) => c.name).join(", ")}`);
  const residual = Math.max(1, tol.position * 20);
  if (maxPos > residual + corrPos) {
    const why = feeds.length
      ? `; constraints read baked bones (${others.map((c) => c.name).join(", ")}) and see the baked pose instead of the live simulation (leaving ${feeds.map((b) => b.name).join(", ")} live and a finer tolerance were tried)`
      : "; a finer tolerance was tried";
    notes.push(o.authored ? `keys fitted on whole frames and rounded to whole degrees: up to ${maxPos.toFixed(1)} units off the simulation at ${worstAt}` : `not exact: up to ${maxPos.toFixed(1)} units off the simulation at ${worstAt}${why}`);
  } else if (others.length) {
    notes.push(`constraints that read baked bones (${others.map((c) => c.name).join(", ")}) still reproduce the simulation within ${maxPos.toFixed(2)} units`);
  }
  if (loop && (corrRot > 10 || corrPos > 5)) {
    // Does it repeat over several animation cycles instead (e.g. a tip whipping to alternate sides every hop)?
    let period = 0, periodSeam = Infinity;
    for (let p = 2; p <= Math.min(4, cycles - 1); p++) {
      const v = Math.min(...Array.from({ length: cycles - p }, (_, c) => seam(c, p)));
      if (v < periodSeam) { periodSeam = v; period = p; }
    }
    const repeats = period && periodSeam < Math.min(seam(cycle), 10) ? ` It repeats every ${period} cycles (seam ${periodSeam.toFixed(1)} there), so a ${period}-cycle animation would loop cleanly (cycles: ${period} or \"auto\").` : "";
    notes.push(`the simulation does not repeat from one loop to the next: the best of ${cycles} cycles still needs a ${corrRot.toFixed(1)} deg / ${corrPos.toFixed(1)} unit seam correction, spread over the cycle.${repeats} Check the result, or bake with loop: false.`);
  }
  // Not exact: find out why by trying the two remedies, keep the first exact result and say what was done.
  if (maxPos > residual + corrPos && !o.noRetry && !o.authored) {
    const exact = (r: ReturnType<typeof bakePhysics>) => r.report.maxPositionError <= residual + r.report.loopCorrection.position;
    if (!o.bones && feeds.length && feeds.length < bones.length) {
      const retry = bakePhysics(source, skeleton, { ...o, bones: bones.filter((b) => !feeds.includes(b)).map((b) => b.name), noRetry: true });
      if (exact(retry)) {
        retry.notes.unshift(`left ${feeds.map((b) => b.name).join(", ")} on live physics: other constraints read them, and baking them was ${maxPos.toFixed(1)} units off at ${worstAt}`);
        return retry;
      }
    }
    const finer = { rotation: tol.rotation / 5, position: tol.position / 5, scale: tol.scale / 5 };
    const retry = bakePhysics(source, skeleton, { ...o, tolerance: finer, noRetry: true });
    if (exact(retry)) {
      retry.notes.unshift(`thinning at the default tolerance added up to ${maxPos.toFixed(1)} units along long chains; baked with tolerance ${finer.rotation} deg / ${finer.position} units instead`);
      return retry;
    }
  }
  return {
    animation: out,
    notes,
    report: {
      bones: bones.map((b) => b.name), constraints: constraints.map((c) => c.name), fps, warmupLoops: warmup, keys: keyCount,
      maxPositionError: +maxPos.toPrecision(3), maxRotationError: +maxRot.toPrecision(3), worstAt,
      loopCorrection: { position: +corrPos.toPrecision(3), rotation: +corrRot.toPrecision(3) },
      cycle: warmup + cycle + 1,
    },
  };
}
