import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { spine } from "./runtime.js";

/** Worst opening of one joint in an animation: background reaching in towards the pivot between two parts. */
export interface JointGap {
  skin: string;
  /** Child bone of the joint (the pivot is its origin) and the parent whose parts it meets. */
  bone: string;
  parent: string;
  /** Slots whose parts meet at the joint. */
  slots: string[];
  /** Radius of the disk around the pivot that the parts cover at setup, in skeleton units. */
  radius: number;
  /** Share of that disk the joint's parts leave uncovered, in percent. */
  openPercent: number;
  /**
   * Nearest background to the pivot, in disk radii (1: none inside the disk): a crack or a notch between square-ended
   * parts reaches in towards the pivot, the outside of a clean bend stays near the rim.
   */
  reach: number;
  time: number;
}

// Disk samples: a square grid clipped to the unit disk (about 500 points).
const GRID = 25;
const DISK: [number, number][] = [];
for (let i = 0; i < GRID; i++) for (let j = 0; j < GRID; j++) {
  const x = (2 * i + 1) / GRID - 1, y = (2 * j + 1) / GRID - 1;
  if (x * x + y * y <= 1) DISK.push([x, y]);
}
// The joint disk: the largest radius the setup pose covers to SETUP_COVER (a clean joint keeps it covered).
const SETUP_COVER = 0.97;
// Parts of one side meet the other through at most this many bones without art (a shoulder bone between torso and arm).
const LINK_DEPTH = 2;
// A hinge: the pivot stays put on the parent (within SLIDE of the disk radius) and neither side scales past SCALE.
// Sliding parts (pupils, control bones, props moving over a background) and scaling ones (pop-ins) are no hinges.
const SLIDE = 0.15;
const SCALE = 0.1;
// A joint opens by bending: frames under BEND degrees from the setup angle are skipped (deform keys reshaping a part
// are not a joint opening).
const BEND = 10;
// A child part lying mostly on its parent's parts (a blush, an eyebrow on a face) is a decoration, not a limb.
const DECORATION = 0.8;
// A joint opens when background comes within OPEN_REACH radii of the pivot. Calibrated on the official examples (every
// joint of every animation stays at 0.51 or more; a clean bend's outside stays near the rim) and on two square-ended
// parts meeting at the pivot (0.11, 0.25 with a small overlap); a rounded cap over the joint keeps 0.82.
export const OPEN_REACH = 0.4;
// Joints whose disk is smaller than this share of the skeleton's size are a few pixels: left out.
const MIN_RADIUS = 0.015;
export const STRESS_TURNS = [30, 60, 90, 120];

/** An image's pixels (RGBA, row 0 at the top). */
export interface Img { width: number; height: number; data: Uint8Array | Uint8ClampedArray }
/** The image of an attachment path ("head", "goblin/left-arm"), or null when it is not on disk. */
export type ImageLookup = (path: string) => Img | null;

/** Images under a project's images folder as Spine finds them (`<path>.png`), each read once. */
export function folderImages(dir: string): ImageLookup {
  const cache = new Map<string, Img | null>();
  return (path) => {
    if (!cache.has(path)) {
      const file = join(dir, `${path}.png`);
      let img: Img | null = null;
      try { if (existsSync(file)) { const p = PNG.sync.read(readFileSync(file)); img = { width: p.width, height: p.height, data: p.data }; } } catch { img = null; }
      cache.set(path, img);
    }
    return cache.get(path)!;
  };
}

/** A drawn part: world triangles as flat [ax, ay, bx, by, cx, cy] runs and, with its image, their UVs in the same order. */
interface Part { xy: number[]; uv: number[] | null; img: Img | null; box: [number, number, number, number] }

// A pixel counts as drawn from this alpha (0-255).
const OPAQUE = 128;

function part(sk: spine.Skeleton, slot: spine.Slot, images?: ImageLookup): Part | null {
  const att = slot.appliedPose.getAttachment();
  if (slot.appliedPose.color.a < 0.01 || !slot.bone.active) return null;
  let v: number[], tris: ArrayLike<number>;
  if (att instanceof spine.MeshAttachment) {
    v = new Array<number>(att.worldVerticesLength);
    att.computeWorldVertices(sk, slot, 0, att.worldVerticesLength, v, 0, 2);
    tris = att.triangles;
  } else if (att instanceof spine.RegionAttachment) {
    v = new Array<number>(8).fill(0);
    att.computeWorldVertices(slot, att.getOffsets(slot.appliedPose), v, 0, 2);
    tris = [0, 1, 2, 0, 2, 3];
  } else return null;
  const xy: number[] = [], box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let k = 0; k < tris.length; k++) {
    const x = v[tris[k]! * 2]!, y = v[tris[k]! * 2 + 1]!;
    xy.push(x, y);
    box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
  }
  // The loader gives every region the whole image (u 0..1), so sequence UVs are image UVs.
  const index = att.sequence.resolveIndex(slot.appliedPose);
  const img = images?.(att.sequence.getPath(att.path ?? att.name, index)) ?? null;
  if (!img) return { xy, uv: null, img: null, box };
  const u = att.sequence.getUVs(index), uv: number[] = [];
  for (let k = 0; k < tris.length; k++) uv.push(u[tris[k]! * 2]!, u[tris[k]! * 2 + 1]!);
  return { xy, uv, img, box };
}

