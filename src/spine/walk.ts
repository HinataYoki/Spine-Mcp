// Walk and run cycles: a planned foot path per leg (planted on the ground during stance, an arc during swing),
// solved as two-bone IK in world space every frame, with hip bob and counter-swinging arms.
import { valueAt } from "./curves.js";
import { checkEventNames } from "./events.js";
import { loadSkeletonData, spine } from "./runtime.js";
import { fitBezier, framesOf, projectFps, snapTime, type ValueKind } from "./tidy.js";
import type { AnimationJson, Key, SkeletonJson } from "./types.js";

export interface WalkLeg {
  /** Upper and lower leg; the foot point is the end of the lower leg. */
  thigh: string;
  shin: string;
  /** Optional foot bone kept level with the ground during stance. */
  foot?: string;
}

export interface WalkOptions {
  legs: [WalkLeg, WalkLeg];
  /** The bone that bobs up and down (hip, pelvis or body root of the legs). */
  hip: string;
  /** Arms swinging against the legs: bone and swing in degrees (default 18 walk, 30 run). */
  arms?: { bone: string; swing?: number }[];
  style?: "walk" | "run";
  /** Seconds per cycle (two steps). Default 1 (walk), 0.6 (run). */
  period?: number;
  /** Step length in skeleton units (default 0.8x leg length walk, 1.2x run). */
  stride?: number;
  /** Foot lift at mid swing (default 0.12x leg length walk, 0.25x run). */
  stepHeight?: number;
  /** Hip bob (default 0.04x leg length walk, 0.08x run). */
  bob?: number;
  /** Facing direction: 1 = walks toward +x (default), -1 toward -x. */
  facing?: 1 | -1;
  /** How far the hip sits lower than at setup, so the legs reach the stride with bent knees (default: just enough, plus the bob). */
  crouch?: number;
  /** An event the skeleton defines, keyed at each foot contact (string = the thigh bone), e.g. for footstep sounds. */
  footstepEvent?: string;
  /** Forward lean of the hip in degrees (default 0 walk, 6 run). */
  lean?: number;
  /**
   * side (default): the character is drawn in profile and steps along x. front: drawn facing the camera, it marches in
   * place: feet lift in turn, the hip sways toward the standing leg, knees keep the rig's bend (outward when rigged straight).
   */
  view?: "side" | "front";
  /** front view: hip sway to each side in skeleton units (default 0.035x leg length). */
  sway?: number;
  fps?: number;
}

const DEG = 180 / Math.PI;
const wrapDeg = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/**
 * An in-place walk or run cycle. Feet follow a planned path: during stance (60% walk, 35% run) a foot slides back at
 * constant speed on its setup ground height (a treadmill, so it stays planted relative to the ground), during swing it
 * returns in an eased arc. Legs are solved analytically (knee toward `facing`), or through the rig's own IK
 * constraint when one drives the leg (its target bone is keyed instead). The hip bobs twice per cycle (lowest just
 * after contact in a walk, highest in the flight phase of a run), arms swing against the legs.
 */
