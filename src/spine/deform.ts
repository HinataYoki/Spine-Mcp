// Deform generators: mesh vertex keys (written through the animation import, so safe on existing projects).
import { animationDuration } from "./inspect.js";
import { loadSkeletonData, spine } from "./runtime.js";
import { fitBezier, framesOf, projectFps, snapTime, tidyGenerated } from "./tidy.js";
import type { AnimationJson, Key, SkeletonJson } from "./types.js";

type M2 = [number, number, number, number];

/** A mesh as the setup pose draws it: world vertices and, per vertex, the bone frames its deform offsets go through. */
export interface MeshTarget {
  skin: string;
  slot: string;
  attachment: string;
  world: number[];
  entries: { m: M2; w: number }[][];
  length: number;
}

/** The mesh shown in each slot at the setup pose (default skin first), with what is needed to turn world moves into deform values. */
export function meshTargets(skeleton: SkeletonJson, slots: string[]): { meshes: MeshTarget[]; skipped: string[] } {
  const data = loadSkeletonData(skeleton);
  const sk = new spine.Skeleton(data);
  sk.setupPose();
  sk.updateWorldTransform(spine.Physics.none);
  const meshes: MeshTarget[] = [], skipped: string[] = [];
  for (const name of slots) {
    const slot = sk.findSlot(name);
    if (!slot) throw new Error(`Unknown slot: ${name}`);
    const attName = slot.data.attachmentName;
    const skins = [data.defaultSkin, ...data.skins].filter((s): s is spine.Skin => !!s);
    const skin = skins.find((s) => attName && s.getAttachment(slot.data.index, attName));
    const att = skin && attName ? skin.getAttachment(slot.data.index, attName) : null;
    if (!(att instanceof spine.MeshAttachment)) { skipped.push(`${name} (${att ? "not a mesh" : "no attachment at setup"})`); continue; }
    const world = new Array<number>(att.worldVerticesLength).fill(0);
    att.computeWorldVertices(sk, slot, 0, att.worldVerticesLength, world, 0, 2);
    const matrix = (b: spine.Bone): M2 => { const p = b.appliedPose; return [p.a, p.b, p.c, p.d]; };
    const count = att.worldVerticesLength / 2, entries: { m: M2; w: number }[][] = [];
    let length: number;
    if (!att.bones) {
      for (let i = 0; i < count; i++) entries.push([{ m: matrix(slot.bone), w: 1 }]);
      length = att.vertices.length;
    } else {
      let e = 0;
      for (let i = 0, b = 0; i < count; i++) {
        const n = att.bones[b++]!, list: { m: M2; w: number }[] = [];
        for (let k = 0; k < n; k++, b++, e++) list.push({ m: matrix(sk.bones[att.bones[b]!]!), w: att.vertices[e * 3 + 2]! });
        entries.push(list);
      }
      length = e * 2;
    }
    meshes.push({ skin: skin!.name, slot: name, attachment: attName!, world, entries, length });
  }
  return { meshes, skipped };
}

/**
 * Deform values that move each vertex by a world-space displacement at the setup pose: every weight entry gets the
 * displacement in its own bone's frame (the weights add up to one, so the vertex moves by exactly that much).
 */
export function deformValues(mesh: MeshTarget, displacement: (x: number, y: number, i: number) => [number, number]): number[] {
  const out: number[] = [];
  mesh.entries.forEach((list, i) => {
    const [dx, dy] = displacement(mesh.world[i * 2]!, mesh.world[i * 2 + 1]!, i);
    for (const { m } of list) {
      const det = m[0] * m[3] - m[1] * m[2] || 1;
      // Spine stores tiny deform values as zero; doing the same keeps the written keys equal to what it reads back.
      const clip = (v: number) => (Math.abs(v) < 0.01 ? 0 : +v.toFixed(2));
      out.push(clip((m[3] * dx - m[1] * dy) / det), clip((-m[2] * dx + m[0] * dy) / det));
    }
  });
  return out;
}