/** Whether a part draws at (x, y): inside one of its triangles and, with its image, on a pixel of OPAQUE alpha or more. */
function draws(p: Part, x: number, y: number): boolean {
  if (x < p.box[0] || y < p.box[1] || x > p.box[2] || y > p.box[3]) return false;
  const t = p.xy;
  for (let k = 0; k < t.length; k += 6) {
    const ax = t[k]!, ay = t[k + 1]!, bx = t[k + 2]!, by = t[k + 3]!, cx = t[k + 4]!, cy = t[k + 5]!;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-9) continue;
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det, l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det, l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    if (!p.img || !p.uv) return true;
    const u = l1 * p.uv[k]! + l2 * p.uv[k + 2]! + l3 * p.uv[k + 4]!, w = l1 * p.uv[k + 1]! + l2 * p.uv[k + 3]! + l3 * p.uv[k + 5]!;
    const px = Math.min(p.img.width - 1, Math.max(0, Math.floor(u * p.img.width))), py = Math.min(p.img.height - 1, Math.max(0, Math.floor(w * p.img.height)));
    if (p.img.data[(py * p.img.width + px) * 4 + 3]! >= OPAQUE) return true;
  }
  return false;
}

function covers(parts: Part[], x: number, y: number): boolean {
  for (const p of parts) if (draws(p, x, y)) return true;
  return false;
}

/** Disk samples around (cx, cy) at radius r that the parts leave uncovered. */
function open(parts: Part[], cx: number, cy: number, r: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [dx, dy] of DISK) {
    const x = cx + dx * r, y = cy + dy * r;
    if (!covers(parts, x, y)) out.push([x, y]);
  }
  return out;
}

/** Nearest disk sample to (cx, cy) that no part covers, in radii (1 when all are covered). */
function reachOf(parts: Part[], cx: number, cy: number, r: number): number {
  let best = 1;
  for (const [dx, dy] of DISK) {
    const d = Math.hypot(dx, dy);
    if (d < best && !covers(parts, cx + dx * r, cy + dy * r)) best = d;
  }
  return best;
}

/** Bones an attachment follows: the slot's bone, or every bone weighting a mesh. */
function attachmentBones(slot: spine.SlotData, att: spine.Attachment | null): number[] {
  if (att instanceof spine.MeshAttachment && att.bones) {
    const out: number[] = [];
    for (let k = 0; k < att.bones.length; k += att.bones[k]! + 1) for (let j = 1; j <= att.bones[k]!; j++) out.push(att.bones[k + j]!);
    return out;
  }
  return [slot.boneData.index];
}

interface Joint { bone: number; parent: number; slots: number[]; radius: number; local: [number, number]; scale: number[]; angle: number }

/**
 * Joints of a skeleton wearing a skin, at setup: a bone whose parts meet the parts of an ancestor (through at most
 * LINK_DEPTH bones without art) and whose pivot those parts cover. One weighted mesh across both bones is a skinned
 * joint, not two parts, and is left out.
 */
