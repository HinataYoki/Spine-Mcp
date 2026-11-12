import { repeatAnimation } from "./repeat.js";
import { bakePhysics, type BakePhysicsOptions } from "./bake.js";
import { BONE_CHANNELS, easedCurveCh, fieldChannels, insertKeyCh, keyTime, parseEasing, slotChannels, valueAtCh, type Channels } from "./curves.js";
import { animationDuration, iterateTimelines } from "./inspect.js";
import { mirrorAnimation, swapAnimation } from "./mirror.js";
import { addEvents, checkEventNames, footContacts, type EventKey } from "./events.js";
import { addSetupKeys } from "./setupkeys.js";
import { poseDrift, thinDenseTimelines } from "./clean.js";
import { projectFps, snapTime, tidyAnimation, type TidyOptions } from "./tidy.js";
import type { AnimationJson, Key, SkeletonJson } from "./types.js";

/** Operations that turn an existing animation into a variant. Curves are absolute [cx, cy, ...] per channel, so
 * value operations rescale the cy components and time operations rescale the cx components. */
export type DeriveOp =
  | { op: "scaleValues"; factor: number; kinds?: string[]; bones?: string[] }
  | { op: "retime"; factor: number }
  | { op: "keepBones"; bones: string[] }
  | { op: "dropBones"; bones: string[] }
  /** Shift bone keys in time (overlap / follow-through). With wrap (default) the motion rotates around the loop. */
  | { op: "offsetBones"; bones: string[]; seconds: number; wrap?: boolean }
  /** Shift slot color/alpha, attachment and deform keys in time. */
  | { op: "offsetSlots"; slots: string[]; seconds: number; wrap?: boolean }
  /** Make the last frame match the first so the loop has no pop. `slots` covers colors and deform. */
  | { op: "loopFix"; bones?: string[]; slots?: string[] }
  /** Replace segment curves with a named easing, cubic-bezier(x1,y1,x2,y2), linear or stepped. */
  | { op: "ease"; easing: string; bones?: string[]; kinds?: string[]; slots?: string[] }
  /** Exchange the timelines of paired bones/slots/constraints (e.g. lead with the other leg). Values are unchanged. */
  | { op: "swapBones"; pairs?: [string, string][] }
  /** Mirror horizontally: paired bones exchange timelines, every bone's keys are mirrored in world space. Needs the skeleton. */
  | { op: "mirror"; pairs?: [string, string][] }
  /** Play the animation `times` times in a row as one animation (same motion as looping it). */
  | { op: "repeat"; times: number }
  /** Bake physics into bone keys (simulated with spine-core) and key the physics mix to 0. */
  | ({ op: "bakePhysics" } & BakePhysicsOptions)
  /** Blocking view: every curve stepped; keyPosesOnly also drops breakdowns (keys at times fewer than minTimelines timelines share). */
  | { op: "blocking"; keyPosesOnly?: boolean; minTimelines?: number }
  /**
   * Blocking to spline: stepped and linear segments get smooth curves with automatic tangents that never overshoot
   * between keys (monotone, flat at holds and extremes). smoothness 1 (default) flows through the poses, 0 eases in
   * and out of every key. all: replace hand-made curves too. Loops get matching tangents at the seam.
   */
  | { op: "spline"; smoothness?: number; all?: boolean; bones?: string[]; kinds?: string[]; loop?: boolean }
  /** Event keys: by hand, and/or at detected foot contacts (footstep sounds). Only events the skeleton defines. */
  | { op: "events"; add?: EventKey[]; footsteps?: { bones: string[]; event: string; string?: string; int?: number; volume?: number }; replace?: boolean }
  /** A key at 0 with the setup pose for every timeline the other animations (or `from`) key and this one does not
   * (SkeletonMecanim snaps those back to setup at the end of a transition). */
  | { op: "setupKeys"; from?: string[] }
  | { op: "clean"; thin?: boolean; bones?: string[] };

export interface DeriveContext {
  /** The skeleton the animation belongs to: needed by mirror (setup transforms) and by attachment wraps (setup attachment). */
  skeleton?: SkeletonJson;
}

