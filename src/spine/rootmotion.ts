// Root motion readiness: which bone carries the travel, how far one loop goes, and whether planted feet slide, the way
// spine-unity's SkeletonRootMotion reads it (the translate timeline of `rootMotionBoneName`, "root" by default).
import { animationDuration } from "./inspect.js";
import { loadSkeletonData, spine } from "./runtime.js";
import type { SkeletonJson } from "./types.js";

export interface RootMotionReport {
  animation: string;
  duration: number;
  /** The bone spine-unity would read (`rootMotionBoneName`): the given one, or "root". */
  bone: string;
  /** Its translate keys: travel over one loop (end minus start) and the average speed. */
  perLoop: { x: number; y: number };
  speed: { x: number; y: number };
  /** Spread of the forward speed over the loop (0 = steady); a high value reads as surging. */
  speedVariation: number | null;
  /** Other bones whose translate keys travel (net displacement over the loop): where the motion may really be keyed. */
  travelOn: { bone: string; x: number; y: number }[];
  /** Feet in skeleton space while planted: how fast they move. With root motion they should stand still; in place, this is the speed the game must move the character at. */
  feet?: { bone: string; contactSpeed: number }[];
  inPlace: boolean;
  findings: string[];
}

const r2 = (n: number) => +n.toFixed(2);

export function rootMotionReport(skeleton: SkeletonJson, animation: string, o: { bone?: string; feet?: string[]; fps?: number } = {}): RootMotionReport {
  const anim = skeleton.animations?.[animation];
  if (!anim) throw new Error(`Animation "${animation}" not found`);
  const data = loadSkeletonData(skeleton);
  const bone = o.bone ?? data.bones[0]!.name;
  if (!data.findBone(bone)) throw new Error(`Unknown bone: ${bone}`);
  for (const f of o.feet ?? []) if (!data.findBone(f)) throw new Error(`Unknown bone: ${f}`);
  const duration = animationDuration(anim);
  if (!(duration > 0)) throw new Error("The animation has no length");
  const a = data.findAnimation(animation)!;
  const fps = o.fps ?? 60, steps = Math.max(8, Math.round(duration * fps));
  const sk = new spine.Skeleton(data);
  // Local translation of each bone with translate keys, and feet tips in skeleton space, over one loop.
  const keyed = Object.entries(anim.bones ?? {}).filter(([, tl]) => tl.translate || tl.translatex || tl.translatey).map(([b]) => b);
  const local: Record<string, [number, number][]> = Object.fromEntries(keyed.map((b) => [b, []]));
  const feet: Record<string, [number, number][]> = Object.fromEntries((o.feet ?? []).map((b) => [b, []]));
  for (let f = 0; f <= steps; f++) {
    const t = (duration * f) / steps;
    sk.setupPose();
    a.apply(sk, t, t, false, null, 1, spine.MixFrom.setup, false, false, false);
    sk.updateWorldTransform(spine.Physics.none);
    for (const b of keyed) { const p = sk.findBone(b)!; local[b]!.push([p.pose.x - p.data.setupPose.x, p.pose.y - p.data.setupPose.y]); }
    for (const b of o.feet ?? []) {
      const bn = sk.findBone(b)!, p = bn.appliedPose, len = bn.data.length;
      feet[b]!.push([p.worldX + p.a * len, p.worldY + p.c * len]);
    }
  }
  const net = (s: [number, number][]) => [s[s.length - 1]![0] - s[0]![0], s[s.length - 1]![1] - s[0]![1]] as const;
  const travelOn = keyed.map((b) => { const [x, y] = net(local[b]!); return { bone: b, x: r2(x), y: r2(y) }; }).filter((t) => Math.hypot(t.x, t.y) > 1);
  const own = local[bone];
  const [px, py] = own ? net(own) : [0, 0];
  const perLoop = { x: r2(px), y: r2(py) }, speed = { x: r2(px / duration), y: r2(py / duration) };
  let speedVariation: number | null = null;
  if (own && Math.abs(px) > 1) {
    const v = own.slice(1).map((p, i) => (p[0] - own[i]![0]) * (steps / duration));
    const mean = v.reduce((s, x) => s + x, 0) / v.length;
    speedVariation = r2(Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length) / Math.abs(mean));
  }
  const inPlace = Math.hypot(px, py) <= 1;
  // Planted: the lowest 15% of the foot's height range; its horizontal speed there.
  const feetOut = (o.feet ?? []).map((b) => {
    const s = feet[b]!, ys = s.map((p) => p[1]), lo = Math.min(...ys), range = Math.max(...ys) - lo;
    const speeds: number[] = [];
    for (let i = 1; i < s.length; i++) if (s[i]![1] <= lo + range * 0.15 + 0.5 && s[i - 1]![1] <= lo + range * 0.15 + 0.5) speeds.push(Math.abs(s[i]![0] - s[i - 1]![0]) * (steps / duration));
    speeds.sort((x, y) => x - y);
    return { bone: b, contactSpeed: speeds.length ? r2(speeds[Math.floor(speeds.length / 2)]!) : 0 };
  });
  const findings: string[] = [];
  const others = travelOn.filter((t) => t.bone !== bone);
  if (inPlace && others.length) findings.push(`${bone} does not travel, but ${others.map((t) => `${t.bone} (${t.x}, ${t.y} per loop)`).join(", ")} does: spine-unity's SkeletonRootMotion reads ${bone} unless rootMotionBoneName is set to ${others[0]!.bone} (it reads that bone's translate keys).`);
  if (!inPlace) findings.push(`Root motion on ${bone}: ${perLoop.x}, ${perLoop.y} per loop (${speed.x}, ${speed.y} units/s). With SkeletonRootMotion the GameObject moves by it and ${bone} stays put${Math.abs(perLoop.y) > 1 ? "; the vertical travel moves the GameObject too unless transformPositionY is off" : ""}.`);
  if (speedVariation !== null && speedVariation > 0.35) findings.push(`The travel surges: forward speed varies by ${Math.round(speedVariation * 100)}% over the loop. Fine for a hop or a lunge; a walk usually travels at a steadier speed.`);
  const sliding = feetOut.filter((f) => f.contactSpeed > 0);
  if (!inPlace && feetOut.length) {
    const bad = feetOut.filter((f) => f.contactSpeed > Math.max(5, Math.abs(speed.x) * 0.1));
    if (bad.length) findings.push(`Planted feet still move in the skeleton (${bad.map((f) => `${f.bone} ${f.contactSpeed} units/s`).join(", ")}): with the root motion applied they slide on the ground.`);
    else findings.push("Planted feet stand still in the skeleton: with the root motion applied they stay on the ground.");
  }
  if (inPlace && sliding.length) {
    const sp = feetOut.map((f) => f.contactSpeed), lo = Math.min(...sp), hi = Math.max(...sp);
    const ground = r2(sp.reduce((x, y) => x + y, 0) / sp.length);
    if (hi > 5 && lo >= hi * 0.7) findings.push(`In place: planted feet move at about ${ground} units/s in the skeleton, so move the character at ${ground} units/s in the game for them to stick (or key that travel on ${bone} for root motion).`);
    else if (hi > 5) findings.push(`In place, but the planted feet move at different speeds (${feetOut.map((f) => `${f.bone} ${f.contactSpeed}`).join(", ")} units/s): not a steady gait, so no single game speed keeps both on the ground.`);
  }
  return { animation, duration, bone, perLoop, speed, speedVariation, travelOn, ...(feetOut.length ? { feet: feetOut } : {}), inPlace, findings };
}