export function walkCycle(skeleton: SkeletonJson, o: WalkOptions): { animation: AnimationJson; notes: string[]; footError: number } {
  const data = loadSkeletonData(skeleton);
  const names = new Set(data.bones.map((b) => b.name));
  const missing = [o.hip, ...o.legs.flatMap((l) => [l.thigh, l.shin, ...(l.foot ? [l.foot] : [])]), ...(o.arms ?? []).map((a) => a.bone)].filter((b) => !names.has(b));
  if (missing.length) throw new Error(`Unknown bone(s): ${missing.join(", ")}`);
  for (const l of o.legs) if (data.findBone(l.shin)!.parent?.name !== l.thigh) throw new Error(`"${l.shin}" must be a child of "${l.thigh}"`);
  const run = o.style === "run", facing = o.facing ?? 1, front = o.view === "front";
  const sk = new spine.Skeleton(data);
  sk.setupPose();
  sk.updateWorldTransform(spine.Physics.none);
  const leg0 = o.legs.map((l) => {
    const t = sk.findBone(l.thigh)!.appliedPose, s = sk.findBone(l.shin)!, sp = s.appliedPose;
    const len2 = s.data.length;
    if (!(len2 > 0)) throw new Error(`"${l.shin}" needs a length (its tip is the foot)`);
    const tip: [number, number] = [sp.worldX + Math.cos(sp.getWorldRotationX() / DEG) * len2 * Math.hypot(sp.a, sp.c), sp.worldY + Math.sin(sp.getWorldRotationX() / DEG) * len2 * Math.hypot(sp.a, sp.c)];
    return { l1: Math.hypot(sp.worldX - t.worldX, sp.worldY - t.worldY), l2: len2 * Math.hypot(sp.a, sp.c), tip, hipToTip: [tip[0] - t.worldX, tip[1] - t.worldY] as [number, number] };
  });
  const legLen = (leg0[0]!.l1 + leg0[0]!.l2 + leg0[1]!.l1 + leg0[1]!.l2) / 2;
  const fps = o.fps ?? projectFps(skeleton), period = Math.max(8, framesOf(o.period ?? (run ? 0.6 : 1), fps)) / fps, stride = front ? 0 : o.stride ?? legLen * (run ? 1.2 : 0.8);
  // Front view: a 2D knee can only bend sideways, so lifts, bob and sway stay small (a lifted knee would come toward the
  // camera; sideways it reads as bow legs).
  const lift = o.stepHeight ?? legLen * (front ? (run ? 0.11 : 0.07) : run ? 0.25 : 0.12), bob = o.bob ?? legLen * (front ? (run ? 0.03 : 0.015) : run ? 0.08 : 0.04);
  const lean = front ? 0 : o.lean ?? (run ? 6 : 0), stance = run ? 0.35 : 0.6;
  const sway = front ? o.sway ?? legLen * 0.025 : 0;
  // A straight leg cannot reach a foot half a stride ahead: the hip drops until it can (97% of full reach), below the bob.
  const need = Math.max(...leg0.map((g) => { const h = -g.hipToTip[1], reach = 0.97 * (g.l1 + g.l2); return h - Math.sqrt(Math.max(0, reach * reach - (stride / 2) ** 2)); }));
  const crouch = o.crouch ?? (front ? bob : Math.max(0, need) + (run ? 0 : bob));
  // The rig's IK, when it drives a leg: key its target instead of the bones.
  const ikFor = (l: WalkLeg) => data.constraints.find((c): c is spine.IkConstraintData => c instanceof spine.IkConstraintData && c.bones.length === 2 && c.bones[0]!.name === l.thigh && c.bones[1]!.name === l.shin);
  const ground = Math.min(leg0[0]!.tip[1], leg0[1]!.tip[1]);
  const moverSetup = new Map<string, [number, number]>();
  for (const l of o.legs) { const ik = ikFor(l); if (ik) { const m = moverOf(sk, ik.target.name, l.thigh), p = m.appliedPose; moverSetup.set(m.data.name, [p.worldX, p.worldY]); } }
  // Front view: a 2D knee can only go sideways. A leg drawn straight but rigged with its knee off the hip-to-foot line (a
  // pre-bend so the IK knows its direction) keeps that bend: flipping it bends the drawn leg at the knee and the shin
  // swings across the other leg. Only a leg rigged straight gets its knee bent away from the body's centre line.
  const hipX = sk.findBone(o.hip)!.appliedPose.worldX;
  const outward = o.legs.map((l, i) => Math.sign(sk.findBone(l.thigh)!.appliedPose.worldX - hipX) || (i ? 1 : -1));
  const setupBend = o.legs.map((l, i) => {
    const t = sk.findBone(l.thigh)!.appliedPose, k = sk.findBone(l.shin)!.appliedPose, g = leg0[i]!;
    const cross = g.hipToTip[0] * (k.worldY - t.worldY) - g.hipToTip[1] * (k.worldX - t.worldX);
    const off = cross / (Math.hypot(g.hipToTip[0], g.hipToTip[1]) || 1); // knee distance from the hip-to-foot line, signed
    return Math.abs(off) > 0.5 ? Math.sign(off) : 0;
  });
  const bendFor = new Map<string, boolean>();
  if (front) {
    o.legs.forEach((l, i) => {
      const ik = ikFor(l);
      if (!ik || setupBend[i]) return; // the rig's own bend
      // Which bend direction puts the knee outward: try both on the crouched setup pose.
      const kneeX = (positive: boolean) => {
        const probe = new spine.Skeleton(data);
        probe.setupPose();
        probe.findBone(o.hip)!.pose.y -= crouch;
        const c = probe.findConstraint(ik.name, spine.IkConstraint)!;
        c.pose.bendDirection = positive ? 1 : -1;
        probe.updateWorldTransform(spine.Physics.none);
        return probe.findBone(l.shin)!.appliedPose.worldX;
      };
      bendFor.set(ik.name, (kneeX(true) - kneeX(false)) * outward[i]! > 0);
    });
  }
  // Arms the rig drives with IK: their target swings on an arc around the shoulder (the rig's IK stays on).
  const armIk = (bone: string) => data.constraints.find((c): c is spine.IkConstraintData => c instanceof spine.IkConstraintData && c.bones[0]!.name === bone);
  const armSetup = new Map<string, { mover: string; shoulder: [number, number]; target: [number, number]; moverWorld: [number, number] }>();
  for (const a of o.arms ?? []) {
    const ik = armIk(a.bone);
    if (!ik) continue;
    const m = moverOf(sk, ik.target.name, a.bone), sh = sk.findBone(a.bone)!.appliedPose, tg = sk.findBone(ik.target.name)!.appliedPose;
    armSetup.set(a.bone, { mover: m.data.name, shoulder: [sh.worldX, sh.worldY], target: [tg.worldX, tg.worldY], moverWorld: [m.appliedPose.worldX, m.appliedPose.worldY] });
  }
  const steps = framesOf(period, fps);
  const times = Array.from({ length: steps + 1 }, (_, f) => +(f / fps).toFixed(6));
  // Foot path relative to its setup position under the hip: phase 0 = heel contact, foot forward.
  const footAt = (phase: number): [number, number] => {
    const p = ((phase % 1) + 1) % 1;
    if (front) return p < stance ? [0, 0] : [0, lift * Math.sin(Math.PI * ((p - stance) / (1 - stance)))];
    if (p < stance) return [facing * stride * (0.5 - p / stance), 0];
    const u = (p - stance) / (1 - stance), e = u * u * (3 - 2 * u);
    return [facing * stride * (-0.5 + e), lift * Math.sin(Math.PI * u)];
  };
  // Hip: lowest just after each contact (walk), or at mid stance with highest in flight (run).
  const hipAt = (t: number): number => {
    const p = (t / period) * 2;
    return run ? bob * Math.cos(2 * Math.PI * (p - stance / 2 - 0.5)) : -bob * Math.cos(2 * Math.PI * (p - 0.1));
  };
  const hipBone = sk.findBone(o.hip)!;
  const series: Record<string, number[]> = {};
  const push = (k: string, v: number) => (series[k] ??= []).push(v);
  let footError = 0;
  const record = (hipKeys?: Record<string, Key[]>, movers?: Record<string, Record<string, Key[]>>) => {
  for (const k of Object.keys(series)) delete series[k];
  footError = 0;
  for (const t of times) {
    sk.setupPose();
    const hp = hipBone.pose;
    // Hip offsets are world-space; express the bob in the hip's parent space.
    const par = hipBone.parent?.appliedPose;
    const det = par ? par.a * par.d - par.b * par.c || 1 : 1;
    const dy = hipAt(t) - crouch;
    // Front view: the weight shifts over the standing leg (leg 0 stands through the first half of the cycle).
    const dx = sway ? outward[0]! * sway * Math.cos(2 * Math.PI * (t / period - stance / 2)) : 0;
    hp.x += par ? (par.d * dx - par.b * dy) / det : dx;
    hp.y += par ? (par.a * dy - par.c * dx) / det : dy;
    hp.rotation -= facing * lean;
    if (hipKeys) {
      const setupHip = hipBone.data.setupPose;
      if (hipKeys.translate) { hp.x = setupHip.x + valueAt(hipKeys.translate, "x", 0, 0, t); hp.y = setupHip.y + valueAt(hipKeys.translate, "y", 1, 0, t); }
      if (hipKeys.rotate) hp.rotation = setupHip.rotation + valueAt(hipKeys.rotate, "value", 0, 0, t);
    }
    push(`hip.x`, hp.x - hipBone.data.setupPose.x);
    push(`hip.y`, hp.y - hipBone.data.setupPose.y);
    push(`hip.r`, hp.rotation - hipBone.data.setupPose.rotation);
    sk.updateWorldTransform(spine.Physics.none);
    o.legs.forEach((l, i) => {
      const phase = t / period + i * 0.5;
      const [fx, fy] = footAt(phase);
      const target: [number, number] = [leg0[i]!.tip[0] + fx, ground + (leg0[i]!.tip[1] - ground) + fy];
      const thigh = sk.findBone(l.thigh)!, shin = sk.findBone(l.shin)!;
      const ik = ikFor(l);
      const keyed = ik && movers?.[moverOf(sk, ik.target.name, l.thigh).data.name]?.translate;
      if (keyed) {
        const mover = moverOf(sk, ik.target.name, l.thigh), ms = moverSetup.get(mover.data.name)!, mpar = mover.parent!.appliedPose, d2 = mpar.a * mpar.d - mpar.b * mpar.c || 1;
        const lx = ms[0] + fx - mpar.worldX, ly = ms[1] + fy - mpar.worldY;
        const ex = valueAt(keyed, "x", 0, 0, t) - ((mpar.d * lx - mpar.b * ly) / d2 - mover.data.setupPose.x), ey = valueAt(keyed, "y", 1, 0, t) - ((-mpar.c * lx + mpar.a * ly) / d2 - mover.data.setupPose.y);
        target[0] += mpar.a * ex + mpar.b * ey;
        target[1] += mpar.c * ex + mpar.d * ey;
      }
      // Front view: a leg that comes toward the camera looks shorter in 2D. Each leg is scaled along its bones to the
      // hip-to-foot distance, so the knee keeps its setup line instead of bowing sideways.
      let shorten = 1;
      if (front) {
        const tp0 = thigh.appliedPose, g = leg0[i]!;
        shorten = Math.min(1, Math.max(0.5, Math.hypot(target[0] - tp0.worldX, target[1] - tp0.worldY) / Math.hypot(g.hipToTip[0], g.hipToTip[1])));
        push(`${l.thigh}.sx`, shorten); // the shin inherits the thigh's scale
        push("one", 1);
      }
      if (ik) {
        // The rig's own IK: move the target's top ancestor under the root (often a foot target carrying the leg target)
        // along the foot path, from where it sits at setup.
        const mover = moverOf(sk, ik.target.name, l.thigh);
        const ms = moverSetup.get(mover.data.name)!, mpar = mover.parent!.appliedPose, d2 = mpar.a * mpar.d - mpar.b * mpar.c || 1;
        const wx = ms[0] + fx, wy = ms[1] + fy, lx = wx - mpar.worldX, ly = wy - mpar.worldY;
        push(`${mover.data.name}.x`, (mpar.d * lx - mpar.b * ly) / d2 - mover.data.setupPose.x);
        push(`${mover.data.name}.y`, (-mpar.c * lx + mpar.a * ly) / d2 - mover.data.setupPose.y);
        return;
      }
      const tp = thigh.appliedPose, l1 = leg0[i]!.l1 * shorten, l2 = leg0[i]!.l2 * shorten;
      const dx = target[0] - tp.worldX, dyy = target[1] - tp.worldY;
      const dist = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, Math.hypot(dx, dyy)));
      if (Math.hypot(dx, dyy) > l1 + l2) footError = Math.max(footError, Math.hypot(dx, dyy) - (l1 + l2));
      // Law of cosines; the knee bends toward the facing direction.
      const a1 = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist))));
      const base = Math.atan2(dyy, dx);
      // Front view: the knee stays on the side it sits at setup (outward when the leg is rigged straight).
      const bend = front ? setupBend[i]! || outward[i]! : facing;
      // The thigh's axis can sit at an angle to the hip->knee line (the knee joint off its axis): take it out.
      const sj = shin.data.setupPose, axisOffset = Math.atan2(sj.y, sj.x) * DEG;
      const kneeLine = (base + bend * a1) * DEG;
      const thighWorld = kneeLine - axisOffset;
      const k = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + l2 * l2 - dist * dist) / (2 * l1 * l2))));
      const shinWorld = kneeLine - bend * (180 - k * DEG);
      // Local rotations: world minus the parent's world rotation, against the bone's own setup offset.
      const thighParent = thigh.parent!.appliedPose.getWorldRotationX();
      const thighOffset = sk.findBone(l.thigh)!.appliedPose.getWorldRotationX() - thighParent - thigh.pose.rotation;
      const thighLocal = wrapDeg(thighWorld - thighParent - thighOffset);
      push(`${l.thigh}.r`, wrapDeg(thighLocal - thigh.data.setupPose.rotation));
      thigh.pose.rotation = thighLocal;
      sk.updateWorldTransform(spine.Physics.none);
      const shinParent = thigh.appliedPose.getWorldRotationX();
      // Direction of the shin bone at setup relative to the thigh->shin joint line is folded into its local rotation.
      const shinOffset = shin.appliedPose.getWorldRotationX() - shinParent - shin.pose.rotation;
      const shinLocal = wrapDeg(shinWorld - shinParent - shinOffset);
      push(`${l.shin}.r`, wrapDeg(shinLocal - shin.data.setupPose.rotation));
      shin.pose.rotation = shinLocal;
      if (l.foot) {
        sk.updateWorldTransform(spine.Physics.none);
        const foot = sk.findBone(l.foot)!;
        // Level with the ground as at setup, toes lifting a little through the swing.
        const setupWorld = leg0.length ? footSetupWorld(skeleton, l.foot) : 0;
        const swingTilt = fy > 0 ? facing * 12 * (fy / lift) : 0;
        const local = wrapDeg(setupWorld + swingTilt - shin.appliedPose.getWorldRotationX());
        push(`${l.foot}.r`, wrapDeg(local - foot.data.setupPose.rotation));
      }
    });
    sk.updateWorldTransform(spine.Physics.none);
    (o.arms ?? []).forEach((a, i) => {
      const angle = (a.swing ?? (front ? 7 : run ? 30 : 18)) * Math.sin(2 * Math.PI * (t / period) + (i % 2 ? Math.PI : 0)) * facing;
      const setup = armSetup.get(a.bone);
      if (!setup) { push(`${a.bone}.r`, angle); return; }
      // Rotate the shoulder->target vector by the swing (and the hip's lean), around the shoulder where it is now.
      const sh = sk.findBone(a.bone)!.appliedPose, rad = ((angle - facing * lean) * Math.PI) / 180;
      const vx = setup.target[0] - setup.shoulder[0], vy = setup.target[1] - setup.shoulder[1];
      const tx = sh.worldX + vx * Math.cos(rad) - vy * Math.sin(rad), ty = sh.worldY + vx * Math.sin(rad) + vy * Math.cos(rad);
      // The mover carries the target: move it by the same amount the target has to move.
      const mover = sk.findBone(setup.mover)!, mpar = mover.parent!.appliedPose, d2 = mpar.a * mpar.d - mpar.b * mpar.c || 1;
      const wx = setup.moverWorld[0] + (tx - setup.target[0]), wy = setup.moverWorld[1] + (ty - setup.target[1]);
      const lx = wx - mpar.worldX, ly = wy - mpar.worldY;
      push(`${setup.mover}.x`, (mpar.d * lx - mpar.b * ly) / d2 - mover.data.setupPose.x);
      push(`${setup.mover}.y`, (-mpar.c * lx + mpar.a * ly) / d2 - mover.data.setupPose.y);
    });
  }
  };
  record();
  const anim: AnimationJson = { bones: {} };
  const tl = (bone: string) => (anim.bones![bone] ??= {});
  const emit = (bone: string, prop: "rotate" | "translate" | "scale", fields: string[], keys: string[], tol: number) => {
    const s = keys.map((k) => series[k]!);
    if (s.some((x) => !x)) return;
    const kind: ValueKind = prop === "rotate" ? "angle" : prop === "scale" ? "precise" : prop;
    const fit = fitBezier(times, s.map((values) => ({ values, tol, kind })), { loop: true });
    tl(bone)[prop] = fit.keys.map((i, n) => {
      const key: Key = { ...(times[i] ? { time: times[i]! } : {}) };
      fields.forEach((f, c) => (key[f] = fit.values[n]![c]!));
      if (fit.curves[n]) key.curve = fit.curves[n]!;
      return key;
    });
  };
  const footTol = Math.max(0.4, legLen * 0.002);
  const emitLeg = (l: WalkLeg, i: number) => {
    const th = series[`${l.thigh}.r`], sh = series[`${l.shin}.r`];
    if (!th || !sh) return;
    const g = leg0[i]!, sj = sk.findBone(l.shin)!.data.setupPose, bendOffset = sj.rotation - Math.atan2(sj.y, sj.x) * DEG;
    const tipOf = (a: number, b: number): [number, number] => { const a1 = a / DEG, a2 = (a + b + bendOffset) / DEG; return [g.l1 * Math.cos(a1) + g.l2 * Math.cos(a2), g.l1 * Math.sin(a1) + g.l2 * Math.sin(a2)]; };
    const miss = (f: number[], r: number[]) => { const p = tipOf(f[0]!, f[1]!), q = tipOf(r[0]!, r[1]!); return Math.hypot(p[0] - q[0], p[1] - q[1]); };
    const roundKey = (_: number, raw: number[]) => {
      for (const step of [1, 0.5, 0.1, 0.01]) {
        const near = (v: number) => [Math.floor(v / step) * step, Math.ceil(v / step) * step].map((x) => +x.toFixed(2));
        let best: number[] = raw, err = Infinity;
        for (const a of near(raw[0]!)) for (const b of near(raw[1]!)) { const e = miss([a, b], raw); if (e < err - 1e-9) { err = e; best = [a, b]; } }
        if (err <= footTol) return best;
      }
      return raw.map((v) => +v.toFixed(2));
    };
    const fit = fitBezier(times, [{ values: th, tol: 0.15 }, { values: sh, tol: 0.15 }], { loop: true, roundKey, measure: (_, f, r) => miss(f, r) / footTol });
    fit.keys.forEach((k, n) => {
      for (const [c, bone] of [l.thigh, l.shin].entries()) {
        const key: Key = { ...(times[k] ? { time: times[k]! } : {}), value: fit.values[n]![c]! };
        if (fit.curves[n]) key.curve = fit.curves[n]!.slice(c * 4, c * 4 + 4);
        ((tl(bone).rotate ??= []) as Key[]).push(key);
      }
    });
  };
  emit(o.hip, "translate", ["x", "y"], ["hip.x", "hip.y"], 0.1);
  if (lean) emit(o.hip, "rotate", ["value"], ["hip.r"], 0.1);
  record(anim.bones![o.hip]);
  for (const l of o.legs) {
    const ik = ikFor(l);
    if (ik) { const m = moverOf(sk, ik.target.name, l.thigh).data.name; emit(m, "translate", ["x", "y"], [`${m}.x`, `${m}.y`], 0.1); }
  }
  if (front && o.legs.some((l) => ikFor(l))) record(anim.bones![o.hip], anim.bones);
  for (const l of o.legs) {
    if (!ikFor(l)) emitLeg(l, o.legs.indexOf(l));
    if (l.foot && series[`${l.foot}.r`]) emit(l.foot, "rotate", ["value"], [`${l.foot}.r`], 0.15);
    if (series[`${l.thigh}.sx`]) emit(l.thigh, "scale", ["x", "y"], [`${l.thigh}.sx`, "one"], 0.002);
  }
  for (const a of o.arms ?? []) {
    const setup = armSetup.get(a.bone);
    if (setup) emit(setup.mover, "translate", ["x", "y"], [`${setup.mover}.x`, `${setup.mover}.y`], 0.1);
    else emit(a.bone, "rotate", ["value"], [`${a.bone}.r`], 0.15);
  }
  if (bendFor.size) anim.ik = Object.fromEntries([...bendFor].map(([name, positive]) => [name, [{ bendPositive: positive }]]));
  if (o.footstepEvent) {
    checkEventNames(skeleton, [o.footstepEvent]);
    // Heel contact: phase 0 for the first leg, half a cycle later for the second.
    anim.events = o.legs.map((l, i) => ({ ...(i ? { time: snapTime(period / 2, fps) } : {}), name: o.footstepEvent!, string: l.thigh }));
  }
  const viaIk = o.legs.filter((l) => ikFor(l)).map((l) => ikFor(l)!.name);
  // Front-view knees: which legs keep the rig's bend, which were bent outward.
  const frontKnees = () => {
    const kept = o.legs.filter((_, i) => setupBend[i]).map((l) => l.shin), keyed = [...bendFor].map(([n, b]) => `${n} ${b ? "positive" : "negative"}`);
    return [kept.length ? `knees keep the rig's setup bend (${kept.join(", ")}), so legs drawn straight stay straight` : "", keyed.length ? `knees bend outward (IK bend keyed: ${keyed.join(", ")})` : ""].filter(Boolean).join("; ") || "knees bend outward";
  };
  return {
    animation: anim,
    footError,
    notes: [
      front
        ? `${run ? "Run" : "Walk"} in place facing the camera: ${period}s per two steps, foot lift ${lift.toFixed(1)}, hip bob ${bob.toFixed(1)}, sway ${sway.toFixed(1)} toward the standing leg, hip ${crouch.toFixed(1)} lower than setup; ${frontKnees()}.`
        : `${run ? "Run" : "Walk"} cycle in place: ${period}s per two steps, stride ${stride.toFixed(1)}, foot lift ${lift.toFixed(1)}, hip bob ${bob.toFixed(1)}, hip ${crouch.toFixed(1)} lower than setup${lean ? `, lean ${lean} degrees` : ""}; feet planted for ${Math.round(stance * 100)}% of each step${run ? " with a flight phase" : ""}.`,
      ...(armSetup.size ? [`Arms driven by the rig's IK swing through their targets on an arc around the shoulder (${[...armSetup.values()].map((a) => a.mover).join(", ")}).`] : []),
      viaIk.length ? `Legs driven through the rig's IK (${viaIk.join(", ")}): their targets are keyed (${o.legs.filter((l) => ikFor(l)).map((l) => moverOf(sk, ikFor(l)!.target.name, l.thigh).data.name).join(", ")}).` : "Legs solved as two-bone IK every frame (knees toward the facing direction) and keyed as rotations.",
      ...(footError > 0.5 ? [`The planned step is ${footError.toFixed(1)} units beyond the leg's reach at full extension: give a shorter stride or a lower hip.`] : []),
      ...(front ? [] : ["In place: move the character in the game at stride / (period / 2) units per second so the planted foot does not slide."]),
    ],
  };
}

