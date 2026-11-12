// Event keys: added by hand or at detected foot contacts. Spine's animation import does not bring event definitions
// (verified: keys for undefined events are dropped with "Event not found"), so only events the skeleton defines are used.
import { animationDuration } from "./inspect.js";
import { loadSkeletonData, spine } from "./runtime.js";
import type { AnimationJson, Key, SkeletonJson } from "./types.js";

export interface EventKey { time: number; name: string; int?: number; float?: number; string?: string; volume?: number; balance?: number }

/** Refuses names the skeleton does not define, listing the ones it does. */
export function checkEventNames(skeleton: SkeletonJson, names: string[]): void {
  const defined = Object.keys(skeleton.events ?? {});
  const missing = [...new Set(names)].filter((n) => !defined.includes(n));
  if (missing.length) {
    throw new Error(`Event(s) not defined in the skeleton: ${missing.join(", ")}. ${defined.length ? `Defined: ${defined.join(", ")}.` : "It defines none."} Spine's animation import does not bring new event definitions: add the event in Spine first (Tree > Events > New), then key it here.`);
  }
}

/** Merges event keys into an animation, sorted by time; `replace` drops the animation's own event keys first. */
export function addEvents(anim: AnimationJson, keys: EventKey[], replace = false): AnimationJson {
  const out = structuredClone(anim);
  const own = replace ? [] : out.events ?? [];
  const add: Key[] = keys.map((k) => ({ ...(k.time ? { time: +k.time.toFixed(6) } : {}), name: k.name, ...(k.int !== undefined ? { int: k.int } : {}), ...(k.float !== undefined ? { float: k.float } : {}), ...(k.string !== undefined ? { string: k.string } : {}), ...(k.volume !== undefined ? { volume: k.volume } : {}), ...(k.balance !== undefined ? { balance: k.balance } : {}) }));
  out.events = [...own, ...add].sort((a, b) => ((a.time as number) ?? 0) - ((b.time as number) ?? 0));
  return out;
}

/**
 * Foot contacts in an animation: the moments a foot bone's tip comes down onto its lowest height and stops (a local
 * minimum of height near the ground, reached after moving down). One time per landing, per bone.
 */
export function footContacts(skeleton: SkeletonJson, anim: AnimationJson, bones: string[], fps = 60, mergeWithin = 0.05): { bone: string; time: number }[] {
  const doc = { ...skeleton, animations: { __c: anim } as never };
  const data = loadSkeletonData(doc);
  for (const b of bones) if (!data.findBone(b)) throw new Error(`Unknown bone: ${b}`);
  const a = data.findAnimation("__c")!, dur = animationDuration(anim);
  if (!(dur > 0)) throw new Error("The animation has no length");
  const sk = new spine.Skeleton(data);
  const steps = Math.max(4, Math.round(dur * fps));
  const ys: Record<string, number[]> = Object.fromEntries(bones.map((b) => [b, []]));
  for (let f = 0; f <= steps; f++) {
    const t = (dur * f) / steps;
    sk.setupPose();
    a.apply(sk, t, t, false, null, 1, spine.MixFrom.setup, false, false, false);
    sk.updateWorldTransform(spine.Physics.none);
    for (const b of bones) {
      const bone = sk.findBone(b)!, p = bone.appliedPose, r = (p.getWorldRotationX() * Math.PI) / 180, s = Math.hypot(p.a, p.c);
      ys[b]!.push(p.worldY + Math.sin(r) * bone.data.length * s);
    }
  }
  const out: { bone: string; time: number }[] = [];
  for (const b of bones) {
    const y = ys[b]!, lo = Math.min(...y), hi = Math.max(...y), range = hi - lo;
    if (range < 1e-3) continue; // never lifts: no steps to mark
    const near = lo + range * 0.15;
    // A landing: the first frame back near the ground after having been clearly above it.
    let up = y[0]! > near;
    for (let f = 1; f <= steps; f++) {
      if (y[f]! > lo + range * 0.4) up = true;
      if (up && y[f]! <= near) { out.push({ bone: b, time: +((dur * f) / steps).toFixed(4) }); up = false; }
    }
  }
  // Both feet landing together (a jump) is one contact.
  const sorted = out.sort((x, z) => x.time - z.time);
  return sorted.filter((c, i) => i === 0 || c.time - sorted[i - 1]!.time > mergeWithin);
}
