import { loadSkeletonData, spine } from "./runtime.js";
import type { SkeletonJson } from "./types.js";

/**
 * Semantic animation comparison through spine-core's parsed timelines, so JSON differences that do not change
 * behaviour (omitted defaults, int vs float, key order inside objects) are ignored (GOTCHAS G11).
 */
export interface AnimationDiff {
  equal: boolean;
  differences: string[];
}

const EPS = 1e-4;

function numbersEqual(a: ArrayLike<number> | undefined, b: ArrayLike<number> | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > EPS * Math.max(1, Math.abs(a[i]!))) return false;
  return true;
}

/** Deform offsets in world units: Spine trims near-zero values (~0.002) at the ends of a key's range on export. */
const VERTEX_EPS = 0.01;
function verticesEqual(a: number[], b: number[] | undefined): boolean {
  return !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) <= VERTEX_EPS);
}

/** Comparable view of one timeline: frames, curves and per-type payloads. */
function timelineView(t: spine.Timeline): Record<string, unknown> {
  const any = t as unknown as Record<string, unknown>;
  const view: Record<string, unknown> = { frames: t.frames };
  if (any.curves) view.curves = any.curves;
  if (any.attachmentNames) view.attachmentNames = any.attachmentNames;
  if (any.drawOrders) view.drawOrders = JSON.stringify(any.drawOrders);
  if (any.vertices) view.vertices = (any.vertices as ArrayLike<number>[]).map((v) => Array.from(v ?? []));
  if (any.events) {
    const events = any.events as spine.Event[];
    view.eventNames = JSON.stringify(events.map((e) => [e.data.name, e.intValue, e.stringValue]));
    view.eventNumbers = events.flatMap((e) => [e.time, e.floatValue, e.volume, e.balance]);
  }
  return view;
}

function viewsEqual(a: Record<string, unknown>, b: Record<string, unknown>): string | null {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key], y = b[key];
    if (key === "vertices") {
      const xs = x as number[][] | undefined, ys = y as number[][] | undefined;
      if (!xs || !ys || xs.length !== ys.length || xs.some((v, i) => !verticesEqual(v, ys[i]))) return key;
    } else if (typeof x === "string" || typeof y === "string" || Array.isArray(x) && typeof (x as unknown[])[0] !== "number") {
      if (JSON.stringify(x) !== JSON.stringify(y)) return key;
    } else if (!numbersEqual(x as ArrayLike<number>, y as ArrayLike<number>)) {
      return key;
    }
  }
  return null;
}

/** Numeric snapshot of everything an animation can set: bone local poses, slot colors/attachments/deform, constraint
 * poses and draw order. Constraints and physics are not solved: this compares what the keys say, not the final render. */
function poseSnapshot(s: spine.Skeleton): (number | string)[] {
  const out: (number | string)[] = [];
  for (const b of s.bones) {
    const p = b.pose;
    out.push(p.x, p.y, p.rotation, p.scaleX, p.scaleY, p.shearX, p.shearY);
  }
  for (const slot of s.slots) {
    const p = slot.pose;
    out.push(p.color.r, p.color.g, p.color.b, p.color.a, p.getAttachment()?.name ?? "-", ...(p.deform ?? []));
    if (p.darkColor) out.push(p.darkColor.r, p.darkColor.g, p.darkColor.b);
  }
  for (const c of s.constraints) {
    for (const [k, v] of Object.entries(c.pose as object)) if (typeof v === "number") out.push(`${k}`, v);
  }
  out.push(s.drawOrder.pose.map((x) => x.data.name).join(","));
  return out;
}

/**
 * Behavioural comparison: applies both animations to fresh skeletons on a fine time grid and compares the poses.
 * Catches real differences while ignoring representation changes Spine makes on import (e.g. a linear segment between
 * equal values exported as "stepped", float32 key times).
 */
