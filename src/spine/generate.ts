import { bakePhysics } from "./bake.js";
import { animationDuration } from "./inspect.js";
import { deriveAnimationWithNotes, type DeriveOp } from "./derive.js";
import { samplePose } from "./poses.js";
import { loadSkeletonData, spine } from "./runtime.js";
import { framesOf, projectFps, roundHalfAway, roundValue, snapTime, tidyGenerated, toFourDecimals } from "./tidy.js";
import type { AnimationJson, Key, SkeletonJson } from "./types.js";

export interface BreatheOptions {
  /** Bones that expand on the inhale (chest, torso, belly): scaled. */
  torso: string[];
  /** Bones carried up by the breath (head, shoulders, arms): raised a little, a bit later than the torso. */
  followers?: string[];
  /** Seconds per breath (default 3). */
  period?: number;
  /** Torso scaleY gain on the inhale (default 0.03 = 3%); scaleX gets a third of it. */
  amount?: number;
  /** How far followers rise, in skeleton units (default 0.6% of the skeleton height, at least 0.5). */
  rise?: number;
  /** Follower rotation in degrees on the inhale (default 0). */
  rotate?: number;
  /** Follower delay as a fraction of the period (default 0.08), wrapped around the loop. */
  lag?: number;  path?: "line" | "figure8";
  sway?: number;
  swayPeriod?: number;
  swayLag?: number;
  phase?: number;
  /** Search the phase so the loop's first frame is nearest the setup pose (a popup opens on the art). */
  restStart?: boolean;
}

export interface BlinkEye {
  slot: string;
  open: string;
  closed: string;
  /** Optional half-closed attachment for a softer blink. */
  half?: string;
}

export interface BlinkLid {
  bone: string;
  /** scaleY when closed (default 0.1), used when neither `closed` nor `closedFrom` is given. */
  closedScale?: number;
  /** The closed lid as offsets from the setup pose: translate (x, y), rotate, scale factors. For lids that slide down. */
  closed?: { x?: number; y?: number; rotate?: number; scaleX?: number; scaleY?: number };
  /** The closed lid as posed in an animation: "animation@seconds" (the bone's offsets there). */
  closedFrom?: string;
  openFrom?: string;
}

export interface BlinkOptions {
  /** Attachment-swap eyes (open/closed images). */
  eyes?: BlinkEye[];
  /** Bone-driven eyelids (squashed on scaleY). */
  lids?: BlinkLid[];
  /** Loop length in seconds (default 3). */
  duration?: number;
  /** When the blink starts (default 70% of the duration). */
  at?: number;
  /** Close + open time in seconds (default 0.16). */
  blinkTime?: number;
  /** A second quick blink right after the first (default false). */
  double?: boolean;
  /** Several blinks: start times (and double blinks). Replaces `at`. */
  blinks?: { time: number; double?: boolean }[];
  /** Close, hold closed, open, in seconds (default 0.07 / 0.05 / 0.1: shut fast, open slower). blinkTime overrides. */
  closeTime?: number;
  holdTime?: number;
  openTime?: number;
  /** Slots hidden while the lids are shut (lashes or lines drawn over the open eye); back to their setup attachment after. */
  hide?: string[];
  /**
   * Blinks where an animation changes pose: a blink is placed so the lids are shut as each fast move of `bones`
   * (default: the head chain) starts, the way animators hide pose changes. The blink animation takes the source's
   * length; play both together (blink on a track above).
   */
  onPoses?: { source: string; bones?: string[]; rotateSpeed?: number; moveSpeed?: number; minGap?: number };
  /** With onPoses (or blinks): add blinks so no gap between blinks is longer than this many seconds. */
  fill?: number;  hideAt?: number;
}

export interface Suggestions {
  torso: string[];
  followers: string[];
  eyes: BlinkEye[];
  lids: string[];
  /** lookAt: a neck-to-head chain and eye bones. */
  look: { bones: string[]; eyeBones: string[] };
  /** followThrough: bones that could drag behind (with a length, no physics yet), parent first. */
  dangling: string[];
  /** lipSync: mouth slots with their attachments (order them closed to open) and jaw bones. */
  mouths: { slot: string; attachments: string[] }[];
  jaws: string[];
  /** turn: face mesh slots and features drawn on them; squash: body mesh slots. */
  faces: string[];
  features: string[];
  bodies: string[];
}

const r3 = toFourDecimals;
/** Two keys at one time: the later one wins (blink at 0 or ending exactly at the loop end). */
const dedupe = (keys: Key[]) => keys.filter((k, i) => i === keys.length - 1 || (keys[i + 1]!.time ?? 0) !== (k.time ?? 0));

/** A seamless breathing idle: eased torso scale, followers rising slightly later (wrapped so the loop stays closed). */
export function waveExtremes(amp: number, period: number, lag: number, start: number, length: number, fps?: number): [number, number][] {
  const half = period / 2, pts: [number, number][] = [];
  const at = (t: number) => (fps ? snapTime(t, fps) : t);
  for (let k = Math.floor(-lag / half) - 1; lag + (k - 1) * half <= length + 1e-9; k++) pts.push([at(lag + k * half), start * amp * (k % 2 === 0 ? 1 : -1)]);
  return pts;
}

export function cutWave(pts: [number, number][], length: number, extra: number[] = []): { time: number; value: number; curve?: [number, number, number, number] }[] {
  const cuts = [...new Set([0, length, ...pts.map(([t]) => t), ...extra].filter((t) => t >= -1e-9 && t <= length + 1e-9).map((t) => +t.toFixed(9)))].sort((a, b) => a - b);
  const seg = (t: number) => { for (let i = 0; i + 1 < pts.length; i++) if ((pts[i]![0] <= t + 1e-12 && t < pts[i + 1]![0] - 1e-12) || (i + 2 === pts.length && t <= pts[i + 1]![0] + 1e-12)) return i; return pts.length - 2; };
  const bez = (c: number[], u: number) => { const m = 1 - u; return m ** 3 * c[0]! + 3 * m * m * u * c[1]! + 3 * m * u * u * c[2]! + u ** 3 * c[3]!; };
  const slope = (c: number[], u: number) => { const m = 1 - u; return 3 * (m * m * (c[1]! - c[0]!) + 2 * m * u * (c[2]! - c[1]!) + u * u * (c[3]! - c[2]!)); };
  return cuts.map((ta, i) => {
    const s = seg(ta), [f0, v0] = pts[s]!, [f1, v1] = pts[s + 1]!, c = [v0, v0, v1, v1], ua = (ta - f0) / (f1 - f0);
    const key: { time: number; value: number; curve?: [number, number, number, number] } = { time: +ta.toFixed(6), value: r3(bez(c, ua)) };
    const tb = cuts[i + 1];
    if (tb !== undefined) {
      const ub = (tb - f0) / (f1 - f0), h = ub - ua, d = tb - ta;
      key.curve = [+(ta + d / 3).toFixed(6), r3(bez(c, ua) + (slope(c, ua) * h) / 3), +(tb - d / 3).toFixed(6), r3(bez(c, ub) - (slope(c, ub) * h) / 3)];
    }
    return key;
  });
}

function worldRotation(skeleton: SkeletonJson, bone: string) {
  const sk = new spine.Skeleton(loadSkeletonData(skeleton));
  sk.setupPose();
  sk.updateWorldTransform(spine.Physics.none);
  return sk.findBone(bone)?.appliedPose.getWorldRotationX() ?? 0;
}