function joints(sk: spine.Skeleton, images?: ImageLookup): Joint[] {
  const minRadius = MIN_RADIUS * Math.max(sk.data.width, sk.data.height, 0);
  const bySlot = new Map<number, number[]>(), withArt = new Set<number>();
  sk.slots.forEach((slot, i) => {
    const att = slot.pose.getAttachment();
    if (!(att instanceof spine.MeshAttachment || att instanceof spine.RegionAttachment) || slot.pose.color.a < 0.01 || !slot.bone.active) return;
    const bones = attachmentBones(slot.data, att);
    bySlot.set(i, bones);
    for (const b of bones) withArt.add(b);
  });
  const out: Joint[] = [];
  for (const bone of sk.bones) {
    const c = bone.data.index;
    if (!withArt.has(c) || !bone.active) continue;
    let p = bone.data.parent;
    for (let depth = 0; p && !withArt.has(p.index) && depth < LINK_DEPTH; depth++) p = p.parent;
    // Parts on the root are backgrounds and stages, not limbs.
    if (!p || !p.parent || !withArt.has(p.index)) continue;
    // Rigid parts of each side: everything on the one bone (a mesh weighted across both is a skinned joint).
    const child = [...bySlot].filter(([, b]) => b.every((x) => x === c)).map(([s]) => s);
    const parent = [...bySlot].filter(([, b]) => b.every((x) => x === p!.index)).map(([s]) => s);
    if (!child.length || !parent.length) continue;
    const slots = [...child, ...parent];
    const tris = slots.map((s) => part(sk, sk.slots[s]!, images)).filter((t): t is Part => !!t);
    const under = parent.map((s) => part(sk, sk.slots[s]!, images)).filter((t): t is Part => !!t);
    const centres = child.flatMap((s) => { const t = part(sk, sk.slots[s]!)?.xy ?? [], out: [number, number][] = []; for (let k = 0; k < t.length; k += 6) out.push([(t[k]! + t[k + 2]! + t[k + 4]!) / 3, (t[k + 1]! + t[k + 3]! + t[k + 5]!) / 3]); return out; });
    if (centres.filter(([x, y]) => covers(under, x, y)).length >= DECORATION * centres.length) continue;
    const x = bone.appliedPose.worldX, y = bone.appliedPose.worldY;
    // Largest covered radius by doubling then bisection. A pivot outside the drawn parts (a head bone at the back of
    // the neck) is no joint to check, nor is one whose background already comes in at setup.
    const ok = (r: number) => 1 - open(tris, x, y, r).length / DISK.length >= SETUP_COVER;
    if (!ok(0.5)) continue;
    let lo = 0.5, hi = 1;
    while (ok(hi) && hi < 1e4) { lo = hi; hi *= 2; }
    for (let k = 0; k < 8; k++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
    if (lo < minRadius) continue;
    const all = sk.drawOrder.appliedPose.map((s) => part(sk, s, images)).filter((t): t is Part => !!t);
    if (reachOf(all, x, y, lo) < OPEN_REACH) continue;
    out.push({ bone: c, parent: p.index, slots, radius: lo, ...hinge(sk, c, p.index) });
  }
  return out;
}

/** The pivot in the parent's space and both bones' world scales: what a hinge keeps. */
function hinge(sk: spine.Skeleton, bone: number, parent: number): { local: [number, number]; scale: number[]; angle: number } {
  const c = sk.bones[bone]!.appliedPose, p = sk.bones[parent]!.appliedPose;
  const v = p.worldToLocal(new spine.Vector2(c.worldX, c.worldY));
  return { local: [v.x, v.y], scale: [c.getWorldScaleX(), c.getWorldScaleY(), p.getWorldScaleX(), p.getWorldScaleY()], angle: c.getWorldRotationX() - p.getWorldRotationX() };
}

/**
 * Joints that open while an animation plays: two parts meeting at a bone's pivot (an elbow, a knee, a neck) cover a
 * disk around it at setup; any frame that uncovers part of that disk shows a gap or a notch between the parts. Sampled
 * at fps over each skin (default first); the worst frame per joint. Geometry only: transparent margins of the images
 * count as covered, so gaps hidden in them are missed rather than reported.
 */
export function jointGaps(data: spine.SkeletonData, anim: spine.Animation, fps = 30, images?: ImageLookup): JointGap[] {
  const skins = [data.defaultSkin, ...data.skins.filter((s) => s !== data.defaultSkin)].filter((s): s is spine.Skin => !!s);
  const worst = new Map<string, JointGap>();
  const n = Math.max(1, Math.round(anim.duration * fps));
  const seen = new Set<string>();
  for (const skin of skins) {
    const sk = new spine.Skeleton(data);
    sk.setSkin(skin);
    sk.setupPose();
    sk.updateWorldTransform(spine.Physics.none);
    // Joints made of the same attachments in an earlier skin are measured once.
    const list = joints(sk, images).filter((j) => {
      const id = `${j.bone}|${j.slots.map((s) => `${s}:${sk.slots[s]!.pose.getAttachment()?.name}`).sort().join(",")}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (!list.length) continue;
    const setupAtts = new Map(list.flatMap((j) => j.slots.map((s) => [s, sk.slots[s]!.pose.getAttachment()] as const)));
    for (let f = 0; f <= n; f++) {
      const t = (anim.duration * f) / n;
      sk.setupPose();
      anim.apply(sk, t, t, false, null, 1, spine.MixFrom.setup, false, false, false);
      sk.updateWorldTransform(spine.Physics.none);
      const order = sk.drawOrder.appliedPose;
      let all: Part[] | undefined;
      for (const j of list) {
        // A part swapped or hidden at this frame is a drawing change, not a joint opening.
        if (j.slots.some((s) => sk.slots[s]!.appliedPose.getAttachment() !== setupAtts.get(s))) continue;
        const tris = j.slots.map((s) => part(sk, sk.slots[s]!, images));
        if (tris.some((x) => !x)) continue;
        const h = hinge(sk, j.bone, j.parent);
        if (Math.hypot(h.local[0] - j.local[0], h.local[1] - j.local[1]) > SLIDE * j.radius) continue;
        if (h.scale.some((v, i) => Math.abs(Math.abs(v) / Math.max(1e-6, Math.abs(j.scale[i]!)) - 1) > SCALE)) continue;
        const bend = Math.abs(((h.angle - j.angle) % 360 + 540) % 360 - 180);
        if (bend < BEND) continue;
        const pivot = sk.bones[j.bone]!.appliedPose;
        const gaps = open(tris as Part[], pivot.worldX, pivot.worldY, j.radius);
        const openPercent = +(100 * gaps.length / DISK.length).toFixed(1);
        if (openPercent <= 100 * (1 - SETUP_COVER)) continue;
        // The whole silhouette: other parts in front or behind (a torso behind an elbow) fill what the joint uncovers.
        all ??= order.map((s) => part(sk, s, images)).filter((t): t is Part => !!t);
        const reach = +reachOf(all, pivot.worldX, pivot.worldY, j.radius).toFixed(2);
        const key = `${skin.name}/${j.bone}/${j.slots.join(",")}`, prev = worst.get(key);
        if (!prev || reach < prev.reach || (reach === prev.reach && openPercent > prev.openPercent)) {
          worst.set(key, { skin: skin.name, bone: data.bones[j.bone]!.name, parent: data.bones[j.parent]!.name, slots: j.slots.map((s) => data.slots[s]!.name), radius: +j.radius.toFixed(1), openPercent, reach, time: +t.toFixed(3) });
        }
      }
    }
  }
  return [...worst.values()].sort((a, b) => a.reach - b.reach || b.openPercent - a.openPercent);
}

const label = (g: { skin: string; parent: string; bone: string }) => `${g.parent} > ${g.bone}${g.skin === "default" ? "" : ` (skin ${g.skin})`}`;

/** spine_validate issues for one animation: a warning per joint whose bend lets the background in at the pivot. */
export function jointIssues(data: spine.SkeletonData, anim: spine.Animation, fps = 30, images?: ImageLookup): { severity: "warning"; code: string; message: string }[] {
  return jointGaps(data, anim, fps, images).filter((g) => g.reach < OPEN_REACH).map((g) => ({
    severity: "warning", code: "joint-opens",
    message: `"${anim.name}": joint ${label(g)} opens at ${g.time}s: background comes within ${g.reach} of the joint radius (${g.radius}) of the pivot between ${g.slots.slice(0, 4).join(", ")}. Parts that meet at a joint need ends that overlap past the pivot and are rounded around it (or a cap drawn over it), so the bend keeps the pivot covered.`,
  }));
}

/** A joint whose turn from the setup pose opens it, at the smallest tested turn. */
export interface StressJoint { skin: string; bone: string; parent: string; degrees: number; reach: number }

/**
 * Joint stress test on the setup pose: each joint's child bone turned 30, 60, 90 and 120 degrees both ways (alone,
 * IK-driven bones left to their constraint); the smallest turn that lets the background within OPEN_REACH of the pivot.
 */
export function stressJoints(data: spine.SkeletonData, images?: ImageLookup, turns = STRESS_TURNS): StressJoint[] {
  const ik = new Set(data.constraints.filter((c): c is spine.IkConstraintData => c instanceof spine.IkConstraintData).flatMap((c) => c.bones.map((b) => b.index)));
  const out = new Map<string, StressJoint>();
  for (const skin of [data.defaultSkin, ...data.skins.filter((s) => s !== data.defaultSkin)].filter((s): s is spine.Skin => !!s)) {
    const sk = new spine.Skeleton(data);
    sk.setSkin(skin);
    sk.setupPose();
    sk.updateWorldTransform(spine.Physics.none);
    for (const j of joints(sk, images)) {
      const key = `${j.parent}>${j.bone}`;
      if (ik.has(j.bone) || out.has(key)) continue;
      found: for (const deg of turns) {
        for (const dir of [1, -1]) {
          sk.setupPose();
          sk.bones[j.bone]!.pose.rotation += dir * deg;
          sk.updateWorldTransform(spine.Physics.none);
          const all = sk.drawOrder.appliedPose.map((s) => part(sk, s, images)).filter((t): t is Part => !!t);
          const pivot = sk.bones[j.bone]!.appliedPose, reach = +reachOf(all, pivot.worldX, pivot.worldY, j.radius).toFixed(2);
          if (reach < OPEN_REACH) {
            out.set(key, { skin: skin.name, bone: data.bones[j.bone]!.name, parent: data.bones[j.parent]!.name, degrees: dir * deg, reach });
            break found;
          }
        }
      }
    }
  }
  return [...out.values()].sort((a, b) => Math.abs(a.degrees) - Math.abs(b.degrees) || a.reach - b.reach);
}