const deformKey = (time: number, values: number[]): Key => {
  const k: Key = { ...(time ? { time: +time.toFixed(6) } : {}) };
  // Leading and trailing zeros are left out (offset), as Spine writes them.
  let a = 0, b = values.length;
  while (a < b && values[a] === 0) a++;
  while (b > a && values[b - 1] === 0) b--;
  if (a < b) { if (a) k.offset = a; k.vertices = values.slice(a, b); }
  return k;
};

function setDeform(anim: AnimationJson, m: MeshTarget, keys: Key[]) {
  ((((anim.attachments ??= {})[m.skin] ??= {})[m.slot] ??= {})[m.attachment] ??= {}).deform = keys;
}

/**
 * Bones that sit on deformed meshes without being drawn by them (an antenna on a squashed head, shoulders and hips on a
 * squashed torso): deform keys move the mesh, not the bones, so these would come off. Each gets translate keys equal to
 * the mesh displacement at its setup origin, in its parent's setup frame, at the deform key times.
 */
function riderKeys(skeleton: SkeletonJson, anim: AnimationJson, slots: string[], stops: { time: number; curve?: Key["curve"] }[], displacement: (x: number, y: number, stop: number) => [number, number], exclude: Set<string> = new Set()): { moved: string[]; skipped: string[] } {
  const data = loadSkeletonData(skeleton);
  const sk = new spine.Skeleton(data);
  sk.setupPose();
  sk.updateWorldTransform(spine.Physics.none);
  const drawn = new Set(slots.map((s) => sk.findSlot(s)?.bone.data.name).filter((b): b is string => !!b));
  const slotBones = new Set(sk.slots.map((s) => s.bone.data.name));
  const moved: string[] = [], skipped: string[] = [];
  for (const bone of sk.bones) {
    const name = bone.data.name, parent = bone.parent;
    if (!parent || !drawn.has(parent.data.name) || drawn.has(name) || exclude.has(name)) continue;
    // Only bones that carry art of their own (or have children that do); bare helper bones are left alone.
    const carries = (b: spine.Bone): boolean => slotBones.has(b.data.name) || b.children.some(carries);
    if (!carries(bone)) continue;
    if (anim.bones?.[name]?.translate) { skipped.push(name); continue; }
    const p = bone.appliedPose, q = parent.appliedPose, det = q.a * q.d - q.b * q.c || 1;
    const keys = stops.map((st, i) => {
      const [dx, dy] = displacement(p.worldX, p.worldY, i);
      // Spine writes translate values this small as 0 (as for deform, G84): do the same so the write verifies.
      const clip = (v: number) => (Math.abs(v) < 0.01 ? 0 : +v.toFixed(4));
      const k: Key = { ...(st.time ? { time: +st.time.toFixed(6) } : {}), x: clip((q.d * dx - q.b * dy) / det), y: clip((-q.c * dx + q.a * dy) / det) };
      if (st.curve === "stepped") k.curve = st.curve;
      return k;
    });
    keys.forEach((k, i) => {
      const c = stops[i]!.curve, next = keys[i + 1];
      if (!Array.isArray(c) || c.length !== 4 || !next) return;
      k.curve = (["x", "y"] as const).flatMap((f) => { const a = k[f] as number, b = next[f] as number; return [c[0]!, +(a + c[1]! * (b - a)).toFixed(4), c[2]!, +(a + c[3]! * (b - a)).toFixed(4)]; });
    });
    if (keys.every((k) => Math.abs(k.x as number) < 1e-3 && Math.abs(k.y as number) < 1e-3)) continue;
    // Two keys at one time would be merged by Spine on import: the later one wins.
    ((anim.bones ??= {})[name] ??= {}).translate = keys.filter((k, i) => i === keys.length - 1 || (keys[i + 1]!.time ?? 0) !== (k.time ?? 0));
    moved.push(name);
  }
  return { moved, skipped };
}

export interface TurnPose { time: number; /** Left/right turn, degrees (positive turns toward +x). */ yaw?: number; /** Up/down, degrees (positive looks up). */ pitch?: number }