function footSetupWorld(skeleton: SkeletonJson, bone: string): number {
  const sk = new spine.Skeleton(loadSkeletonData(skeleton));
  sk.setupPose();
  sk.updateWorldTransform(spine.Physics.none);
  return sk.findBone(bone)!.appliedPose.getWorldRotationX();
}

/** The bone to key for an IK target: its highest ancestor that is still below the root. */
function moverOf(sk: spine.Skeleton, target: string, thigh?: string): spine.Bone {
  // Never climb into the leg's own chain (a target parented under the hip moves by itself).
  const chain = new Set<string>();
  for (let t = thigh ? sk.findBone(thigh) : null; t; t = t.parent) chain.add(t.data.name);
  let b = sk.findBone(target)!;
  while (b.parent && b.parent.parent && !chain.has(b.parent.data.name)) b = b.parent;
  return b;
}

/** Legs (upper + lower pairs found by name), the hip that carries them and upper arms, as a starting point. */
export function suggestWalk(skeleton: SkeletonJson): { legs: WalkLeg[]; hip: string | null; arms: string[] } {
  const bones = skeleton.bones;
  const upper = bones.filter((b) => /(thigh|upper[-_ ]?leg|leg[-_ ]?upper)/i.test(b.name));
  const legs: WalkLeg[] = [];
  for (const t of upper) {
    const shin = bones.find((b) => b.parent === t.name && /(shin|calf|lower[-_ ]?leg|leg[-_ ]?lower|knee|leg)/i.test(b.name)) ?? bones.find((b) => b.parent === t.name);
    if (!shin) continue;
    const foot = bones.find((b) => b.parent === shin.name && /(foot|ankle|toe|boot)/i.test(b.name));
    legs.push({ thigh: t.name, shin: shin.name, ...(foot ? { foot: foot.name } : {}) });
  }
  const parents = [...new Set(legs.map((l) => bones.find((b) => b.name === l.thigh)!.parent))];
  const hip = bones.find((b) => /(hip|pelvis)/i.test(b.name))?.name ?? (parents.length === 1 ? parents[0] ?? null : null);
  return { legs: legs.slice(0, 4), hip, arms: bones.filter((b) => /(upper[-_ ]?arm|arm[-_ ]?upper)/i.test(b.name)).map((b) => b.name).slice(0, 4) };
}
