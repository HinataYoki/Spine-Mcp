// Face motion beyond blinks: eye darts (saccades) between fixations with a slow drift while the eyes rest.
import { easedCurve, EASINGS } from "./curves.js";
import { turningKeys } from "./generate.js";
import { loadSkeletonData, spine } from "./runtime.js";
import { toFourDecimals, projectFps, roundValue, snapTime, tidyGenerated } from "./tidy.js";
import type { AnimationJson, Key, SkeletonJson } from "./types.js";

export interface GazeOptions {
  /** Bones that move the eyes, all by the same offset: a look control bone, or the pupils. */
  bones: string[];
  /** Where the eyes rest: offsets from the setup pose in skeleton space (x right, y up), from `time`. */
  fixations?: { time: number; x: number; y: number }[];
  /** Without fixations: this many, placed at random (seeded) inside `radius` (default 5 per 4 s). */
  count?: number;
  seed?: number;
  /** Largest offset for random fixations (default 2% of the skeleton height); vertical moves are kept to 60%. */
  radius?: number;
  /** Loop length (default 4 s, or the last fixation + 1 s). */
  duration?: number;
  /** Dart time (default 0.1 s, fast out, settling in). */
  dart?: number;
  /** Drift while the eyes rest, as a share of the radius (default 0.12): eyes never sit perfectly still. */
  drift?: number;
  /** Brows that lift on each look away from rest (inner bones; a `<bone>-outer` child arches), and dip at given blink starts. */
  brows?: { bones: string[]; lift?: number; arch?: number; dip?: number; dips?: number[] };
}

const r3 = toFourDecimals;

/** Deterministic random numbers in [0, 1) (mulberry32): the same seed gives the same gaze. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Where a bone can move before a clamped transform constraint it drives stops following: per axis, the range of its
 * local translation (offset from setup) for which every clamped x / y target stays inside [offset, max]. Past it the
 * driven bone stands still, and two eyes with different limits stop at different points (they diverge).
 */
export function clampBox(data: spine.SkeletonData, bone: string): { x: [number, number]; y: [number, number]; constraints: string[] } | null {
  const b = data.findBone(bone);
  if (!b) return null;
  const box = { x: [-Infinity, Infinity] as [number, number], y: [-Infinity, Infinity] as [number, number] };
  const names: string[] = [];
  for (const c of data.constraints) {
    if (!(c instanceof spine.TransformConstraintData) || c.source !== b || !c.clamp || !c.localSource) continue;
    for (const from of c.properties) {
      const axis = from instanceof spine.FromX ? "x" : from instanceof spine.FromY ? "y" : null;
      if (!axis) continue;
      const setup = axis === "x" ? b.setupPose.x : b.setupPose.y;
      for (const to of from.to) {
        if (!(to instanceof spine.ToX || to instanceof spine.ToY) || !to.scale) continue;
        const lo = Math.min(to.offset, to.max), hi = Math.max(to.offset, to.max);
        const v1 = from.offset + (lo - to.offset) / to.scale - setup, v2 = from.offset + (hi - to.offset) / to.scale - setup;
        box[axis] = [Math.max(box[axis][0], Math.min(v1, v2)), Math.min(box[axis][1], Math.max(v1, v2))];
        if (!names.includes(c.name)) names.push(c.name);
      }
    }
  }
  return names.length ? { ...box, constraints: names } : null;
}

/**
 * Saccades: the eyes dart to each fixation in `dart` seconds (ease out), then drift a little until the next one, and
 * come back to where they started at the loop end. Keys sit on the frame grid. Offsets are skeleton-space, written as
 * translate keys in each bone's parent space; when the first bone drives clamped transform constraints (a look control
 * bone), fixations are placed, or pulled, inside the range where every driven bone still follows.
 */