export interface TurnOptions {
  /** The face mesh(es): their bounds set the head's sphere. */
  face: string[];
  /** Features drawn on the face (eyes, nose, mouth, ears...), each with a depth: how far in front of the face it sits (0-1 of the radius, default 0.2). */
  features?: { slot: string; depth?: number }[];
  poses: TurnPose[];
  /** Total length; with loop (default true) it returns to the start. */
  duration?: number;
  loop?: boolean;
  /** Seconds a turn takes (default 0.35). */
  turnTime?: number;
}

/**
 * A 2.5D head turn by mesh deform: every vertex is placed on a sphere around the face (centre and radius from the face
 * meshes' setup bounds) and the sphere turns, so the near side widens, the far side compresses and features in front
 * of the face (by their depth) slide further than the face itself. Keys at each pose, eased in between.
 */
export function headTurn(skeleton: SkeletonJson, o: TurnOptions): { animation: AnimationJson; notes: string[] } {
  if (!o.face.length) throw new Error("turn needs the face mesh slot(s)");
  if (!o.poses.length) throw new Error("turn needs at least one pose ({time, yaw?, pitch?})");
  const featureSlots = (o.features ?? []).map((f) => f.slot);
  const { meshes, skipped } = meshTargets(skeleton, [...o.face, ...featureSlots]);
  const faces = meshes.filter((m) => o.face.includes(m.slot));
  if (!faces.length) throw new Error(`No face mesh: ${skipped.join(", ")}`);
  const xs = faces.flatMap((m) => m.world.filter((_, i) => i % 2 === 0)), ys = faces.flatMap((m) => m.world.filter((_, i) => i % 2 === 1));
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const rx = (Math.max(...xs) - Math.min(...xs)) / 2 || 1, ry = (Math.max(...ys) - Math.min(...ys)) / 2 || 1;
  const depthOf = (slot: string) => o.features?.find((f) => f.slot === slot)?.depth ?? (o.face.includes(slot) ? 0 : 0.2);
  const rad = (d: number) => (d * Math.PI) / 180;
  // A point on an ellipsoid shell (radius scaled by 1 + depth), turned by yaw then pitch, projected back. Points outside
  // the shell (an antenna above the head) move rigidly with the nearest point on its rim instead of being flattened.
  const turned = (x: number, y: number, depth: number, yaw: number, pitch: number): [number, number] => {
    const s = 1 + depth;
    let u = (x - cx) / (rx * s), v = (y - cy) / (ry * s);
    const r = Math.hypot(u, v), lim = 0.98;
    if (r > lim) { u *= lim / r; v *= lim / r; }
    const z = Math.sqrt(Math.max(0, 1 - u * u - v * v));
    const u1 = u * Math.cos(rad(yaw)) + z * Math.sin(rad(yaw)), z1 = -u * Math.sin(rad(yaw)) + z * Math.cos(rad(yaw));
    const v1 = v * Math.cos(rad(pitch)) + z1 * Math.sin(rad(pitch));
    return [(u1 - u) * rx * s, (v1 - v) * ry * s];
  };
  const fps = projectFps(skeleton);
  const poses = [...o.poses].map((p) => ({ ...p, time: snapTime(p.time, fps) })).sort((a, b) => a.time - b.time);
  const turn = Math.max(1, framesOf(o.turnTime ?? 10 / 30, fps)) / fps, loop = o.loop ?? true;
  const end = snapTime(o.duration ?? poses[poses.length - 1]!.time + turn + (loop ? turn + 0.5 : 0.5), fps);
  // Key times: each pose is reached `turn` after it starts; the loop returns to rest at the end.
  const stops: { time: number; yaw: number; pitch: number }[] = [{ time: 0, yaw: poses[0]!.time === 0 ? poses[0]!.yaw ?? 0 : 0, pitch: poses[0]!.time === 0 ? poses[0]!.pitch ?? 0 : 0 }];
  for (const p of poses) if (p.time > 0 || stops.length > 1) { stops.push({ time: p.time, yaw: stops[stops.length - 1]!.yaw, pitch: stops[stops.length - 1]!.pitch }, { time: p.time + turn, yaw: p.yaw ?? 0, pitch: p.pitch ?? 0 }); }
  if (loop) { const last = stops[stops.length - 1]!; stops.push({ time: Math.max(last.time, end - turn), yaw: last.yaw, pitch: last.pitch }, { time: end, yaw: stops[0]!.yaw, pitch: stops[0]!.pitch }); }
  else stops.push({ time: end, yaw: stops[stops.length - 1]!.yaw, pitch: stops[stops.length - 1]!.pitch });
  if (stops.some((s, i) => i && s.time < stops[i - 1]!.time - 1e-9)) throw new Error(`Poses overlap: each turn takes ${turn}s; space them out or give a longer duration`);
  const anim: AnimationJson = {};
  const easeCurve = (i: number): Key["curve"] => { if (i >= stops.length - 1) return undefined; const t0 = stops[i]!.time, t1 = stops[i + 1]!.time; return t1 > t0 ? [t0 + (t1 - t0) / 3, 0, t0 + ((t1 - t0) * 2) / 3, 1] : undefined; };
  for (const m of meshes) {
    const d = depthOf(m.slot);
    // Features (eyes, a nose) slide as a whole with their centre, so a long one is not bent by the curve of the sphere.
    const feature = !o.face.includes(m.slot);
    const n = m.world.length / 2;
    const centre: [number, number] = [m.world.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0) / n, m.world.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0) / n];
    const keys = stops.map((s, i) => {
      const k = deformKey(s.time, deformValues(m, (x, y) => (s.yaw || s.pitch ? (feature ? turned(centre[0], centre[1], d, s.yaw, s.pitch) : turned(x, y, d, s.yaw, s.pitch)) : [0, 0])));
      // Ease in and out between stops (a deform curve is one bezier for the key's mix).
      const c = easeCurve(i);
      if (c) k.curve = c;
      return k;
    });
    setDeform(anim, m, keys.filter((k, i) => i === keys.length - 1 || (keys[i + 1]!.time ?? 0) !== (k.time ?? 0)));
  }
  // Bones on the face (an antenna, ears on bones) move with the surface under their origin.
  const riders = riderKeys(skeleton, anim, o.face, stops.map((s, i) => ({ time: s.time, curve: easeCurve(i) })), (x, y, i) => (stops[i]!.yaw || stops[i]!.pitch ? turned(x, y, 0, stops[i]!.yaw, stops[i]!.pitch) : [0, 0]), new Set(featureSlots.map((f) => skeleton.slots?.find((s) => s.name === f)?.bone).filter((b): b is string => !!b)));
  const notes = [
    `2.5D turn on ${meshes.map((m) => `${m.slot}${depthOf(m.slot) ? ` (depth ${depthOf(m.slot)})` : ""}`).join(", ")}: sphere at (${cx.toFixed(1)}, ${cy.toFixed(1)}), radius ${rx.toFixed(1)} x ${ry.toFixed(1)}; ${poses.length} pose(s) over ${end.toFixed(2)}s${loop ? ", back to the start" : ""}.`,
    ...(skipped.length ? [`Not meshes, so not turned: ${skipped.join(", ")}. Mesh them in Spine (deform needs vertices), or move those slots with their bones.`] : []),
    ...(riders.moved.length ? [`Bones on the face move with it: ${riders.moved.join(", ")} (translate keys).`] : []),
    ...(riders.skipped.length ? [`Not moved because they already have translate keys here: ${riders.skipped.join(", ")}.`] : []),
    "Keep turns within about 30 degrees: past that the far side of a flat drawing folds. Hide the far eye or ear with an attachment key for bigger turns.",
  ];
  return tidyGenerated({ animation: anim, notes }, fps);
}