/** Numeric bone timelines selected by bone names / property kinds. */
function* boneTimelines(anim: AnimationJson, bones?: string[], kinds?: string[]) {
  for (const [bone, timelines] of Object.entries(anim.bones ?? {})) {
    if (bones && !bones.includes(bone)) continue;
    for (const [prop, keys] of Object.entries(timelines)) {
      const spec = BONE_CHANNELS[prop];
      if (spec && (!kinds || kinds.includes(prop)) && keys.length) yield { bone, prop, keys, ch: fieldChannels(spec.fields, spec.neutral), neutral: spec.neutral };
    }
  }
}

/** Slot color/alpha timelines of the given slots. */
function* slotColorTimelines(anim: AnimationJson, slots: string[]) {
  for (const slot of slots) {
    for (const [prop, keys] of Object.entries(anim.slots?.[slot] ?? {})) {
      const ch = slotChannels(prop);
      if (ch && keys.length) yield { slot, prop, keys, ch };
    }
  }
}

/** Deform timelines (any skin/attachment) of the given slots. */
function* deformTimelines(anim: AnimationJson, slots: string[]) {
  for (const [skin, bySlot] of Object.entries(anim.attachments ?? {})) {
    for (const slot of slots) {
      for (const [att, timelines] of Object.entries(bySlot[slot] ?? {})) {
        if (timelines.deform?.length) yield { skin, slot, att, timelines, keys: timelines.deform };
      }
    }
  }
}

export function shiftKeys(keys: Key[], dt: number): Key[] {
  return keys.map((k) => {
    // No rounding: drift moves keys across sample times at discontinuities (sweep finding).
    const out: Key = { ...k, time: keyTime(k) + dt };
    if (Array.isArray(k.curve)) out.curve = k.curve.map((c, i) => (i % 2 === 0 ? c + dt : c));
    return out;
  });
}

/** What the generic offset needs from a timeline type. */
export interface TimelineKind {
  /** Inserts a key at `time` without changing the motion; returns its index. */
  insert(keys: Key[], time: number): number;
  /** True when two keys hold the same value (used to detect a jump at the loop seam). */
  same(a: Key, b: Key): boolean;
}

export const numericKind = (ch: Channels): TimelineKind => ({
  insert: (keys, t) => insertKeyCh(keys, ch, t),
  same: (a, b) => ch.get(a).every((v, i) => Math.abs(v - ch.get(b)[i]!) <= 1e-6),
});

/** Attachment keys are stepped names; before the first key the setup attachment shows. */
export function attachmentKind(setup: string | null | undefined): TimelineKind {
  const nameAt = (keys: Key[], t: number) => {
    let name = setup === undefined ? (keys[0]?.name ?? null) : setup;
    for (const k of keys) if (keyTime(k) <= t + 1e-9) name = k.name ?? null;
    return name;
  };
  return {
    insert: (keys, t) => {
      const existing = keys.findIndex((k) => Math.abs(keyTime(k) - t) < 1e-6);
      if (existing >= 0) return existing;
      const k: Key = { time: t, name: nameAt(keys, t) };
      const idx = keys.findIndex((x) => keyTime(x) > t);
      if (idx < 0) {
        keys.push(k);
        return keys.length - 1;
      }
      keys.splice(idx, 0, k);
      return idx;
    },
    same: (a, b) => (a.name ?? null) === (b.name ?? null),
  };
}

/** Deform keys: sparse vertex offsets interpolated by a 0..1 curve; splitting renormalises both halves. */
export const deformKind: TimelineKind = {
  insert: (keys, t) => insertDeformKey(keys, t),
  same: (a, b) => {
    const n = Math.max(denseLength(a), denseLength(b));
    const x = dense(a, n), y = dense(b, n);
    return x.every((v, i) => Math.abs(v - y[i]!) <= 1e-6);
  },
};

const denseLength = (k: Key) => ((k.offset as number | undefined) ?? 0) + ((k.vertices as number[] | undefined)?.length ?? 0);
function dense(k: Key, n: number): number[] {
  const out = new Array<number>(n).fill(0);
  const off = (k.offset as number | undefined) ?? 0;
  ((k.vertices as number[] | undefined) ?? []).forEach((v, i) => (out[off + i] = v));
  return out;
}