export function gaze(skeleton: SkeletonJson, o: GazeOptions): { animation: AnimationJson; notes: string[] } {
  if (!o.bones.length) throw new Error("gaze needs the bones that move the eyes (a look control bone or the pupils)");
  const data = loadSkeletonData(skeleton);
  for (const b of o.bones) if (!data.findBone(b)) throw new Error(`Unknown bone: ${b}`);
  const fps = projectFps(skeleton), fr = (t: number) => snapTime(t, fps);
  const height = skeleton.skeleton.height ?? 300;
  const box = clampBox(data, o.bones[0]!);
  const finite = box && [...box.x, ...box.y].every(Number.isFinite);
  const radius = o.radius ?? (finite ? roundValue("translate", Math.max(box!.x[1] - box!.x[0], box!.y[1] - box!.y[0]) / 2) : Math.max(1, roundValue("translate", height * 0.02)));
  const dart = fr(o.dart ?? 3 / fps) || 1 / fps, driftShare = o.drift ?? 0.12;
  const rnd = random(o.seed ?? 1);
  const sk = new spine.Skeleton(data);
  sk.setupPose();
  sk.updateWorldTransform(spine.Physics.none);
  const parentOf = (b: string) => sk.findBone(b)!.parent?.appliedPose;
  const toLocal = (b: string, x: number, y: number): [number, number] => {
    const par = parentOf(b);
    if (!par) return [x, y];
    const det = par.a * par.d - par.b * par.c || 1;
    return [(par.d * x - par.b * y) / det, (-par.c * x + par.a * y) / det];
  };
  // Inside the box (a little margin), in the first bone's local space.
  const inBox = (p: [number, number]): [number, number] => {
    if (!box) return p;
    const pad = (r: [number, number]) => { const m = Number.isFinite(r[1] - r[0]) ? (r[1] - r[0]) * 0.05 : 0; return [r[0] + m, r[1] - m] as const; };
    const [x0, x1] = pad(box.x), [y0, y1] = pad(box.y);
    return [Math.min(x1, Math.max(x0, p[0])), Math.min(y1, Math.max(y0, p[1]))];
  };
  let pulled = 0;
  let fix: { time: number; x: number; y: number }[] = (o.fixations ?? []).map((f) => ({ ...f, time: fr(f.time) })).sort((a, b) => a.time - b.time);
  const duration = o.duration ?? (fix.length ? fr(fix[fix.length - 1]!.time + 1) : 4);
  if (!fix.length) {
    const count = o.count ?? Math.max(1, Math.round((duration / 4) * 5));
    // Rests of uneven length; each dart moves at least 40% of the radius so it reads as a look.
    const rests = Array.from({ length: count + 1 }, () => 0.5 + rnd() * 1.1);
    const scale = (duration - dart) / rests.reduce((a, b) => a + b, 0);
    let t = 0, prev: [number, number] = box ? inBox([0, 0]) : [0, 0];
    for (let i = 0; i < count; i++) {
      t += rests[i]! * scale;
      let p: [number, number] = [0, 0];
      for (let tries = 0; tries < 20; tries++) {
        if (finite) {
          p = inBox([box!.x[0] + rnd() * (box!.x[1] - box!.x[0]), box!.y[0] + rnd() * (box!.y[1] - box!.y[0])]);
        } else {
          const a = rnd() * 2 * Math.PI, d = Math.sqrt(0.3 + 0.7 * rnd());
          p = [Math.cos(a) * d * radius, Math.sin(a) * d * radius * 0.6];
          if (box) { const l = inBox(toLocal(o.bones[0]!, p[0], p[1])); p = l; }
        }
        if (Math.hypot(p[0] - prev[0], p[1] - prev[1]) >= 0.4 * radius) break;
      }
      fix.push({ time: fr(t), x: p[0], y: p[1] });
      prev = p;
    }
  } else if (box) {
    // Given in skeleton space: into the first bone's local space, pulled inside the box.
    fix = fix.map((f) => { const l = toLocal(o.bones[0]!, f.x, f.y), c = inBox(l); if (Math.hypot(c[0] - l[0], c[1] - l[1]) > 1e-6) pulled++; return { time: f.time, x: c[0], y: c[1] }; });
  }
  if (fix[0]!.time < 0) throw new Error("fixation times must be >= 0");
  for (let i = 1; i < fix.length; i++) if (fix[i]!.time < fix[i - 1]!.time + dart) throw new Error(`Fixations at ${fix[i - 1]!.time}s and ${fix[i]!.time}s are closer than a dart (${dart}s)`);
  if (fix[fix.length - 1]!.time + 2 * dart > duration) throw new Error(`The last fixation (${fix[fix.length - 1]!.time}s) leaves no time to dart back before ${duration}s`);
  // Positions over time (local to the first bone with a box, else skeleton space): rest, dart to each fixation,
  // drift, dart back at the end.
  type P = { time: number; x: number; y: number; dart: boolean };
  const rest: [number, number] = [0, 0];
  const path: P[] = [{ time: 0, x: rest[0], y: rest[1], dart: false }];
  let cur: [number, number] = rest;
  const driftTo = (base: { x: number; y: number }): [number, number] => {
    const a = rnd() * 2 * Math.PI;
    const p: [number, number] = [base.x + Math.cos(a) * driftShare * radius, base.y + Math.sin(a) * driftShare * radius * 0.6];
    return box ? inBox(p) : p;
  };
  for (const [i, f] of fix.entries()) {
    const next = i + 1 < fix.length ? fix[i + 1]!.time : duration - dart;
    if (f.time > 0) path.push({ time: f.time, x: cur[0], y: cur[1], dart: false });
    path.push({ time: fr(f.time + dart), x: f.x, y: f.y, dart: true });
    cur = driftTo(f);
    if (next - (f.time + dart) <= 0.05) cur = [f.x, f.y]; // no time to drift
  }
  path.push({ time: fr(duration - dart), x: cur[0], y: cur[1], dart: false }, { time: fr(duration), x: rest[0], y: rest[1], dart: true });
  const anim: AnimationJson = { bones: {} };
  const out = EASINGS.easeOutCubic!;
  for (const b of o.bones) {
    const keys: Key[] = path.map((p) => { const [x, y] = box ? [p.x, p.y] : toLocal(b, p.x, p.y); return { ...(p.time ? { time: p.time } : {}), x, y }; });
    // Darts ease out; drifts stay linear.
    for (let i = 0; i + 1 < keys.length; i++) {
      if (path[i + 1]!.dart) keys[i]!.curve = easedCurve(keys[i]!, keys[i + 1]!, ["x", "y"], 0, out);
    }
    const dedup = keys.filter((k, i) => i === keys.length - 1 || (keys[i + 1]!.time ?? 0) !== (k.time ?? 0));
    anim.bones![b] = { translate: dedup };
  }
  const browNotes = o.brows?.bones.length ? addBrows(skeleton, sk, anim, o.brows, fix, duration, dart, fps, toLocal) : [];
  const notes = [
    `${fix.length} fixation(s) over ${duration}s (${fix.map((f) => `${r3(f.time)}s (${r3(f.x)}, ${r3(f.y)})`).slice(0, 8).join(", ")}${fix.length > 8 ? ", ..." : ""}): darts of ${r3(dart)}s (${Math.round(dart * fps)} frames, ease out), a drift of up to ${r3(driftShare * radius)} units while resting, back to the start at the loop end. Keys on the ${fps} fps frame grid.`,
    box
      ? `${o.bones[0]} drives clamped transform constraints (${box.constraints.join(", ")}): its offsets stay within x ${r3(box.x[0])}..${r3(box.x[1])}, y ${r3(box.y[0])}..${r3(box.y[1])} (local), where every driven bone still follows${pulled ? `; ${pulled} fixation(s) pulled inside` : ""}. Past that range the driven bones stop (and eyes with different limits diverge).`
      : `Moves ${o.bones.join(", ")} by the same skeleton-space offset${o.fixations?.length ? "" : ` (random inside ${radius} units, seed ${o.seed ?? 1})`}. Check that the pupils stay inside the eyes with spine_render_frames.`,
    "Play it on its own track over the idle, or with blink: dart the eyes while the lids are shut to hide a big look change.",
    ...browNotes,
  ];
  const given = [...(o.fixations ?? []).flatMap((f) => [f.x, f.y]), o.brows?.lift, o.brows?.arch, o.brows?.dip];
  return tidyGenerated({ animation: anim, notes }, fps, given);
}