export interface SquashOptions {
  /** Meshes to squash and stretch. */
  slots: string[];
  /** Manual keys: amount > 0 stretches along the axis, < 0 squashes (0.2 = 20%); volume is kept. */
  keys?: { time: number; amount: number }[];
  /** Or from a source animation: stretch with the speed of `bone`, squash when it stops sharply (a landing). */
  source?: AnimationJson;
  bone?: string;
  /** Strength for the automatic mode (default 1): 1 gives about 15% stretch at the fastest moment. */
  strength?: number;
  /** Axis in world degrees (default 90 = vertical). */
  axis?: number;
  /** Where the shape is anchored: bottom (default, feet stay planted), center or top of the meshes' bounds. */
  anchor?: "bottom" | "center" | "top";
  fps?: number;
}

/** Volume-preserving squash and stretch by mesh deform, keyed by hand or derived from how a bone moves in an animation. */
export function squashStretch(skeleton: SkeletonJson, o: SquashOptions): { animation: AnimationJson; notes: string[] } {
  if (!o.slots.length) throw new Error("squash needs the mesh slot(s)");
  if (!o.keys?.length && !o.source) throw new Error("squash needs keys ({time, amount}) or a source animation with a bone");
  const { meshes, skipped } = meshTargets(skeleton, o.slots);
  if (!meshes.length) throw new Error(`No meshes: ${skipped.join(", ")}`);
  const xs = meshes.flatMap((m) => m.world.filter((_, i) => i % 2 === 0)), ys = meshes.flatMap((m) => m.world.filter((_, i) => i % 2 === 1));
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const ay = o.anchor === "top" ? Math.max(...ys) : o.anchor === "center" ? (Math.min(...ys) + Math.max(...ys)) / 2 : Math.min(...ys);
  const ang = ((o.axis ?? 90) * Math.PI) / 180, ux = Math.cos(ang), uy = Math.sin(ang);
  const fps = o.fps ?? projectFps(skeleton);
  let keys: { time: number; amount: number; curve?: number[] }[] = o.keys ? [...o.keys].map((k) => ({ ...k, time: snapTime(k.time, fps) })).sort((a, b) => a.time - b.time) : [];
  keys = keys.filter((k, i) => i === keys.length - 1 || keys[i + 1]!.time !== k.time);
  let base: AnimationJson = {};
  const notes: string[] = [];
  if (!keys.length) {
    if (!o.bone) throw new Error("squash from a source animation needs the bone that drives it (e.g. the hip or body)");
    if (!skeleton.bones.some((b) => b.name === o.bone)) throw new Error(`Unknown bone: ${o.bone}`);
    const dur = animationDuration(o.source!);
    if (!(dur > 0)) throw new Error("The source animation has no length");
    const steps = Math.max(2, framesOf(dur, fps));
    const data = loadSkeletonData({ ...skeleton, animations: { __src: o.source! } as never });
    const sk = new spine.Skeleton(data), anim = data.findAnimation("__src")!;
    const pos: [number, number][] = [];
    for (let f = 0; f <= steps; f++) {
      const t = (dur * f) / steps;
      sk.setupPose();
      anim.apply(sk, t, t, false, null, 1, spine.MixFrom.setup, false, false, false);
      sk.updateWorldTransform(spine.Physics.none);
      const p = sk.findBone(o.bone)!.appliedPose;
      pos.push([p.worldX, p.worldY]);
    }
    // Speed along the axis stretches; a sharp slow-down (deceleration against the motion) squashes.
    const along = pos.map(([x, y]) => x * ux + y * uy);
    const vel = along.map((_, f) => (f === 0 ? along[1]! - along[0]! : f === steps ? along[steps]! - along[steps - 1]! : (along[f + 1]! - along[f - 1]!) / 2) * fps);
    const acc = vel.map((_, f) => (f === 0 || f === steps ? 0 : (vel[f + 1]! - vel[f - 1]!) / 2) * fps);
    const vmax = Math.max(...vel.map(Math.abs), 1e-6), amax = Math.max(...acc.map(Math.abs), 1e-6);
    const k = o.strength ?? 1;
    // Squash only against the anchor side (a bottom-anchored hop squashes on the landing, not at the top of its arc,
    // where it slows down too); a horizontal axis or a centre anchor squashes on stops either way.
    const toward = Math.abs(uy) < 0.3 || o.anchor === "center" ? 0 : (o.anchor === "top" ? 1 : -1) * Math.sign(uy);
    const w = Math.max(1, Math.round(0.2 * fps));
    const cameFrom = (f: number) => { let best = 0; for (let g = Math.max(0, f - w); g <= f; g++) if (Math.abs(vel[g]!) > Math.abs(best)) best = vel[g]!; return Math.sign(best); };
    const raw = vel.map((v, f) => {
      const stretch = 0.15 * k * (Math.abs(v) / vmax);
      // Slowing down against the motion (a landing, a sudden stop) squashes, and wins over the remaining speed.
      const stopping = acc[f]! * v < 0 || (Math.abs(v) < 0.2 * vmax && Math.abs(acc[f]!) > 0.3 * amax);
      const decel = stopping && (toward === 0 || cameFrom(f) === toward) ? Math.abs(acc[f]!) / amax : 0;
      return decel > 0.25 ? -0.2 * k * decel : stretch * (1 - decel);
    });
    const times = raw.map((_, f) => (f === steps ? dur : snapTime(f / fps, fps)));
    const fit = fitBezier(times, [{ values: raw, tol: 0.01, kind: "unit" }]);
    keys = fit.keys.map((f, n) => {
      const a0 = fit.values[n]![0]!, a1 = fit.values[n + 1]?.[0], c = fit.curves[n];
      const curve = c && a1 !== undefined && Math.abs(a1 - a0) > 1e-6 ? [c[0]!, +((c[1]! - a0) / (a1 - a0)).toFixed(4), c[2]!, +((c[3]! - a0) / (a1 - a0)).toFixed(4)] : undefined;
      return { time: times[f]!, amount: a0, ...(curve ? { curve } : {}) };
    });
    base = structuredClone(o.source!);
    notes.push(`From ${o.bone}'s motion over ${dur.toFixed(2)}s: up to ${(Math.max(...raw) * 100).toFixed(0)}% stretch at speed, ${(Math.min(...raw) * -100).toFixed(0)}% squash when it stops. Added to the source animation's keys.`);
  }
  // Volume kept: stretch s along the axis and 1/s across it, about the anchor.
  const displacementAt = (amount: number) => (x: number, y: number): [number, number] => {
    const s = Math.max(0.2, 1 + amount), q = 1 / s;
    const px = x - cx, py = y - ay;
    const a = px * ux + py * uy, b = -px * uy + py * ux;
    const a2 = a * s, b2 = b * q;
    return [a2 * ux - b2 * uy - px, a2 * uy + b2 * ux - py];
  };
  const out: AnimationJson = base;
  for (const m of meshes) {
    const ks = keys.map((kk) => { const k = deformKey(kk.time, deformValues(m, displacementAt(kk.amount))); if (kk.curve) k.curve = kk.curve; return k; });
    setDeform(out, m, ks);
  }
  // Bones on the squashed parts (shoulders, hips, an antenna) move with the surface under them instead of coming off.
  const riders = riderKeys(skeleton, out, meshes.map((m) => m.slot), keys.map((kk) => ({ time: kk.time, ...(kk.curve ? { curve: kk.curve } : {}) })), (x, y, i) => displacementAt(keys[i]!.amount)(x, y));
  if (riders.moved.length) notes.push(`Bones on the squashed parts move with them: ${riders.moved.join(", ")} (translate keys).`);
  if (riders.skipped.length) notes.push(`Not moved because the animation already keys their translation: ${riders.skipped.join(", ")}; they may separate from the squashed art.`);
  notes.unshift(`Squash and stretch on ${meshes.map((m) => m.slot).join(", ")}, anchored at the ${o.anchor ?? "bottom"}, axis ${o.axis ?? 90} degrees, volume kept.`);
  if (skipped.length) notes.push(`Not meshes, so not deformed: ${skipped.join(", ")}.`);
  const made = new Set([...meshes.map((m) => `${m.skin}/${m.slot}/${m.attachment}`), ...riders.moved]);
  return tidyGenerated({ animation: out, notes }, fps, [], o.source ? { only: (kind, owner) => made.has(owner) && (kind === "attachment.deform" || kind === "bone.translate") } : {});
}