function insertDeformKey(keys: Key[], t: number): number {
  const existing = keys.findIndex((k) => Math.abs(keyTime(k) - t) < 1e-6);
  if (existing >= 0) return existing;
  const idx = keys.findIndex((k) => keyTime(k) > t);
  if (idx === 0 || idx < 0) {
    const ref = idx === 0 ? keys[0]! : keys[keys.length - 1]!;
    const k: Key = { ...structuredClone(ref), time: t };
    delete k.curve;
    if (idx < 0) {
      delete ref.curve;
      keys.push(k);
      return keys.length - 1;
    }
    keys.unshift(k);
    return 0;
  }
  const a = keys[idx - 1]!, b = keys[idx]!;
  const ta = keyTime(a), tb = keyTime(b);
  // Percent along the segment, using the same channel math as numeric timelines (values 0 -> 1).
  const pct: Channels = { count: 1, get: (k) => [k === b ? 1 : 0], set: () => undefined };
  const p = a.curve === "stepped" ? 0 : valueAtCh([a, b], pct, 0, t);
  const n = Math.max(denseLength(a), denseLength(b));
  const va = dense(a, n), vb = dense(b, n);
  const k: Key = { time: t, vertices: va.map((v, i) => v + (vb[i]! - v) * p) };
  if (a.curve === "stepped") {
    k.curve = "stepped";
    k.vertices = va;
  } else if (Array.isArray(a.curve)) {
    // Split the 0..1 bezier at t, then rescale each half back to 0..1.
    const left: Key[] = [{ time: ta, curve: a.curve, _p: 0 }, { time: tb, _p: 1 }];
    const ch: Channels = { count: 1, get: (x) => [(x._p as number | undefined) ?? 0], set: (x, v) => (x._p = v[0]) };
    insertKeyCh(left, ch, t);
    const lc = left[0]!.curve as number[], rc = left[1]!.curve as number[];
    a.curve = p > 1e-9 ? [lc[0]!, lc[1]! / p, lc[2]!, lc[3]! / p] : "stepped";
    k.curve = p < 1 - 1e-9 ? [rc[0]!, (rc[1]! - p) / (1 - p), rc[2]!, (rc[3]! - p) / (1 - p)] : undefined;
    if (k.curve === undefined) delete k.curve;
  }
  keys.splice(idx, 0, k);
  return idx;
}

function offsetGeneric(keys: Key[], kind: TimelineKind, off: number, duration: number, wrap: boolean): Key[] {
  const work = structuredClone(keys);
  if (!wrap) {
    if (off < 0) work.splice(0, kind.insert(work, -off));
    return shiftKeys(work, off);
  }
  const o = ((off % duration) + duration) % duration;
  if (o < 1e-6) return work;
  kind.insert(work, 0);
  kind.insert(work, duration);
  const cut = duration - o;
  const ci = kind.insert(work, cut);
  // [cut, D] moves to the front, [0, cut] follows it; the key at D and the key at 0 meet at `o`.
  const tail = shiftKeys(work.slice(ci, -1), -cut);
  const head = shiftKeys(work.slice(0, ci + 1), o);
  const endKey = work[work.length - 1]!, startKey = work[0]!;
  if (!kind.same(endKey, startKey)) {
    // The loop jumps at its seam (e.g. a continuous spin that snaps back). Keep the jump: split the incoming segment
    // exactly at o - eps (the curve stays the original everywhere else), hold that value for eps, then the start key
    // takes over at `o`. Spine merges keys closer than ~1e-5 s on import (1 ms survives), so eps is 1 ms.
    const withEnd = [...tail, shiftKeys([endKey], -cut)[0]!];
    const tPrev = keyTime(tail[tail.length - 1]!);
    const eps = Math.min(1e-3, (o - tPrev) / 4);
    const j = kind.insert(withEnd, o - eps);
    withEnd.splice(j + 1);
    if (withEnd[j]!.name === undefined) withEnd[j]!.curve = "stepped";
    tail.length = 0;
    tail.push(...withEnd);
  }
  const out = [...tail, ...head];
  delete out[out.length - 1]!.curve;
  return out;
}

function scaleKeys(keys: Key[], ch: Channels, neutral: number, factor: number) {
  const scale = (v: number) => neutral + (v - neutral) * factor;
  for (const k of keys) {
    ch.set(k, ch.get(k).map(scale));
    if (Array.isArray(k.curve)) k.curve = k.curve.map((c, i) => (i % 2 === 1 ? scale(c) : c));
  }
}