function pathKeys(skeleton: SkeletonJson, bone: string, xs: ReturnType<typeof cutWave>, ys: ReturnType<typeof cutWave>): Key[] {
  const parent = skeleton.bones.find((b) => b.name === bone)?.parent;
  const a = (-(parent ? worldRotation(skeleton, parent) : 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const to = (x: number, y: number) => [r3(x * c - y * s), r3(x * s + y * c)] as const;
  return xs.map((kx, i) => {
    const ky = ys[i]!, [x, y] = to(kx.value, ky.value);
    const key: Key = { time: kx.time, x, y };
    if (kx.curve && ky.curve) {
      const [x1, y1] = to(kx.curve[1], ky.curve[1]), [x2, y2] = to(kx.curve[3], ky.curve[3]);
      (key as Record<string, unknown>).curve = [kx.curve[0], x1, kx.curve[2], x2, ky.curve[0], y1, ky.curve[2], y2];
    }
    return key;
  });
}

function figureEight(skeleton: SkeletonJson, o: BreatheOptions): { animation: AnimationJson; notes: string[] } {
  const fps = projectFps(skeleton);
  const p = o.period ?? 3, length = o.swayPeriod ?? 2 * p, shift = snapTime((o.phase ?? 0) * length, fps);
  if (Math.abs(length / p - Math.round(length / p)) > 1e-6) throw new Error(`swayPeriod (${length}s) must be a whole number of breaths (${p}s)`);
  const ay = o.rise ?? Math.max(0.5, roundValue("translate", (skeleton.skeleton.height ?? 0) * 0.003)), ax = o.sway ?? roundValue("translate", ay / 2);
  const swayLag = snapTime((o.swayLag ?? 0.12) * length, fps), lag = snapTime((o.lag ?? 0.07) * p, fps), turn = o.rotate ?? 1;
  const anim: AnimationJson = { bones: {} };
  for (const b of o.torso) {
    const px = waveExtremes(ax, length, swayLag + shift, 1, length, fps), py = waveExtremes(ay, p, shift, -1, length, fps);
    const times = [...px, ...py].map(([t]) => t);
    anim.bones![b] = { translate: pathKeys(skeleton, b, cutWave(px, length, times), cutWave(py, length, times)) };
  }
  const followers = (o.followers ?? []).filter((b) => !o.torso.includes(b));
  followers.forEach((b, i) => {
    const keys = cutWave(waveExtremes(turn, p, shift + lag * (i + 1), -1, length, fps), length);
    anim.bones![b] = { rotate: keys.map((k) => ({ time: k.time, value: k.value, ...(k.curve ? { curve: k.curve } : {}) })) as Key[] };
  });
  return tidyGenerated({
    animation: anim,
    notes: [
      `Breath on a figure-eight: torso up and down ${ay} units every ${p}s and side to side ${ax} units every ${length}s (${r3(swayLag)}s behind), keys only at the turning points, cut exactly at the loop ends; loop ${length}s.${followers.length ? ` Followers turn ${turn}° with each breath, ${r3(lag)}s later each in turn: ${followers.join(", ")}.` : ""}${o.phase ? ` Shifted by ${r3(shift)}s (phase ${o.phase}).` : ""}`,
      "A second character: generate it with another phase (0.25 to 0.5) so the two never turn on the same frame.",
    ],
  }, fps, [o.rise, o.sway, o.rotate]);
}

/** How far an animation's first frame is from the setup pose: translation, plus rotation and scale weighted by bone length. */
export function restCost(skeleton: SkeletonJson, animation: AnimationJson): number {
  const data = loadSkeletonData({ ...skeleton, animations: { "spine-mcp-rest": animation } });
  const sk = new spine.Skeleton(data), anim = data.findAnimation("spine-mcp-rest")!;
  sk.setupPose();
  anim.apply(sk, 0, 0, false, null, 1, spine.MixFrom.setup, false, false, false);
  let cost = 0;
  for (const b of sk.bones) {
    const p = b.pose, s = b.data.setupPose, reach = Math.max(b.data.length, 50);
    cost += Math.hypot(p.x - s.x, p.y - s.y) + (Math.abs(p.rotation - s.rotation) * Math.PI / 180) * reach + (Math.abs(p.scaleX - s.scaleX) + Math.abs(p.scaleY - s.scaleY)) * reach;
  }
  return cost;
}

export function breathe(skeleton: SkeletonJson, o: BreatheOptions): { animation: AnimationJson; notes: string[] } {
  if (!o.restStart) return breatheAt(skeleton, o);
  const fps = projectFps(skeleton), p = o.period ?? 3, loop = o.path === "figure8" ? o.swayPeriod ?? 2 * p : p;
  const frames = Math.max(1, framesOf(loop, fps)), stride = Math.max(1, Math.ceil(frames / 240));
  let best = { phase: 0, cost: Infinity, r: null as ReturnType<typeof breatheAt> | null };
  for (let f = 0; f < frames; f += stride) {
    const r = breatheAt(skeleton, { ...o, phase: f / frames }), cost = restCost(skeleton, r.animation);
    if (cost < best.cost - 1e-9) best = { phase: f / frames, cost, r };
  }
  const at0 = restCost(skeleton, breatheAt(skeleton, { ...o, phase: 0 }).animation);
  return { animation: best.r!.animation, notes: [...best.r!.notes, `Rest start: phase ${r3(best.phase)} puts the first frame nearest the setup pose (distance ${r3(best.cost)} against ${r3(at0)} at phase 0).`] };
}

function breatheAt(skeleton: SkeletonJson, o: BreatheOptions): { animation: AnimationJson; notes: string[] } {
  const bones = new Set(skeleton.bones.map((b) => b.name));
  const missing = [...o.torso, ...(o.followers ?? [])].filter((b) => !bones.has(b));
  if (missing.length) throw new Error(`Unknown bone(s): ${missing.join(", ")}`);
  if (!o.torso.length) throw new Error("breathe needs at least one torso bone");
  if (o.path === "figure8") return figureEight(skeleton, o);
  const fps = projectFps(skeleton), p = o.period ?? 3, amount = o.amount ?? 0.03;
  const rise = o.rise ?? Math.max(0.5, roundValue("translate", (skeleton.skeleton.height ?? 0) * 0.006));
  const anim: AnimationJson = { bones: {} };
  const half = snapTime(p / 2, fps);
  const sx = roundValue("scale", 1 + amount / 3), sy = 1 + amount;
  for (const b of o.torso) {
    anim.bones![b] = { scale: [{ x: 1, y: 1 }, { time: half, x: sx, y: sy }, { time: p, x: 1, y: 1 }] };
  }
  const followers = (o.followers ?? []).filter((b) => !o.torso.includes(b));
  for (const b of followers) {
    const tl: Record<string, Key[]> = { translate: [{ x: 0, y: 0 }, { time: half, x: 0, y: rise }, { time: p, x: 0, y: 0 }] };
    if (o.rotate) tl.rotate = [{ value: 0 }, { time: half, value: o.rotate }, { time: p, value: 0 }];
    anim.bones![b] = tl;
  }
  // Children of the torso that inherit its scale and do not follow the breath (legs, a tail): counter-scaled so they keep
  // their size, and, when they hang below the torso's origin, counter-moved so feet stay planted.
  const torsoSet = new Set(o.torso), followerSet = new Set(followers);
  const byName = new Map(skeleton.bones.map((b) => [b.name, b]));
  const sk = new spine.Skeleton(loadSkeletonData(skeleton));
  sk.setupPose();
  sk.updateWorldTransform(spine.Physics.none);
  const steady: string[] = [];
  for (const b of skeleton.bones) {
    if (!b.parent || !torsoSet.has(b.parent) || torsoSet.has(b.name) || followerSet.has(b.name)) continue;
    if (/noScale/i.test(String(b.inherit ?? "normal"))) continue;
    const th = ((b.rotation ?? 0) * Math.PI) / 180;
    const cx = 1 / Math.hypot(sx * Math.cos(th), sy * Math.sin(th)), cy = 1 / Math.hypot(sx * Math.sin(th), sy * Math.cos(th));
    const tl: Record<string, Key[]> = { scale: [{ x: 1, y: 1 }, { time: half, x: cx, y: cy }, { time: p, x: 1, y: 1 }] };
    const below = sk.findBone(b.name)!.appliedPose.worldY < sk.findBone(b.parent)!.appliedPose.worldY;
    const x = b.x ?? 0, y = b.y ?? 0;
    if (below && (x || y)) tl.translate = [{ x: 0, y: 0 }, { time: half, x: x / sx - x, y: y / sy - y }, { time: p, x: 0, y: 0 }];
    anim.bones![b.name] = tl;
    steady.push(b.name);
  }
  const ops: DeriveOp[] = [{ op: "ease", easing: "easeInOutSine" }];
  const lag = snapTime((o.lag ?? 0.08) * p, fps);
  if (followers.length && lag > 0) ops.push({ op: "offsetBones", bones: followers, seconds: lag, wrap: true });
  if (o.phase) ops.push({ op: "offsetBones", bones: Object.keys(anim.bones ?? {}), seconds: snapTime(o.phase * p, fps), wrap: true });
  const r = deriveAnimationWithNotes(anim, ops, { skeleton });
  const notes = [
    `Breath: ${p}s, torso scaleY +${r3(amount * 100)}% (scaleX +${r3((amount * 100) / 3)}%)${followers.length ? `, followers rise ${rise} units ${r3(lag)}s later` : ""}. Keys are relative to the setup pose (translate/rotate offsets, scale factors).`,
    "Layer it on a separate track under other idles, or merge it into a hand-made idle. Check it with spine_render_frames.",
  ];
  if (steady.length) notes.push(`Kept out of the breath (counter-scaled, and held in place when below the torso): ${steady.join(", ")}.`);
  const grow = followers.filter((f) => byName.get(f)?.parent && torsoSet.has(byName.get(f)!.parent!) && !/noScale/i.test(String(byName.get(f)!.inherit ?? "normal")));
  if (grow.length) notes.push(`Followers on the torso inherit its scale (${grow.join(", ")}): they grow ${r3(amount * 100)}% with each breath as part of the chest.`);
  return tidyGenerated({ animation: r.animation, notes }, fps, [o.rise, o.rotate, o.amount === undefined ? undefined : sy]);
}

/** Times where any of `bones` starts a fast move (world rotation or position speed above the thresholds). */
export function poseChanges(skeleton: SkeletonJson, animation: string, bones: string[], o: { rotateSpeed?: number; moveSpeed?: number; fps?: number } = {}): { time: number; bone: string }[] {
  const data = loadSkeletonData(skeleton);
  const anim = data.findAnimation(animation);
  if (!anim) throw new Error(`Animation "${animation}" not found`);
  for (const b of bones) if (!data.findBone(b)) throw new Error(`Unknown bone: ${b}`);
  const fps = o.fps ?? 30, rotMin = o.rotateSpeed ?? 20, moveMin = o.moveSpeed ?? Math.max(1, (skeleton.skeleton.height ?? 300) * 0.08);
  const sk = new spine.Skeleton(data);
  const n = Math.round(anim.duration * fps);
  const at = (t: number) => {
    sk.setupPose();
    anim.apply(sk, t, t, false, null, 1, spine.MixFrom.setup, false, false, false);
    sk.updateWorldTransform(spine.Physics.none);
    return bones.map((b) => { const p = sk.findBone(b)!.appliedPose; return [p.worldX, p.worldY, p.getWorldRotationX()] as const; });
  };
  let prev = at(0), moving = false;
  const out: { time: number; bone: string }[] = [];
  for (let k = 1; k <= n; k++) {
    const cur = at(k / fps);
    let fast: string | null = null;
    cur.forEach((c, i) => {
      const p = prev[i]!;
      const rot = Math.abs(((((c[2] - p[2] + 180) % 360) + 360) % 360) - 180) * fps, move = Math.hypot(c[0] - p[0], c[1] - p[1]) * fps;
      if (!fast && (rot > rotMin || move > moveMin)) fast = bones[i]!;
    });
    if (fast && !moving) out.push({ time: r3((k - 1) / fps), bone: fast });
    moving = !!fast;
    prev = cur;
  }
  return out;
}

/** A blink loop: attachment swaps for image eyes, eyelid bones squashed or posed shut, slots hidden while shut. */
export function blink(skeleton: SkeletonJson, o: BlinkOptions): { animation: AnimationJson; notes: string[] } {
  if (!o.eyes?.length && !o.lids?.length) throw new Error("blink needs eyes (slot with open/closed attachments) or lids (eyelid bones)");
  const bt = o.blinkTime;
  // Keys sit on the frame grid, as an animator's do: Spine moves keys that sit just off a frame and their curves with
  // them (G84). Default timing in frames: shut in 2, held 2, open in 3.
  const fps = projectFps(skeleton), fr = (t: number) => snapTime(t, fps);
  const close = o.closeTime ?? (bt !== undefined ? bt * 0.4 : 2 / fps), hold = o.holdTime ?? (bt !== undefined ? 0 : 2 / fps), open = o.openTime ?? (bt !== undefined ? bt * 0.6 : 3 / fps);
  const span = close + hold + open;
  const notes: string[] = [];
  let d = fr(o.duration ?? 3);
  let plan: { time: number; double?: boolean }[] = o.blinks?.length ? [...o.blinks] : [{ time: fr(o.at ?? d * 0.7), double: o.double }];
  if (o.onPoses) {
    const src = skeleton.animations?.[o.onPoses.source];
    if (!src) throw new Error(`Animation "${o.onPoses.source}" not found`);
    d = fr(o.duration ?? animationDuration(src));
    const bones = o.onPoses.bones?.length ? o.onPoses.bones : suggest(skeleton).look.bones;
    if (!bones.length) throw new Error("onPoses needs bones (the head chain whose moves the blinks hide)");
    const changes = poseChanges(skeleton, o.onPoses.source, bones, o.onPoses);
    // Shut as the move starts. Moves soon after a blink go without one: blinks seconds apart, not a flutter.
    const minGap = o.onPoses.minGap ?? 1;
    const starts: number[] = [], skipped: number[] = [];
    for (const c of changes) {
      const s = Math.max(0, fr(c.time - close));
      if (!starts.length || s - starts[starts.length - 1]! >= Math.max(minGap, span * 1.5) - 1e-6) starts.push(s);
      else skipped.push(c.time);
    }
    if (skipped.length) notes.push(`Moves within ${minGap}s of a blink left without one: ${skipped.join("s, ")}s (onPoses.minGap).`);
    plan = [...(o.blinks ?? []), ...starts.filter((s) => s + span <= d).map((time) => ({ time }))].sort((a, b) => a.time - b.time);
    notes.push(`${changes.length} pose change(s) in ${o.onPoses.source} (${bones.join(", ")} moving faster than ${o.onPoses.rotateSpeed ?? 20} deg/s or ${r3(o.onPoses.moveSpeed ?? Math.max(1, (skeleton.skeleton.height ?? 300) * 0.08))} units/s): ${changes.slice(0, 10).map((c) => `${c.time}s ${c.bone}`).join(", ") || "none"}; blinks shut as they start.`);
  }
  if (o.fill && o.fill > span) {
    // Natural blinks in long gaps (the loop wraps: the gap from the last blink to the first counts too).
    const filled: { time: number; double?: boolean }[] = [];
    const times = plan.map((b) => b.time);
    const gaps = times.length ? times.map((t, i) => [t, i + 1 < times.length ? times[i + 1]! : times[0]! + d] as const) : [[0, d] as const];
    for (const [a, b] of gaps) {
      const extra = Math.floor((b - a) / o.fill);
      for (let k = 1; k <= extra; k++) {
        // A blink that would run past the loop end moves back so it still fits.
        const t = fr(Math.min((a + ((b - a) * k) / (extra + 1)) % d, d - span));
        if (t >= 0) filled.push({ time: t });
      }
    }
    if (filled.length) notes.push(`${filled.length} blink(s) added so no gap is longer than ${o.fill}s: ${filled.map((f) => `${f.time}s`).join(", ")}.`);
    plan = [...plan, ...filled].sort((a, b) => a.time - b.time);
  }
  const starts = plan.flatMap((b) => (b.double ? [fr(b.time), fr(b.time + span + 2 / fps)] : [fr(b.time)])).sort((a, b) => a - b);
  for (const [i, s] of starts.entries()) {
    if (s < 0 || fr(s + span) > d + 1e-6) throw new Error(`The blink (at ${s}s, ${r3(span)}s) does not fit in ${d}s`);
    if (i && s < fr(starts[i - 1]! + span)) throw new Error(`Blinks at ${starts[i - 1]}s and ${s}s overlap (each takes ${r3(span)}s)`);
  }
  const slots = new Map((skeleton.slots ?? []).map((sl) => [sl.name, sl]));
  const bones = new Set(skeleton.bones.map((b) => b.name));
  const anim: AnimationJson = {};
  for (const e of o.eyes ?? []) {
    if (!slots.has(e.slot)) throw new Error(`Unknown slot: ${e.slot}`);
    // An empty open name: the slot shows nothing while open (a shut lid drawn over the eye). Spine writes that as a
    // key without a name; an empty name would import as something else and the verified write roll back.
    const shown = (name: string) => (name ? { name } : {});
    const keys: Key[] = [{ ...shown(e.open) }];
    for (const s of starts) {
      if (e.half) keys.push({ time: fr(s), ...shown(e.half) }, { time: fr(s + close), ...shown(e.closed) }, { time: fr(s + close + hold + open / 2), ...shown(e.half) }, { time: fr(s + span), ...shown(e.open) });
      else keys.push({ time: fr(s + close / 2), ...shown(e.closed) }, { time: fr(s + close + hold + open / 2), ...shown(e.open) });
    }
    if (!o.lids?.length) keys.push({ time: d, ...shown(e.open) }); // held to the loop end
    (anim.slots ??= {})[e.slot] = { attachment: dedupe(keys) };
  }
  for (const h of o.hide ?? []) {
    const sl = slots.get(h);
    if (!sl) throw new Error(`Unknown slot: ${h}`);
    const shown: Key = sl.attachment ? { name: sl.attachment } : {};
    const keys: Key[] = [{ ...shown }];
    for (const s of starts) keys.push({ time: fr(s + close / 2) }, { time: fr(s + close + hold + open / 2), ...shown });
    keys.push({ time: d, ...shown });
    (anim.slots ??= {})[h] = { ...(anim.slots?.[h] ?? {}), attachment: dedupe(keys) };
  }
  for (const l of o.lids ?? []) {
    if (!bones.has(l.bone)) throw new Error(`Unknown bone: ${l.bone}`);
    let shut = l.closed;
    if (l.closedFrom) {
      const m = /^(.+)@([\d.]+)$/.exec(l.closedFrom);
      if (!m) throw new Error(`closedFrom must be "animation@seconds": ${l.closedFrom}`);
      const p = samplePose(skeleton, m[1]!, Number(m[2])).bones[l.bone];
      if (!p) throw new Error(`${l.bone} is at its setup pose in ${l.closedFrom}: nothing to close to`);
      shut = { x: p.x, y: p.y, rotate: p.rotate, scaleX: p.scaleX, scaleY: p.scaleY };
    }
    let open = { x: 0, y: 0, rotate: 0, scaleX: 1, scaleY: 1 };
    if (l.openFrom) {
      const m = /^(.+)@([\d.]+)$/.exec(l.openFrom);
      if (!m) throw new Error(`openFrom must be "animation@seconds": ${l.openFrom}`);
      const p = samplePose(skeleton, m[1]!, Number(m[2])).bones[l.bone];
      if (p) open = { x: p.x, y: p.y, rotate: p.rotate, scaleX: p.scaleX, scaleY: p.scaleY };
    }
    const tl: Record<string, Key[]> = {};
    const track = (prop: string, rest: Key, shutKey: Key) => {
      const keys: Key[] = [{ ...rest }];
      const chan = (k: Key) => (prop === "rotate" ? [(k as { value: number }).value] : [(k as { x: number }).x, (k as { y: number }).y]);
      const shaped = (t0: number, t1: number, a: Key, b: Key, into: boolean) => {
        const d0 = t1 - t0, va = chan(a), vb = chan(b);
        return va.flatMap((v, i) => (into ? [+(t0 + 0.42 * d0).toFixed(6), v, +t1.toFixed(6), vb[i]!] : [+t0.toFixed(6), v, +(t0 + 0.58 * d0).toFixed(6), vb[i]!]));
      };
      for (const s of starts) {
        const a0 = fr(s), a1 = fr(s + close), b0 = fr(s + close + hold), b1 = fr(s + span);
        keys.push({ time: a0, ...rest, curve: shaped(a0, a1, rest, shutKey, true) } as Key, { time: a1, ...shutKey }, ...(hold > 0 ? [{ time: b0, ...shutKey, curve: shaped(b0, b1, shutKey, rest, false) } as Key] : []), { time: b1, ...rest });
        if (hold <= 0) (keys[keys.length - 2] as Record<string, unknown>).curve = shaped(a1, b1, shutKey, rest, false);
      }
      keys.push({ time: d, ...rest });
      tl[prop] = dedupe(keys);
    };
    if (!shut) track("scale", { x: open.scaleX, y: open.scaleY }, { x: open.scaleX, y: l.closedScale ?? 0.1 });
    else {
      if ((shut.x ?? 0) !== open.x || (shut.y ?? 0) !== open.y) track("translate", { x: open.x, y: open.y }, { x: shut.x ?? 0, y: shut.y ?? 0 });
      if ((shut.rotate ?? 0) !== open.rotate) track("rotate", { value: open.rotate }, { value: shut.rotate ?? 0 });
      if ((shut.scaleX ?? 1) !== open.scaleX || (shut.scaleY ?? 1) !== open.scaleY) track("scale", { x: open.scaleX, y: open.scaleY }, { x: shut.scaleX ?? 1, y: shut.scaleY ?? 1 });
      if (!Object.keys(tl).length) throw new Error(`The closed pose of ${l.bone} is its setup pose`);
    }
    (anim.bones ??= {})[l.bone] = tl;
  }
  // Eased lid motion; the held key at the end keeps the loop length.
  const given = (o.lids ?? []).flatMap((l) => [l.closedScale, l.closed?.x, l.closed?.y, l.closed?.rotate, l.closed?.scaleX, l.closed?.scaleY]);
  const r = tidyGenerated({ animation: deriveAnimationWithNotes(anim, [] as DeriveOp[], { skeleton }).animation, notes: [] as string[] }, fps, given);
  if (o.hideAt !== undefined && o.lids?.length && o.hide?.length) {
    const lid = o.lids[0]!.bone, tracks = r.animation.bones?.[lid] ?? {};
    const doc: SkeletonJson = { ...skeleton, animations: { ...(skeleton.animations ?? {}), "spine-mcp-blink": r.animation } };
    const shape = (k: Key) => { const v = k as { x?: number; y?: number; value?: number }; return `${v.x ?? 0},${v.y ?? 0},${v.value ?? 0}`; };
    const ends = (name: string) => { const ks = tracks[name] as Key[] | undefined; const s = ks?.find((k) => shape(k) !== shape(ks[0]!)); return s ? [ks![0] as Record<string, number>, s as Record<string, number>] as const : null; };
    const sc = ends("scale"), tr = ends("translate"), ro = ends("rotate");
    const closure = (t: number) => {
      const b = samplePose(doc, "spine-mcp-blink", Math.min(t, d)).bones[lid] ?? { x: 0, y: 0, rotate: 0, scaleX: 1, scaleY: 1 };
      if (tr) { const ox = tr[0].x ?? 0, oy = tr[0].y ?? 0, sx = (tr[1].x ?? 0) - ox, sy = (tr[1].y ?? 0) - oy; return ((b.x - ox) * sx + (b.y - oy) * sy) / (sx * sx + sy * sy || 1); }
      if (ro) { const o0 = ro[0].value ?? 0; return (b.rotate - o0) / ((ro[1].value ?? 0) - o0 || 1); }
      if (sc) { const o0 = sc[0].y ?? 1; return (b.scaleY - o0) / ((sc[1].y ?? 1) - o0 || 1); }
      return 0;
    };
    const shutAt = (f: number) => closure(f / fps) >= o.hideAt! - 1e-9;
    const firstShut = (a: number, b: number) => { for (let f = Math.ceil(a * fps - 1e-6); f <= Math.floor(b * fps + 1e-6); f++) if (shutAt(f)) return fr(f / fps); return fr(b); };
    const lastShut = (a: number, b: number) => { for (let f = Math.floor(b * fps + 1e-6); f >= Math.ceil(a * fps - 1e-6); f--) if (shutAt(f)) return fr(f / fps); return fr(a); };
    const switches = starts.map((s) => [firstShut(s, s + close), lastShut(s + close + hold, s + span)] as const);
    for (const h of o.hide) {
      const sl = slots.get(h)!, shown: Key = sl.attachment ? { name: sl.attachment } : {};
      const keys: Key[] = [{ ...shown }];
      for (const [off, on] of switches) keys.push({ time: off }, { time: on, ...shown });
      keys.push({ time: d, ...shown });
      (r.animation.slots ??= {})[h] = { ...(r.animation.slots?.[h] ?? {}), attachment: dedupe(keys) };
    }
    notes.push(`Hidden slots switch on whole frames by the lids' ${r3(o.hideAt * 100)}% shut point on the eased curve: off on the first frame at or past it (${switches.map(([a]) => `${a}s`).join(", ")}), back on the last frame still at it (${switches.map(([, b]) => `${b}s`).join(", ")}).`);
  }
  return {
    animation: r.animation,
    notes: [
      `${starts.length} blink(s) at ${starts.map((s) => `${r3(s)}s`).join(", ")}: shut in ${r3(close)}s, held ${r3(hold)}s, open in ${r3(open)}s (${Math.round(close * fps)} / ${Math.round(hold * fps)} / ${Math.round(open * fps)} frames at ${fps} fps); loop ${d}s.${o.hide?.length ? ` Hidden while shut: ${o.hide.join(", ")}.` : ""} Play it on its own track over the idle so blinks do not depend on the idle's length${o.onPoses ? ` (start both together: the blinks line up with ${o.onPoses.source})` : ""}.`,
      ...notes,
      ...r.notes,
    ],
  };
}

const TORSO = /(^|[^a-z])(chest|torso|spine|body|belly|upper[-_ ]?body|ribs?)([^a-z]|$)/i;
const FOLLOW = /(^|[^a-z])(head|neck|shoulders?|clavicle|upper[-_ ]?arm)/i;
const CLOSED = /(clos|blink|shut)/i;
const HALF = /half/i;
const LID = /lid/i;

/** Candidate bones and eye slots found by name. Suggestions only: the caller chooses. */
export function suggest(skeleton: SkeletonJson): Suggestions {
  const eyes: BlinkEye[] = [];
  for (const slot of skeleton.slots ?? []) {
    const names = new Set<string>();
    for (const skin of skeleton.skins ?? []) for (const n of Object.keys(skin.attachments?.[slot.name] ?? {})) names.add(n);
    const closed = [...names].find((n) => CLOSED.test(n) && !HALF.test(n));
    const open = slot.attachment && names.has(slot.attachment) && slot.attachment !== closed ? slot.attachment : undefined;
    if (closed && open && (/eye/i.test(slot.name) || /eye/i.test(closed))) eyes.push({ slot: slot.name, open, closed, ...(([...names].find((n) => HALF.test(n))) ? { half: [...names].find((n) => HALF.test(n))! } : {}) });
  }
  const physics = new Set((skeleton.constraints ?? []).filter((c) => (c as { type?: string }).type === "physics").map((c) => (c as { bone?: string }).bone));
  const mouths: Suggestions["mouths"] = [];
  for (const slot of skeleton.slots ?? []) {
    if (!/mouth|lips?([^a-z]|$)/i.test(slot.name)) continue;
    const names = new Set<string>();
    for (const skin of skeleton.skins ?? []) for (const n of Object.keys(skin.attachments?.[slot.name] ?? {})) names.add(n);
    if (names.size >= 2) mouths.push({ slot: slot.name, attachments: [...names] });
  }
  // Slots whose setup attachment is a mesh (deform generators need vertices).
  const meshSlots = (skeleton.slots ?? []).filter((sl) => (skeleton.skins ?? []).some((sk) => (sk.attachments?.[sl.name]?.[sl.attachment ?? ""] as { type?: string } | undefined)?.type === "mesh")).map((sl) => sl.name);
  return {
    faces: meshSlots.filter((n) => /(^|[^a-z])(head|face)([^a-z]|$)/i.test(n)).slice(0, 3),
    features: meshSlots.filter((n) => /(eye|nose|mouth|brow|ear|cheek|pupil|lip)/i.test(n)).slice(0, 12),
    bodies: meshSlots.filter((n) => /(body|torso|chest|belly|head|blob|slime)/i.test(n)).slice(0, 6),
    look: {
      bones: skeleton.bones.filter((b) => /(^|[^a-z])(neck|head)([^a-z]|$)/i.test(b.name)).map((b) => b.name).slice(0, 3),
      eyeBones: skeleton.bones.filter((b) => /(eye|pupil|iris)/i.test(b.name) && !LID.test(b.name)).map((b) => b.name).slice(0, 4),
    },
    dangling: skeleton.bones.filter((b) => /(tail|hair|antenna|ear([^a-z]|$)|cape|scarf|ribbon|braid|tentacle|ponytail|bang|tassel)/i.test(b.name) && ((b as { length?: number }).length ?? 0) > 0 && !physics.has(b.name)).map((b) => b.name).slice(0, 12),
    mouths: mouths.slice(0, 4),
    jaws: skeleton.bones.filter((b) => /(jaw|chin)/i.test(b.name)).map((b) => b.name).slice(0, 3),
    torso: skeleton.bones.filter((b) => TORSO.test(b.name)).map((b) => b.name).slice(0, 6),
    followers: skeleton.bones.filter((b) => FOLLOW.test(b.name)).map((b) => b.name).slice(0, 8),
    eyes: eyes.slice(0, 6),
    lids: skeleton.bones.filter((b) => LID.test(b.name)).map((b) => b.name).slice(0, 6),
  };
}

export interface Look {
  /** When the look starts (seconds). */
  time: number;
  /** Head turn in degrees (counter-clockwise positive), relative to the setup pose. */
  angle?: number;
  /** Or a point to look at, in skeleton space: the turn comes from `facing`, `amount` and `limit`. */
  x?: number;
  y?: number;
  /** Eye offset in skeleton units (world x right, y up); with a point it is aimed at the point. */
  eyes?: [number, number];
}

export interface LookAtOptions {
  /** The chain that turns, from the base (neck) to the head; each child inherits its parent's turn. */
  bones: string[];
  /** Share of the turn per bone (default growing toward the head, summing to 1). */
  weights?: number[];
  /** Eye bones moved (translate) toward the look; range = how far for a full look (default 2% of the skeleton height). */
  eyeBones?: { bone: string; range?: number }[];
  looks: Look[];
  /** Direction the character faces in the setup pose, world degrees (0 = right, 180 = left). Used for points. Default 0. */
  facing?: number;
  /** For points: share of the direction the head turns (the eyes do the rest). Default 0.35. */
  amount?: number;
  /** Largest head turn in degrees (default 60). */
  limit?: number;
  /** Head turn time in seconds (default 0.3); the eyes get there in 40% of it and the head starts `lead` later. */
  turnTime?: number;
  lead?: number;
  /** Overshoot of the head turn before it settles (default 0.08 = 8%). */
  overshoot?: number;
  /** Total length (default: last look + 1 s). With loop (default true) it ends where it started. */
  duration?: number;
  loop?: boolean;
}

/**
 * Looks: the eyes get there first, the head chain follows a beat later with a small overshoot and settle, each bone
 * taking its share of the turn. Turns come as angles, or from points in skeleton space (computed from the setup pose).
 */
export function lookAt(skeleton: SkeletonJson, o: LookAtOptions): { animation: AnimationJson; notes: string[] } {
  const names = new Set(skeleton.bones.map((b) => b.name));
  const missing = [...o.bones, ...(o.eyeBones ?? []).map((e) => e.bone)].filter((b) => !names.has(b));
  if (missing.length) throw new Error(`Unknown bone(s): ${missing.join(", ")}`);
  if (!o.bones.length) throw new Error("lookAt needs the chain that turns (bones), e.g. [neck, head]");
  if (!o.looks.length) throw new Error("lookAt needs at least one look");
  const n = o.bones.length;
  const weights = o.weights ?? Array.from({ length: n }, (_, i) => (i + 1) / ((n * (n + 1)) / 2));
  if (weights.length !== n) throw new Error(`weights needs ${n} values (one per bone)`);
  const fps = projectFps(skeleton), fr = (t: number) => snapTime(t, fps);
  const limit = o.limit ?? 60, amount = o.amount ?? 0.35, facing = o.facing ?? 0, over = o.overshoot ?? 0.08;
  const turn = Math.max(1, framesOf(o.turnTime ?? 9 / 30, fps)) / fps, lead = framesOf(o.lead ?? 2 / 30, fps) / fps;
  const looks = [...o.looks].map((l) => ({ ...l, time: fr(l.time) })).sort((a, b) => a.time - b.time);
  // Setup world positions for points (head = last bone, eyes for their own aim).
  const data = loadSkeletonData(skeleton);
  const sk = new spine.Skeleton(data);
  sk.setupPose();
  sk.updateWorldTransform(spine.Physics.none);
  const at = (b: string) => { const p = sk.findBone(b)!.appliedPose; return [p.worldX, p.worldY] as const; };
  const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
  const height = skeleton.skeleton.height ?? 0;
  const state = looks.map((l) => {
    let angle = l.angle ?? 0, eyes = l.eyes;
    if (l.x !== undefined && l.y !== undefined) {
      const [hx, hy] = at(o.bones[n - 1]!);
      const dir = (Math.atan2(l.y - hy, l.x - hx) * 180) / Math.PI;
      angle = roundHalfAway(wrap(dir - facing) * amount);
      if (!eyes && o.eyeBones?.length) eyes = [Math.cos((dir * Math.PI) / 180), Math.sin((dir * Math.PI) / 180)];
    } else if (eyes && o.eyeBones?.length) {
      const len = Math.hypot(eyes[0], eyes[1]) || 1;
      eyes = [eyes[0] / len, eyes[1] / len];
    }
    return { time: l.time, angle: Math.max(-limit, Math.min(limit, angle)), eyes: eyes ?? [0, 0] };
  });
  const clamped = looks.filter((l, i) => Math.abs(state[i]!.angle) >= limit && (l.angle === undefined || Math.abs(l.angle) > limit)).length;
  const end = fr(o.duration ?? looks[looks.length - 1]!.time + turn + lead + 1);
  const loop = o.loop ?? true;
  const rest = { time: 0, angle: 0, eyes: [0, 0] as [number, number] };
  const start = state[0]!.time === 0 ? state[0]! : rest;
  // The moves: each look, then back to the start for a loop.
  const moves = state.filter((s) => s.time > 0).map((s) => ({ ...s }));
  // A move takes lead + turn, plus a quarter turn to settle after an overshoot.
  const settleTime = over > 0 ? fr(turn * 0.25) : 0, span = fr(lead + turn + settleTime);
  // A loop looks back to the start at the end, unless the last look already does.
  const last = moves[moves.length - 1];
  const backAlready = !!last && Math.abs(last.angle - start.angle) < 0.01 && Math.abs(last.eyes[0] - start.eyes[0]) < 1e-3 && Math.abs(last.eyes[1] - start.eyes[1]) < 1e-3;
  const back = loop && !backAlready ? { time: fr(Math.max(last ? last.time + span + 0.2 : 0, end - span - 0.05)), angle: start.angle, eyes: start.eyes } : null;
  if (back) moves.push(back);
  moves.forEach((m, i) => { if (i && m.time < fr(moves[i - 1]!.time + span)) throw new Error(`Looks at ${moves[i - 1]!.time}s and ${m.time}s overlap (each takes ${r3(span)}s)`); });
  for (const m of moves) {
    if (m.time + span <= end + 1e-6) continue;
    throw new Error(m === back
      ? `The look back to the start that closes the loop (at ${r3(m.time)}s, ${r3(span)}s long) does not finish within ${end}s: give a duration of at least ${r3(m.time + span)}s, end the looks on the start angle, or pass loop: false`
      : `A look at ${m.time}s (${r3(span)}s long) does not finish within ${end}s; give a duration of at least ${r3(m.time + span)}s`);
  }
  const anim: AnimationJson = { bones: {} };
  const reach = weights.map((_, i) => weights.slice(0, i + 1).reduce((a, w) => a + w, 0));
  const share = (total: number, i: number, computed = false) => {
    const whole = computed ? roundHalfAway(total) : total;
    const upTo = (k: number) => (k < 0 ? 0 : k === n - 1 ? whole : roundHalfAway(whole * reach[k]!));
    return upTo(i) - upTo(i - 1);
  };
  o.bones.forEach((b, i) => {
    const keys: Key[] = [{ value: share(start.angle, i) }];
    let prev = start.angle;
    for (const m of moves) {
      const t0 = fr(m.time + lead), t1 = fr(t0 + turn), v = share(m.angle, i), pv = share(prev, i);
      keys.push({ time: t0, value: pv });
      if (over > 0 && Math.abs(m.angle - prev) > 1) {
        keys.push({ time: fr(t0 + turn * 0.75), value: share(m.angle + (m.angle - prev) * over, i, true) }, { time: fr(t1 + settleTime), value: v });
      } else keys.push({ time: t1, value: v });
      prev = m.angle;
    }
    keys.push({ time: end, value: share(prev, i) });
    anim.bones![b] = { rotate: dedupe(keys) };
  });
  for (const e of o.eyeBones ?? []) {
    const range = e.range ?? Math.max(1, roundValue("translate", height * 0.02));
    // World offsets into the eye's parent space (setup rotation of the parent; the head turn is small next to it).
    const parent = sk.findBone(e.bone)!.parent!.appliedPose;
    const det = parent.a * parent.d - parent.b * parent.c || 1;
    const local = ([wx, wy]: [number, number]) => [((parent.d * wx - parent.b * wy) / det) * range, ((-parent.c * wx + parent.a * wy) / det) * range];
    const [sx, sy] = local(start.eyes);
    const keys: Key[] = [{ x: sx, y: sy }];
    let prev = start.eyes;
    for (const m of moves) {
      const [px, py] = local(prev), [x, y] = local(m.eyes);
      keys.push({ time: m.time, x: px, y: py }, { time: fr(m.time + Math.max(1 / fps, turn * 0.4)), x, y });
      prev = m.eyes;
    }
    const [ex, ey] = local(prev);
    keys.push({ time: end, x: ex, y: ey });
    anim.bones![e.bone] = { translate: dedupe(keys) };
  }
  const r = deriveAnimationWithNotes(anim, [{ op: "ease", easing: "easeInOutSine" }], { skeleton });
  const notes = [
    `${looks.length} look(s) over ${r3(end)}s${loop ? " (loops back to the start)" : ""}: eyes in ${r3(fr(Math.max(1 / fps, turn * 0.4)))}s, then ${o.bones.join(" > ")} in ${r3(turn)}s (${framesOf(turn, fps)} frames) starting ${r3(lead)}s later${over ? ` with a ${r3(over * 100)}% overshoot` : ""}; turn shares ${weights.map((w) => r3(w)).join(" / ")}.`,
    ...(clamped ? [`${clamped} look(s) were limited to ${limit} degrees.`] : []),
    "Keys are offsets from the setup pose: play it on its own track over the idle, or merge it into a hand-made idle.",
  ];
  const chain = new Set(o.bones);
  return tidyGenerated({ animation: r.animation, notes }, fps, [], { values: (kind, owner) => !(kind === "bone.rotate" && chain.has(owner)) });
}

export interface FollowThroughOptions {
  /** Bones that drag behind (a tail, hair, an antenna, ears), listed parent first; each needs a length. */
  bones: string[];
  /** Spring stiffness (Spine physics strength, default 80): higher follows faster. */
  strength?: number;
  /** Damping (default 0.8): lower swings longer. */
  damping?: number;
  /** How much the parent's motion carries over (Spine physics inertia, default 0.7). */
  inertia?: number;
  mass?: number;
  /** Gravity pull (default 0). */
  gravity?: number;
  fps?: number;
  loop?: boolean;
}

/**
 * Follow-through on bones that have no physics: a Spine physics constraint (rotation) is added to each bone for the
 * bake only, the source animation is simulated with spine-core's own solver (warm-up, best-matching cycle, seam
 * closed), and the result is written as rotation keys. The temporary constraints never reach the project.
 */
export function followThrough(skeleton: SkeletonJson, source: AnimationJson, o: FollowThroughOptions): { animation: AnimationJson; notes: string[] } {
  if (!o.bones.length) throw new Error("followThrough needs the bones that drag behind");
  if (!(animationDuration(source) > 0)) throw new Error("followThrough needs a source animation longer than 0 s: its motion drives the follow-through");
  const byName = new Map(skeleton.bones.map((b) => [b.name, b]));
  const missing = o.bones.filter((b) => !byName.has(b));
  if (missing.length) throw new Error(`Unknown bone(s): ${missing.join(", ")}`);
  const short = o.bones.filter((b) => !((byName.get(b) as { length?: number }).length! > 0));
  if (short.length) throw new Error(`Bones need a length for rotation follow-through (physics turns them from their tip): ${short.join(", ")}`);
  const existing = (skeleton.constraints ?? []).filter((c) => (c as { type?: string }).type === "physics" && o.bones.includes((c as { bone?: string }).bone ?? ""));
  if (existing.length) throw new Error(`Already driven by physics constraints (${existing.map((c) => c.name).join(", ")}): bake those with the bakePhysics derive op instead.`);
  // Parents first, so each link reacts to the one above it.
  const depth = (b: string): number => { const p = byName.get(b)?.parent; return p ? 1 + depth(p) : 0; };
  const ordered = [...o.bones].sort((a, b) => depth(a) - depth(b));
  const temp = ordered.map((b) => ({ type: "physics", name: `__follow_${b}`, bone: b, rotate: 1, inertia: o.inertia ?? 0.7, strength: o.strength ?? 80, damping: o.damping ?? 0.8, mass: o.mass ?? 1, gravity: o.gravity ?? 0 }));
  const doc: SkeletonJson = { ...structuredClone(skeleton), constraints: [...(skeleton.constraints ?? []), ...(temp as never[])] };
  const fps = o.fps ?? projectFps(skeleton);
  const baked = bakePhysics(source, doc, { bones: ordered, fps, loop: o.loop, authored: true, tolerance: { rotation: 0.3 } });
  const out = baked.animation;
  for (const t of temp) delete out.physics?.[t.name];
  if (out.physics && !Object.keys(out.physics).length) delete out.physics;
  // Rotation only: a chained bone read back from world space picks up a little scale and shear that the spring never
  // meant (and Spine re-keys differently), so its other channels stay as the source had them. Turns are unwrapped
  // to start within +-180.
  for (const b of ordered) {
    const tl = out.bones![b]!, src = source.bones?.[b] ?? {};
    for (const k of Object.keys(tl)) if (k !== "rotate") { if (src[k]) tl[k] = src[k]!; else delete tl[k]; }
    const rot = tl.rotate;
    if (rot?.length) { const shift = 360 * Math.round((rot[0]!.value ?? 0) / 360); if (shift) for (const k of rot) { k.value = (k.value ?? 0) - shift; if (Array.isArray(k.curve)) k.curve = k.curve.map((c, i) => (i % 2 ? c - shift : c)); } }
  }
  const touched = new Set(ordered);
  return tidyGenerated({
    animation: out,
    notes: [
      `Follow-through on ${ordered.join(" > ")} (strength ${temp[0]!.strength}, damping ${temp[0]!.damping}, inertia ${temp[0]!.inertia}), simulated with spine-core's physics and written as rotation keys; no constraint was added to the project.`,
      ...baked.notes.map((n) => n.replace(/;? ?physics mix keyed to 0 for __follow_[^;]*/, "")).filter((n) => !n.includes("__follow_")),
    ],
  }, fps, [], { only: (kind, owner) => kind.startsWith("bone.") && touched.has(owner) });
}

export function turningKeys(fn: (t: number) => number, length: number, fps = 30, minStep = 0.01, extra: number[] = []): Key[] {
  const n = Math.max(8, Math.round(length * fps * 4)), dt = length / n;
  const slope = (t: number) => { const a = Math.max(0, t - dt / 4), b = Math.min(length, t + dt / 4); return (fn(b) - fn(a)) / (b - a); };
  const turns: number[] = [];
  for (let i = 1; i < n; i++) {
    const a = fn((i - 1) * dt), b = fn(i * dt), c = fn((i + 1) * dt);
    if ((b - a) * (c - b) < 0) {
      let lo = (i - 1) * dt, hi = (i + 1) * dt;
      for (let k = 0; k < 40; k++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if ((fn(m1) < fn(m2)) === (b > a)) lo = m1; else hi = m2; }
      const t = (lo + hi) / 2;
      if (t - (turns[turns.length - 1] ?? 0) >= minStep) turns.push(t);
    }
  }
  const end = snapTime(length, fps);
  type Stop = { time: number; value: number; kind: "end" | "mark" | "turn" };
  const stops: Stop[] = [{ time: 0, value: fn(0), kind: "end" }, { time: end, value: fn(length), kind: "end" }];
  const taken = (t: number) => stops.some((x) => Math.abs(x.time - t) < 1e-9);
  for (const e of extra) { const t = snapTime(e, fps); if (t > 0 && t < end && !taken(t)) stops.push({ time: t, value: fn(t), kind: "mark" }); }
  for (const tt of turns) { const t = snapTime(tt, fps); if (t > 0 && t < end && !taken(t)) stops.push({ time: t, value: fn(tt), kind: "turn" }); }
  stops.sort((a, b) => a.time - b.time);
  const ahead = (t: number) => (fn(Math.min(length, t + dt / 4)) - fn(t)) / Math.max(1e-9, Math.min(length, t + dt / 4) - t);
  const tangent = (k: number) => { const st = stops[k]!; return st.kind === "turn" ? 0 : st.kind === "mark" ? ahead(st.time) : slope(k === 0 ? 0 : length); };
  return stops.map((st, i) => {
    const key: Key = { time: st.time, value: st.value };
    const next = stops[i + 1];
    if (next) {
      const d = next.time - st.time, m0 = tangent(i), m1 = next.kind === "mark" ? 0 : tangent(i + 1);
      (key as Record<string, unknown>).curve = [+(st.time + d / 3).toFixed(6), +(st.value + (m0 * d) / 3).toFixed(4), +(next.time - d / 3).toFixed(6), +(next.value - (m1 * d) / 3).toFixed(4)];
    }
    return key;
  });
}

export interface SwayOptions {
  bones: string[];
  amount?: number;
  period?: number;
  lag?: number;
  harmonic?: number;
  duration?: number;
}

export function sway(skeleton: SkeletonJson, o: SwayOptions): { animation: AnimationJson; notes: string[] } {
  const known = new Set(skeleton.bones.map((b) => b.name)), missing = o.bones.filter((b) => !known.has(b));
  if (missing.length) throw new Error(`Unknown bone(s): ${missing.join(", ")}`);
  if (!o.bones.length) throw new Error("sway needs bones (a chain, parent first)");
  const fps = projectFps(skeleton);
  const period = o.period ?? 3, cycles = Math.max(1, Math.round((o.duration ?? period) / period)), length = snapTime(cycles * period, fps);
  const amount = o.amount ?? 3, lag = snapTime((o.lag ?? 0.1) * period, fps), h = o.harmonic ?? 0.25;
  const anim: AnimationJson = { bones: {} };
  o.bones.forEach((b, i) => {
    const w = (2 * Math.PI * cycles) / length, a = amount * (1 - 0.15 * i); // whole cycles over the snapped length, so the loop closes
    const fn = (t: number) => (a * (Math.sin(w * (t - i * lag)) + h * Math.sin(2 * w * (t - i * lag) + Math.PI))) / (1 + h);
    anim.bones![b] = { rotate: turningKeys(fn, length, fps) };
  });
  return tidyGenerated({
    animation: anim,
    notes: [
      `Sway: ${o.bones.length} bone(s), ±${amount}° on the first, each further bone ${r3(lag)}s later and 15% less, ${cycles} whole cycle(s) of ${period}s (loop ${length}s), a ${Math.round(h * 100)}% second harmonic against the first for an uneven swing. Keys only at the turning points.`,
      "Starts at the setup pose on the first bone. For wind, run followThrough over it.",
    ],
  }, fps);
}

export interface SettleOptions {
  bones: string[];
  amounts?: number[];
  at?: number;
  amount?: number;
  swings?: number;
  decay?: number;
  period?: number;
  lag?: number;
  ratio?: number;
  duration?: number;
}

export function settle(skeleton: SkeletonJson, o: SettleOptions): { animation: AnimationJson; notes: string[] } {
  const known = new Set(skeleton.bones.map((b) => b.name)), missing = o.bones.filter((b) => !known.has(b));
  if (missing.length) throw new Error(`Unknown bone(s): ${missing.join(", ")}`);
  if (!o.bones.length) throw new Error("settle needs bones (parent first: shoulder, elbow, wrist)");
  const fps = projectFps(skeleton), at = snapTime(o.at ?? 0, fps), amount = o.amounts?.[0] ?? o.amount ?? 6, swings = o.amounts?.length ?? o.swings ?? 5, decay = o.decay ?? 0.7;
  const period = o.period ?? 0.8, lag = snapTime(o.lag ?? 3 / fps, fps), ratio = o.ratio ?? 0.6;
  const end = at + (o.bones.length - 1) * lag + swings * (period / 2);
  const length = snapTime(Math.max(o.duration ?? 0, end), fps);
  const anim: AnimationJson = { bones: {} };
  o.bones.forEach((b, i) => {
    const start = at + i * lag, a = amount * ratio ** i, lambda = -Math.log(decay) / (period / 2), stop = start + swings * (period / 2);
    const fn = (t: number) => {
      if (t <= start) return 0;
      const x = t - start, half = period / 2, wave = Math.abs(Math.sin((2 * Math.PI * x) / period)) * (a < 0 ? -1 : 1);
      let core = a * Math.exp(-lambda * x) * Math.sin((2 * Math.PI * x) / period);
      if (o.amounts?.length) {
        const k = x / half - 0.5, i0 = Math.max(0, Math.min(o.amounts.length - 1, Math.floor(k))), i1 = Math.min(o.amounts.length - 1, i0 + 1), u = Math.max(0, Math.min(1, k - i0));
        const env = Math.abs(o.amounts[i0]!) * (1 - u) + Math.abs(o.amounts[i1]!) * u;
        core = env * ratio ** i * wave * (Math.floor(x / half) % 2 === 0 ? 1 : -1);
      }
      return t <= stop ? core : 0;
    };
    const keys = turningKeys(fn, length, fps, 0.01, [start]);
    let swing = 0;
    keys.forEach((k, n) => {
      const v = k.value ?? 0;
      if (!o.amounts?.length || swing >= o.amounts.length || (k.time ?? 0) <= start + 1e-9 || Math.abs(v) < 1e-6) return;
      const d = Math.sign(v) * Math.abs(o.amounts[swing++]!) * ratio ** i - v;
      k.value = v + d;
      const own = k.curve, prev = keys[n - 1]?.curve;
      if (Array.isArray(own)) own[1] = +(own[1]! + d).toFixed(4);
      if (Array.isArray(prev)) prev[3] = +(prev[3]! + d).toFixed(4);
    });
    anim.bones![b] = { rotate: keys };
  });
  return tidyGenerated({
    animation: anim,
    notes: [
      `Settle from ${at}s: ${swings} ${o.amounts?.length ? `swings of ${o.amounts.join(" / ")}° (` : `decaying swings (each ${Math.round(decay * 100)}% of the one before, `}${period}s per full swing) from ±${amount}° on ${o.bones[0]}; each further bone ${r3(lag * fps)} frame(s) later at ${Math.round(ratio * 100)}% of its parent's swing. Keys at the turning points with the speed kept through them; back at the setup pose by ${r3(end)}s (loop ${length}s).`,
    ],
  }, fps, [...(o.amounts ?? []), o.amount]);
}