export function behaviorDiff(da: spine.SkeletonData, a: spine.Animation, db: spine.SkeletonData, b: spine.Animation, step = 1 / 120): string[] {
  const sa = new spine.Skeleton(da), sb = new spine.Skeleton(db);
  const end = Math.max(a.duration, b.duration);
  const diffs: string[] = [];
  // Sample t = 0 and grid midpoints: keys usually sit on frame times, and Spine stores times as float32, so sampling
  // exactly on a key time makes discrete timelines (attachments, draw order) flip on rounding noise.
  const times = [0];
  for (let i = 0; (i + 0.5) * step < end; i++) times.push((i + 0.5) * step);
  for (const t of times) {
    if (diffs.length >= 5) break;
    sa.setupPose();
    sb.setupPose();
    a.apply(sa, t, t, false, null, 1, spine.MixFrom.setup, false, false, false);
    b.apply(sb, t, t, false, null, 1, spine.MixFrom.setup, false, false, false);
    const x = poseSnapshot(sa), y = poseSnapshot(sb);
    if (x.length !== y.length) return [`pose shape differs at t=${t.toFixed(3)}`];
    for (let i = 0; i < x.length; i++) {
      const u = x[i]!, v = y[i]!;
      const same = typeof u === "number" && typeof v === "number" ? Math.abs(u - v) <= 1e-3 * Math.max(1, Math.abs(u)) : u === v;
      if (!same) {
        diffs.push(`t=${t.toFixed(3)} value #${i}: ${u} != ${v}`);
        break;
      }
    }
  }
  return diffs;
}

/**
 * Stable timeline identity across separately loaded skeletons. Deform and sequence property ids end with the
 * attachment's runtime id, a global counter that differs on every load, so use the attachment name instead.
 */
function timelineKey(t: spine.Timeline): string {
  const id = t.getPropertyIds().join("|");
  const attachment = (t as unknown as { attachment?: { name: string } }).attachment;
  return attachment ? id.replace(/\|\d+$/, `|@${attachment.name}`) : id;
}

export function compareAnimations(a: spine.Animation, b: spine.Animation, data?: { a: spine.SkeletonData; b: spine.SkeletonData }): AnimationDiff {
  const differences: string[] = [];
  if (Math.abs(a.duration - b.duration) > EPS) differences.push(`duration ${a.duration} != ${b.duration}`);
  // Same-named attachments in different skins share a key; number repeats (timeline order is deterministic).
  const index = (anim: spine.Animation) => {
    const m = new Map<string, spine.Timeline>();
    for (const t of anim.timelines) {
      const base = timelineKey(t);
      let key = base;
      for (let n = 2; m.has(key); n++) key = `${base}#${n}`;
      m.set(key, t);
    }
    return m;
  };
  const ta = index(a), tb = index(b);
  for (const id of new Set([...ta.keys(), ...tb.keys()])) {
    const x = ta.get(id), y = tb.get(id);
    if (!x) differences.push(`timeline added: ${id}`);
    else if (!y) differences.push(`timeline removed: ${id}`);
    else if (x.constructor !== y.constructor) differences.push(`timeline type changed: ${id}`);
    else {
      const field = viewsEqual(timelineView(x), timelineView(y));
      if (field) differences.push(`timeline ${id}: ${field} differ`);
    }
  }
  // Curve-only differences can be representation changes; decide by behaviour when skeletons are available.
  if (data && differences.length && differences.every((d) => d.endsWith("curves differ") || d.endsWith("frames differ"))) {
    const behaviour = behaviorDiff(data.a, a, data.b, b);
    return { equal: behaviour.length === 0, differences: behaviour.length ? [...differences, ...behaviour] : [] };
  }
  return { equal: differences.length === 0, differences };
}

/** Compares `animation` as authored (inside `authoredDoc`) with the same animation in `exportedDoc`. */
export function compareAnimationAcrossDocs(authoredDoc: SkeletonJson, exportedDoc: SkeletonJson, animation: string, exportedName = animation): AnimationDiff {
  const da = loadSkeletonData(authoredDoc), db = loadSkeletonData(exportedDoc);
  const a = da.findAnimation(animation);
  const b = db.findAnimation(exportedName);
  if (!a || !b) return { equal: false, differences: [`animation missing: ${!a ? "authored" : "exported"} ${!a ? animation : exportedName}`] };
  return compareAnimations(a, b, { a: da, b: db });
}

/** Deep-equal for two Spine exports of the same editor build (same formatting), ignoring the given top-level keys. */
export function exportsEqual(a: SkeletonJson, b: SkeletonJson, ignore: string[] = []): string[] {
  const strip = (d: SkeletonJson) => {
    const { animations: _a, ...rest } = d;
    const skel = { ...rest.skeleton };
    delete skel.hash;
    const out: Record<string, unknown> = { ...rest, skeleton: skel };
    for (const k of ignore) delete out[k];
    return out;
  };
  const sa = strip(a), sb = strip(b);
  return [...new Set([...Object.keys(sa), ...Object.keys(sb)])].filter((k) => JSON.stringify(sa[k]) !== JSON.stringify(sb[k]));
}