/** Sets the end value to `target` and moves the incoming handle with it so the curve shape is kept. */
function fixEnd(keys: Key[], end: number, ch: Channels, target: number[]) {
  const last = keys[end]!, prev = keys[end - 1];
  const current = ch.get(last);
  ch.set(last, target);
  if (prev && Array.isArray(prev.curve)) {
    for (let c = 0; c < ch.count; c++) prev.curve[c * 4 + 3] = prev.curve[c * 4 + 3]! + (target[c]! - current[c]!);
  }
  keys.splice(end + 1);
}

export interface DeriveResult {
  animation: AnimationJson;
  /** Human-readable notes: pairs used by mirror/swap, approximations, skipped timelines. */
  notes: string[];
}

export function deriveAnimation(source: AnimationJson, ops: DeriveOp[], context: DeriveContext = {}): AnimationJson {
  return deriveAnimationWithNotes(source, ops, context).animation;
}

export function deriveAnimationWithNotes(source: AnimationJson, ops: DeriveOp[], context: DeriveContext = {}): DeriveResult {
  let anim: AnimationJson = structuredClone(source);
  const notes: string[] = [];
  const fps = projectFps(context.skeleton);
  const tidy = (op: string, o: TidyOptions) => {
    const t = tidyAnimation(anim, fps, o);
    anim = t.animation;
    if (t.note) notes.push(`${op}: ${t.note.replace(/^Tidy: /, "")}`);
  };
  // Loop length for wrap/loopFix is the animation's duration at the time each op runs (a previous retime changes it).
  for (const o of ops) {
    switch (o.op) {
      case "scaleValues": {
        if (!(o.factor >= 0)) throw new Error("scaleValues.factor must be a number >= 0");
        for (const t of boneTimelines(anim, o.bones, o.kinds)) scaleKeys(t.keys, t.ch, t.neutral, o.factor);
        tidy("scaleValues", { times: false, only: (kind, owner) => kind.startsWith("bone.") && (!o.bones || o.bones.includes(owner)) && (!o.kinds || o.kinds.includes(kind.slice(5))) });
        break;
      }
      case "retime": {
        if (!(o.factor > 0)) throw new Error("retime.factor must be > 0");
        for (const { kind, keys } of iterateTimelines(anim)) {
          for (const k of keys) {
            // Sequence frame delay is a duration: it scales with time too.
            if (kind === "attachment.sequence" && typeof k.delay === "number") k.delay = k.delay * o.factor;
            if (k.time !== undefined) k.time = k.time * o.factor;
            if (Array.isArray(k.curve)) k.curve = k.curve.map((c, i) => (i % 2 === 0 ? c * o.factor : c));
          }
        }
        tidy("retime", { values: false });
        break;
      }
      case "keepBones":
      case "dropBones": {
        const keep = (b: string) => (o.op === "keepBones" ? o.bones.includes(b) : !o.bones.includes(b));
        anim.bones = Object.fromEntries(Object.entries(anim.bones ?? {}).filter(([b]) => keep(b)));
        break;
      }
      case "offsetBones": {
        if (!Number.isFinite(o.seconds)) throw new Error("offsetBones.seconds must be a number");
        const wrap = o.wrap ?? true;
        const duration = animationDuration(anim);
        if (wrap && !(duration > 0)) throw new Error("offsetBones with wrap needs an animation with a duration");
        const seconds = snapTime(o.seconds, fps);
        if (Math.abs(seconds - o.seconds) > 1e-9) notes.push(`offsetBones: ${o.seconds}s shifted by ${seconds}s, whole frames at ${fps} fps`);
        for (const t of [...boneTimelines(anim, o.bones)]) {
          anim.bones![t.bone]![t.prop] = offsetGeneric(t.keys, numericKind(t.ch), seconds, duration, wrap);
        }
        tidy("offsetBones", { values: false, only: (kind, owner) => kind.startsWith("bone.") && o.bones.includes(owner) });
        break;
      }
      case "offsetSlots": {
        if (!Number.isFinite(o.seconds)) throw new Error("offsetSlots.seconds must be a number");
        const wrap = o.wrap ?? true;
        const duration = animationDuration(anim);
        if (wrap && !(duration > 0)) throw new Error("offsetSlots with wrap needs an animation with a duration");
        const seconds = snapTime(o.seconds, fps);
        if (Math.abs(seconds - o.seconds) > 1e-9) notes.push(`offsetSlots: ${o.seconds}s shifted by ${seconds}s, whole frames at ${fps} fps`);
        for (const t of [...slotColorTimelines(anim, o.slots)]) {
          anim.slots![t.slot]![t.prop] = offsetGeneric(t.keys, numericKind(t.ch), seconds, duration, wrap);
        }
        for (const slot of o.slots) {
          const keys = anim.slots?.[slot]?.attachment;
          if (!keys?.length) continue;
          const setupSlot = context.skeleton?.slots?.find((s) => s.name === slot);
          if (wrap && !setupSlot) notes.push(`offsetSlots: no skeleton for slot "${slot}"; the first attachment key stands in for the setup attachment`);
          anim.slots![slot]!.attachment = offsetGeneric(keys, attachmentKind(setupSlot ? (setupSlot.attachment ?? null) : undefined), seconds, duration, wrap);
        }
        for (const t of [...deformTimelines(anim, o.slots)]) t.timelines.deform = offsetGeneric(t.keys, deformKind, seconds, duration, wrap);
        for (const [skin, bySlot] of Object.entries(anim.attachments ?? {})) {
          for (const slot of o.slots) {
            for (const [att, timelines] of Object.entries(bySlot[slot] ?? {})) {
              if (timelines.sequence?.length) notes.push(`offsetSlots: sequence keys of ${skin}/${slot}/${att} were not shifted`);
            }
          }
        }
        tidy("offsetSlots", { values: false, only: (kind, owner) => (kind.startsWith("slot.") && o.slots.includes(owner)) || (kind === "attachment.deform" && o.slots.includes(owner.split("/")[1] ?? "")) });
        break;
      }
      case "loopFix": {
        const duration = animationDuration(anim);
        if (!(duration > 0)) throw new Error("loopFix needs an animation with a duration");
        if (o.bones || !o.slots) {
          for (const t of boneTimelines(anim, o.bones)) {
            const start = Array.from({ length: t.ch.count }, (_, c) => valueAtCh(t.keys, t.ch, c, 0));
            const end = insertKeyCh(t.keys, t.ch, duration);
            const current = t.ch.get(t.keys[end]!);
            const angular = t.prop === "rotate" || t.prop.startsWith("shear");
            // Angles: keep whole turns (a 0 -> 360 spin already loops); only remove the remainder.
            fixEnd(t.keys, end, t.ch, start.map((s, c) => (angular ? s + 360 * Math.round((current[c]! - s) / 360) : s)));
          }
        }
        if (o.slots) {
          for (const t of slotColorTimelines(anim, o.slots)) {
            const start = Array.from({ length: t.ch.count }, (_, c) => valueAtCh(t.keys, t.ch, c, 0));
            fixEnd(t.keys, insertKeyCh(t.keys, t.ch, duration), t.ch, start);
          }
          for (const t of deformTimelines(anim, o.slots)) {
            insertDeformKey(t.keys, 0);
            const end = insertDeformKey(t.keys, duration);
            const first = t.keys[0]!;
            t.keys[end] = { ...structuredClone(first), time: duration };
            delete t.keys[end]!.curve;
            t.keys.splice(end + 1);
          }
        }
        break;
      }
      case "ease": {
        const easing = parseEasing(o.easing);
        const apply = (keys: Key[], curveFor: (a: Key, b: Key, bez: [number, number, number, number]) => number[]) => {
          for (let i = 0; i < keys.length - 1; i++) {
            const k = keys[i]!;
            if (easing === "linear") delete k.curve;
            else if (easing === "stepped") k.curve = "stepped";
            else k.curve = curveFor(k, keys[i + 1]!, easing);
          }
        };
        if (o.bones || !o.slots) for (const t of boneTimelines(anim, o.bones, o.kinds)) apply(t.keys, (a, b, bez) => easedCurveCh(a, b, t.ch, bez));
        if (o.slots) {
          for (const t of slotColorTimelines(anim, o.slots)) apply(t.keys, (a, b, bez) => easedCurveCh(a, b, t.ch, bez));
          // Deform curves run 0 -> 1 along each segment.
          for (const t of deformTimelines(anim, o.slots)) {
            apply(t.keys, (a, b, bez) => {
              const ta = keyTime(a), dt = keyTime(b) - ta;
              return [ta + bez[0] * dt, bez[1], ta + bez[2] * dt, bez[3]];
            });
          }
        }
        break;
      }
      case "spline": {
        const smooth = Math.max(0, Math.min(1, o.smoothness ?? 1));
        let changed = 0;
        for (const t of boneTimelines(anim, o.bones, o.kinds)) {
          const keys = t.keys;
          if (keys.length < 2) continue;
          const times = keys.map(keyTime);
          const values = keys.map((k) => t.ch.get(k));
          const n = keys.length;
          const tangents: number[][] = Array.from({ length: n }, () => new Array<number>(t.ch.count).fill(0));
          for (let c = 0; c < t.ch.count; c++) {
            const v = values.map((x) => x[c]!);
            const d = v.slice(0, -1).map((x, i) => (v[i + 1]! - x) / ((times[i + 1]! - times[i]!) || 1e-9));
            const m = new Array<number>(n).fill(0);
            for (let i = 1; i < n - 1; i++) m[i] = d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2;
            // A loop (same value at both ends) gets one tangent across the seam.
            const loops = (o.loop ?? true) && Math.abs(v[0]! - v[n - 1]!) < 1e-6 && n > 2;
            if (loops) { const a = d[n - 2]!, b = d[0]!; m[0] = m[n - 1] = a * b <= 0 ? 0 : (a + b) / 2; }
            // Fritsch-Carlson: no overshoot between monotone keys.
            for (let i = 0; i < n - 1; i++) {
              if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
              const al = m[i]! / d[i]!, be = m[i + 1]! / d[i]!;
              if (al < 0) m[i] = 0;
              if (be < 0) m[i + 1] = 0;
              const h = al * al + be * be;
              if (h > 9) { const tau = 3 / Math.sqrt(h); m[i] = tau * al * d[i]!; m[i + 1] = tau * be * d[i]!; }
            }
            for (let i = 0; i < n; i++) tangents[i]![c] = m[i]! * smooth;
          }
          for (let i = 0; i < n - 1; i++) {
            const k = keys[i]!;
            if (!o.all && Array.isArray(k.curve)) continue;
            const dt = times[i + 1]! - times[i]!;
            const curve: number[] = [];
            for (let c = 0; c < t.ch.count; c++) curve.push(+(times[i]! + dt / 3).toFixed(6), +(values[i]![c]! + (tangents[i]![c]! * dt) / 3).toFixed(4), +(times[i + 1]! - dt / 3).toFixed(6), +(values[i + 1]![c]! - (tangents[i + 1]![c]! * dt) / 3).toFixed(4));
            k.curve = curve;
            changed++;
          }
        }
        notes.push(`Spline: ${changed} segment(s) smoothed with automatic tangents (no overshoot${smooth < 1 ? `, smoothness ${smooth}` : ""}).`);
        break;
      }
      case "events": {
        if (!context.skeleton) throw new Error("events needs the skeleton");
        const keys: EventKey[] = [...(o.add ?? [])];
        if (o.footsteps) {
          const contacts = footContacts(context.skeleton, anim, o.footsteps.bones);
          keys.push(...contacts.map((c) => ({ time: c.time, name: o.footsteps!.event, string: o.footsteps!.string ?? c.bone, ...(o.footsteps!.int !== undefined ? { int: o.footsteps!.int } : {}), ...(o.footsteps!.volume !== undefined ? { volume: o.footsteps!.volume } : {}) })));
          notes.push(`Footsteps: ${contacts.length} contact(s) found (${contacts.map((c) => `${c.time}s ${c.bone}`).join(", ") || "none: the feet never come back down"}).`);
        }
        checkEventNames(context.skeleton, keys.map((k) => k.name));
        const withEvents = addEvents(anim, keys, o.replace);
        anim.events = withEvents.events;
        tidy("events", { values: false, only: (kind) => kind === "events" });
        notes.push(`${keys.length} event key(s) added${o.replace ? " (the animation's own event keys replaced)" : ""}.`);
        break;
      }
      case "blocking": {
        const instants = new Set(["events", "drawOrder", "slot.attachment", "attachment.sequence", "bone.inherit"]);
        const timelines = [...iterateTimelines(anim)].filter((t) => !instants.has(t.kind) && !t.kind.endsWith(".reset") && !t.kind.startsWith("drawOrder"));
        let removed = 0, poses: number[] = [];
        if (o.keyPosesOnly) {
          // Key poses: times many timelines key together; first and last keys of each timeline always stay.
          const count = new Map<number, number>();
          for (const t of timelines) for (const k of t.keys) { const tt = +keyTime(k).toFixed(4); count.set(tt, (count.get(tt) ?? 0) + 1); }
          const min = o.minTimelines ?? Math.max(2, Math.min(3, Math.ceil(timelines.length / 4)));
          poses = [...count].filter(([, c]) => c >= min).map(([t]) => t).sort((a, b) => a - b);
          const keep = new Set(poses);
          for (const t of timelines) {
            const before = t.keys.length;
            const kept = t.keys.filter((k, i) => i === 0 || i === t.keys.length - 1 || keep.has(+keyTime(k).toFixed(4)));
            t.keys.splice(0, t.keys.length, ...kept);
            removed += before - kept.length;
          }
        }
        for (const t of timelines) for (const k of t.keys) k.curve = "stepped";
        notes.push(o.keyPosesOnly
          ? `Blocking: ${poses.length} key pose(s) kept (${poses.slice(0, 12).join(", ")}${poses.length > 12 ? ", ..." : ""} s), ${removed} breakdown key(s) dropped, every curve stepped.`
          : "Blocking: every curve stepped (pose-to-pose view); keys unchanged.");
        break;
      }
      case "swapBones": {
        const r = swapAnimation(anim, context.skeleton, o.pairs);
        anim = r.animation;
        notes.push(...r.notes);
        break;
      }
      case "repeat": {
        anim = repeatAnimation(anim, animationDuration(anim), o.times, context.skeleton);
        break;
      }
      case "bakePhysics": {
        if (!context.skeleton) throw new Error("bakePhysics needs the skeleton (simulation)");
        const { op: _op, ...options } = o;
        const r = bakePhysics(anim, context.skeleton, options);
        anim = r.animation;
        const rep = r.report;
        notes.push(...r.notes, `bake check (physics off vs simulation, world space): max ${rep.maxPositionError} units / ${rep.maxRotationError} deg; seam correction ${rep.loopCorrection.position} units / ${rep.loopCorrection.rotation} deg; cycle ${rep.cycle} after ${rep.warmupLoops} warm-up loop(s)`);
        break;
      }
      case "clean": {
        const before = anim;
        const thinned = o.thin === false ? null : thinDenseTimelines(anim = structuredClone(anim), fps, o.bones);
        if (thinned?.timelines) notes.push(`clean: ${thinned.timelines} timeline(s) keyed on almost every frame fitted with bezier keys, ${thinned.before} -> ${thinned.after} keys`);
        tidy("clean", { only: (kind, owner) => !o.bones || (kind.startsWith("bone.") && o.bones.includes(owner)) });
        const drift = context.skeleton && JSON.stringify(before) !== JSON.stringify(anim) ? poseDrift(context.skeleton, before, anim, fps) : null;
        if (drift) notes.push(`clean: bones move at most ${drift.pixels} units from the source (${drift.bone} at ${drift.time}s); keys moved onto frames shift timing by under half a frame`);
        break;
      }
      case "setupKeys": {
        if (!context.skeleton) throw new Error("setupKeys needs the skeleton (setup pose, other animations)");
        const r = addSetupKeys(anim, context.skeleton, undefined, o.from);
        anim = r.animation;
        notes.push(...r.notes);
        break;
      }
      case "mirror": {
        if (!context.skeleton) throw new Error("mirror needs the skeleton (setup transforms)");
        const r = mirrorAnimation(anim, context.skeleton, o.pairs);
        anim = r.animation;
        notes.push(...r.notes);
        break;
      }
    }
  }
  return { animation: anim, notes };
}