const smooth = (x: number) => { const k = Math.min(1, Math.max(0, x)); return k * k * (3 - 2 * k); };

function addBrows(skeleton: SkeletonJson, sk: InstanceType<typeof spine.Skeleton>, anim: AnimationJson, o: NonNullable<GazeOptions["brows"]>, fix: { time: number; x: number; y: number }[], duration: number, dart: number, fps: number, toLocal: (b: string, x: number, y: number) => [number, number]): string[] {
  for (const b of o.bones) if (!sk.findBone(b)) throw new Error(`Unknown brow bone: ${b}`);
  const lift = o.lift ?? roundValue("translate", (skeleton.skeleton.height ?? 300) * 0.0025), arch = o.arch ?? 4, dip = o.dip ?? lift, f = 1 / fps;
  const up = dart + 2 * f, down = 6 * f, dips = [...(o.dips ?? [])].sort((a, b) => a - b);
  for (const s of dips) if (s < 0 || s + 9 * f > duration + 1e-6) throw new Error(`Brow dip at ${s}s does not fit in ${duration}s`);
  const ramps: { at: number; from: number; to: number; len: number }[] = [];
  let state = 0;
  for (const p of fix) {
    const away = Math.hypot(p.x, p.y) > 1e-6 ? 1 : 0;
    if (away !== state) { ramps.push({ at: p.time, from: state, to: away, len: away ? up : down }); state = away; }
  }
  if (state) ramps.push({ at: duration - down, from: 1, to: 0, len: down });
  const look = (t: number) => { let v = 0; for (const r of ramps) if (t >= r.at) v = r.from + (r.to - r.from) * smooth((t - r.at) / r.len); return v; };
  const sink = (t: number) => { let v = 0; for (const s of dips) { if (t < s || t > s + 9 * f) continue; v = Math.max(v, t < s + 2 * f ? smooth((t - s) / (2 * f)) : t < s + 4 * f ? 1 : 1 - smooth((t - s - 4 * f) / (5 * f))); } return v; };
  const marks = [...ramps.flatMap((r) => [r.at, r.at + r.len]), ...dips.flatMap((s) => [s, s + 2 * f, s + 4 * f, s + 9 * f])];
  const height = (t: number) => lift * look(t) - dip * sink(t);
  const valueKeys = turningKeys(height, duration, fps, 0.01, marks);
  const archKeys = turningKeys((t) => look(t), duration, fps, 0.01, ramps.flatMap((r) => [r.at, r.at + r.len]));
  const arched: string[] = [];
  for (const b of o.bones) {
    const [ux, uy] = toLocal(b, 0, 1), n = Math.hypot(ux, uy) || 1;
    const translate = valueKeys.map((k) => {
      const v = (k as { value: number }).value, c = (k as { curve?: number[] }).curve;
      return { ...(k.time ? { time: k.time } : {}), x: (ux / n) * v, y: (uy / n) * v, ...(c ? { curve: [c[0]!, r3((ux / n) * c[1]!), c[2]!, r3((ux / n) * c[3]!), c[0]!, r3((uy / n) * c[1]!), c[2]!, r3((uy / n) * c[3]!)] } : {}) };
    });
    anim.bones![b] = { ...(anim.bones![b] ?? {}), translate };
    const outer = sk.findBone(`${b}-outer`);
    if (outer && arch) {
      const p = outer.appliedPose, sign = p.a >= 0 ? 1 : -1;
      anim.bones![outer.data.name] = { rotate: archKeys.map((k) => { const v = (k as { value: number }).value, c = (k as { curve?: number[] }).curve; return { ...(k.time ? { time: k.time } : {}), value: sign * arch * v, ...(c ? { curve: [c[0]!, r3(sign * arch * c[1]!), c[2]!, r3(sign * arch * c[3]!)] } : {}) }; }) };
      arched.push(outer.data.name);
    }
  }
  return [`Brows (${o.bones.join(", ")}): up ${lift} units on each look away from rest (in ${r3(up)}s), back in ${r3(down)}s${dips.length ? `; down ${dip} at ${dips.map((s) => `${r3(s)}s`).join(", ")} (2 frames down, 2 held, 5 back)` : ""}${arched.length ? `; ${arched.join(", ")} arch ${arch}° on the looks (outer end up)` : ""}. Keys at the turns and plateaus.`];
}
