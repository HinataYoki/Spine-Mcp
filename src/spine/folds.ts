import { spine } from "./runtime.js";

/** Worst fold of one mesh attachment in an animation: triangles turned over against the setup pose. */
export interface MeshFold {
  skin: string;
  slot: string;
  attachment: string;
  /** Triangles turned over, of the mesh's (non-sliver) triangles. */
  triangles: number;
  of: number;
  /** Setup-pose area of the turned triangles, in percent of the mesh's. */
  areaPercent: number;
  time: number;
  /** Every turned triangle lies under an attachment drawn later (another part hides the fold at that frame). */
  covered: boolean;
}

/** A bone whose turn folds the meshes it weights, at the smallest tested angle. */
export interface StressFold {
  bone: string;
  /** Smallest tested turn (either way) that turns triangles over. */
  degrees: number;
  attachments: { slot: string; attachment: string; triangles: number; areaPercent: number }[];
}

// Slivers count as neither orientation: under 2% of the mesh's mean triangle (or near zero), a small turn flips them
// without anything visible happening.
const SLIVER = 0.02;
// Whole-mesh changes are not folds: nearly all of the setup area turned over is a mirror (negative scale, a face of a
// fake 3D turn showing its back); a net area (in the setup orientation) under FLAT of the setup area is a collapse
// (turning edge-on, an eye white closing under the lids: the turned part lies over the rest). A fold keeps most of the
// mesh the right way round.
const MIRROR = 0.9;
const FLAT = 0.35;
// A fold needs a rest of the mesh to fold against: in a quad (two triangles) one turning over is the whole face turning
// (a fake 3D side passing edge-on), so meshes with fewer triangles are left out.
const MIN_TRIANGLES = 4;
export const STRESS_ANGLES = [15, 30, 45, 60, 90];
const STRESS_AREA = 1; // percent of a mesh's area: a thin triangle at a joint turning over alone shows nothing

type Mesh = { slot: spine.Slot; att: spine.MeshAttachment; setup: number[]; area: number; min: number };

function world(sk: spine.Skeleton, slot: spine.Slot, att: spine.MeshAttachment): number[] {
  const out = new Array<number>(att.worldVerticesLength);
  att.computeWorldVertices(sk, slot, 0, att.worldVerticesLength, out, 0, 2);
  return out;
}

/** Twice the signed area of each triangle. */
function crosses(v: number[], tris: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i]! * 2, b = tris[i + 1]! * 2, c = tris[i + 2]! * 2;
    out.push((v[b]! - v[a]!) * (v[c + 1]! - v[a + 1]!) - (v[c]! - v[a]!) * (v[b + 1]! - v[a + 1]!));
  }
  return out;
}

/** Turned triangles of a mesh now, against its setup orientation; null when it is mirrored or collapsing as a whole. */
function turned(m: Mesh, now: number[]): { triangles: number; of: number; area: number; which: number[] } | null {
  let n = 0, of = 0, area = 0, net = 0;
  const which: number[] = [];
  m.setup.forEach((s, i) => {
    if (Math.abs(s) < m.min) return;
    of++;
    const c = now[i]!;
    net += c * Math.sign(s);
    // A real fold: the opposite orientation with a visible share of its setup area (not one that only went flat).
    if (Math.sign(c) !== Math.sign(s) && Math.abs(c) > 0.01 * Math.abs(s)) { n++; area += Math.abs(s); which.push(i); }
  });
  if (of < MIN_TRIANGLES || area >= MIRROR * m.area || Math.abs(net) < FLAT * m.area) return null;
  return { triangles: n, of, area, which };
}

/** World triangles of everything drawn after `slot` (meshes and regions), as flat [ax, ay, bx, by, cx, cy] runs. */
function drawnAfter(sk: spine.Skeleton, slot: spine.Slot): number[] {
  const order = sk.drawOrder.appliedPose, out: number[] = [];
  for (let i = order.indexOf(slot) + 1; i < order.length; i++) {
    const s = order[i]!, att = s.appliedPose.getAttachment();
    if (s.appliedPose.color.a < 0.01 || !s.bone.active) continue;
    if (att instanceof spine.MeshAttachment) {
      const v = world(sk, s, att), t = att.triangles;
      for (let k = 0; k < t.length; k += 3) out.push(v[t[k]! * 2]!, v[t[k]! * 2 + 1]!, v[t[k + 1]! * 2]!, v[t[k + 1]! * 2 + 1]!, v[t[k + 2]! * 2]!, v[t[k + 2]! * 2 + 1]!);
    } else if (att instanceof spine.RegionAttachment) {
      const v = new Array<number>(8).fill(0);
      att.computeWorldVertices(s, att.getOffsets(s.appliedPose), v, 0, 2);
      out.push(v[0]!, v[1]!, v[2]!, v[3]!, v[4]!, v[5]!, v[0]!, v[1]!, v[4]!, v[5]!, v[6]!, v[7]!);
    }
  }
  return out;
}

function inside(x: number, y: number, t: number[], k: number): boolean {
  const d = (ax: number, ay: number, bx: number, by: number) => (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  const d1 = d(t[k]!, t[k + 1]!, t[k + 2]!, t[k + 3]!), d2 = d(t[k + 2]!, t[k + 3]!, t[k + 4]!, t[k + 5]!), d3 = d(t[k + 4]!, t[k + 5]!, t[k]!, t[k + 1]!);
  return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
}

/** Setup-pose orientation of a mesh, on a skeleton at its setup pose (no deform keys applied). */
function setupMesh(base: spine.Skeleton, slotIndex: number, att: spine.MeshAttachment): Omit<Mesh, "slot"> {
  const setup = crosses(world(base, base.slots[slotIndex]!, att), att.triangles as unknown as number[]);
  const mean = setup.reduce((s, c) => s + Math.abs(c), 0) / Math.max(1, setup.length), min = Math.max(0.01, SLIVER * mean);
  return { att, setup, min, area: setup.reduce((s, c) => s + (Math.abs(c) < min ? 0 : Math.abs(c)), 0) };
}

/**
 * Every skin with a mesh, and the meshes to check in it: each mesh in the first skin that holds it. Copies count once
 * (composite skins such as "full-skins/girl" hold their own copies of the parts): same slot and same geometry. Two
 * skins with different meshes under one placeholder are both checked.
 */
function skinMeshes(data: spine.SkeletonData): { skin: spine.Skin; meshes: Set<spine.Attachment> }[] {
  const seen = new Set<string>();
  return [data.defaultSkin, ...data.skins.filter((s) => s !== data.defaultSkin)].filter((s): s is spine.Skin => !!s).map((skin) => {
    const meshes = new Set<spine.Attachment>();
    for (const e of skin.getAttachments()) {
      const a = e.attachment;
      if (!(a instanceof spine.MeshAttachment)) continue;
      const id = `${e.slotIndex}|${a.bones?.join(",") ?? ""}|${a.vertices.join(",")}|${a.triangles.join(",")}`;
      if (!seen.has(id)) { seen.add(id); meshes.add(a); }
    }
    return { skin, meshes };
  }).filter((s) => s.meshes.size);
}

/**
 * Meshes that fold while an animation plays: sampled at fps over each skin that has meshes (default skin first), every
 * visible mesh compared triangle by triangle with its setup orientation. The worst frame per attachment.
 */
export function animationFolds(data: spine.SkeletonData, anim: spine.Animation, fps = 30): MeshFold[] {
  const skins = skinMeshes(data);
  const worst = new Map<string, MeshFold>();
  const sk = new spine.Skeleton(data);
  const n = Math.max(1, Math.round(anim.duration * fps));
  for (const { skin, meshes } of skins) {
    sk.setSkin(skin);
    // The setup reference under the same skin: skin bones and constraints are inactive without it.
    const base = new spine.Skeleton(data);
    base.setSkin(skin);
    base.setupPose();
    base.updateWorldTransform(spine.Physics.none);
    const cache = new Map<spine.MeshAttachment, Omit<Mesh, "slot">>();
    for (let f = 0; f <= n; f++) {
      const t = (anim.duration * f) / n;
      sk.setupPose();
      anim.apply(sk, t, t, false, null, 1, spine.MixFrom.setup, false, false, false);
      sk.updateWorldTransform(spine.Physics.none);
      sk.slots.forEach((slot, i) => {
        const att = slot.appliedPose.getAttachment();
        if (!(att instanceof spine.MeshAttachment) || !meshes.has(att) || slot.appliedPose.color.a < 0.01 || !slot.bone.active) return;
        if (!cache.has(att)) cache.set(att, setupMesh(base, i, att));
        const m = { slot, ...cache.get(att)! };
        const v = world(sk, slot, att), tris = att.triangles as unknown as number[];
        const r = turned(m, crosses(v, tris));
        if (!r?.triangles) return;
        const key = `${skin.name}/${slot.data.name}/${att.name}`, areaPercent = +(100 * r.area / m.area).toFixed(1);
        // Hidden when each turned triangle's centre lies under a later attachment (its transparent parts count too).
        const over = drawnAfter(sk, slot);
        const covered = r.which.every((i) => {
          const a = tris[i * 3]! * 2, b = tris[i * 3 + 1]! * 2, c = tris[i * 3 + 2]! * 2, x = (v[a]! + v[b]! + v[c]!) / 3, y = (v[a + 1]! + v[b + 1]! + v[c + 1]!) / 3;
          for (let k = 0; k < over.length; k += 6) if (inside(x, y, over, k)) return true;
          return false;
        });
        const prev = worst.get(key);
        // The worst frame: a visible fold before a hidden one, then the larger.
        if (!prev || (prev.covered && !covered) || (prev.covered === covered && areaPercent > prev.areaPercent)) worst.set(key, { skin: skin.name, slot: slot.data.name, attachment: att.name, triangles: r.triangles, of: r.of, areaPercent, time: +t.toFixed(3), covered });
      });
    }
  }
  return [...worst.values()].sort((a, b) => Number(a.covered) - Number(b.covered) || b.areaPercent - a.areaPercent);
}

/**
 * Weight stress test on the setup pose: each bone that weights a visible mesh (IK-driven bones left to their
 * constraint) turned 15, 30, 45, 60 and 90 degrees both ways; the smallest turn that folds a mesh. Blended weights
 * at a joint fold only at large angles; a vertex weighted to the wrong side or a hard step in the weights folds early.
 */
type StressEntry = Mesh & { sk: spine.Skeleton; bones: Set<number> };

/**
 * The weighted meshes shown in the setup pose of each skin, each on a skeleton wearing that skin (skin bones are
 * inactive without it), and the bones a stress test turns: every weighting bone except the root and IK-driven ones,
 * each with the meshes it moves (weighted to it or to a bone below it).
 */
function stressSetup(data: spine.SkeletonData, withAncestors = false): { entries: StressEntry[]; turns: { boneIndex: number; bd: spine.BoneData; affected: StressEntry[] }[] } {
  const entries: StressEntry[] = [];
  for (const { skin, meshes } of skinMeshes(data)) {
    const sk = new spine.Skeleton(data);
    sk.setSkin(skin);
    sk.setupPose();
    sk.updateWorldTransform(spine.Physics.none);
    sk.slots.forEach((slot, i) => {
      const att = slot.pose.getAttachment();
      if (!(att instanceof spine.MeshAttachment) || !att.bones || !meshes.has(att)) return;
      const bones = new Set<number>();
      for (let k = 0; k < att.bones.length; k += att.bones[k]! + 1) for (let j = 1; j <= att.bones[k]!; j++) bones.add(att.bones[k + j]!);
      entries.push({ slot, ...setupMesh(sk, i, att), sk, bones });
    });
  }
  const ik = new Set(data.constraints.filter((c): c is spine.IkConstraintData => c instanceof spine.IkConstraintData).flatMap((c) => c.bones.map((b) => b.index)));
  const weighting = new Set(entries.flatMap((e) => [...e.bones]));
  // A joint added between weighted bones may weight nothing itself (its vertices left on the parent): it still turns
  // the meshes below it.
  if (withAncestors) for (const b of [...weighting]) for (let p = data.bones[b]!.parent; p; p = p.parent) weighting.add(p.index);
  const turns = [...weighting].flatMap((boneIndex) => {
    const bd = data.bones[boneIndex]!;
    if (!bd.parent || ik.has(boneIndex)) return [];
    return [{ boneIndex, bd, affected: entries.filter((e) => [...e.bones].some((b) => b === boneIndex || isUnder(data.bones[b]!, bd))) }];
  });
  return { entries, turns };
}

/** Turns one bone of every skeleton in `entries` by `degrees` from the setup pose (0 = back to setup). */
function turnBone(entries: StressEntry[], boneIndex: number, degrees: number) {
  for (const sk of new Set(entries.map((e) => e.sk))) {
    sk.setupPose();
    sk.bones[boneIndex]!.pose.rotation += degrees;
    sk.updateWorldTransform(spine.Physics.none);
  }
}

export function stressFolds(data: spine.SkeletonData, angles = STRESS_ANGLES): StressFold[] {
  const out: StressFold[] = [];
  for (const { boneIndex, bd, affected } of stressSetup(data).turns) {
    for (const deg of angles) {
      const hits = new Map<StressEntry, { triangles: number; areaPercent: number }>();
      for (const dir of [1, -1]) {
        turnBone(affected, boneIndex, dir * deg);
        for (const e of affected) {
          const r = turned(e, crosses(world(e.sk, e.slot, e.att), e.att.triangles as unknown as number[]));
          const areaPercent = r ? +(100 * r.area / e.area).toFixed(1) : 0;
          if (r?.triangles && areaPercent >= STRESS_AREA && areaPercent > (hits.get(e)?.areaPercent ?? 0)) hits.set(e, { triangles: r.triangles, areaPercent });
        }
      }
      if (hits.size) {
        out.push({ bone: bd.name, degrees: deg, attachments: [...hits].map(([e, h]) => ({ slot: e.slot.data.name, attachment: e.att.name, ...h })) });
        break;
      }
    }
  }
  return out.sort((a, b) => a.degrees - b.degrees || b.attachments.length - a.attachments.length);
}

/** A bone whose small turn stretches a mesh it moves: the mesh bends somewhere else than at the bone's pivot. */
export interface StressStretch {
  bone: string;
  degrees: number;
  attachments: {
    slot: string;
    attachment: string;
    /** Largest change of a triangle edge's length, in percent, either way of the turn. */
    stretchPercent: number;
    /** Vertices along the bone past its pivot zone (it is the mesh's nearest bone there) with no weight on it or below it. */
    along: number;
    /** The bones those vertices are weighted to instead. */
    alongBones: string[];
  }[];
}

export const STRETCH_DEGREES = 10;
// Percent edge length change at STRETCH_DEGREES. A joint blended around its pivot stays well under it (a 10 degree
// elbow bend: ~6-9%); a bend that happens a ring or more away from the pivot (the vertices along the bone left on the
// parent) goes past it.
const STRETCH_REPORT = 15;
const FOLLOWS = 0.05; // weight on the turned bone or below it under which a vertex counts as not following it
const PIVOT_ZONE = 0.35; // share of a bone's length from its pivot where vertices may still blend with the parent

/**
 * Weight stretch test on the setup pose: each weighting bone turned a little (10 degrees both ways), every mesh it
 * moves measured edge by edge against the setup pose. Folds need big turns; this finds the joints that already look
 * rubbery at the angles idles use, and names the vertices that cause it: those along the bone that only follow its
 * parent, so the bend happens at the next ring of weights instead of at the pivot.
 */
export function stressStretch(data: spine.SkeletonData, degrees = STRETCH_DEGREES, reportPercent = STRETCH_REPORT): StressStretch[] {
  const { turns } = stressSetup(data, true);
  const out: StressStretch[] = [];
  for (const { boneIndex, bd, affected } of turns) {
    turnBone(affected, boneIndex, 0);
    const setup = new Map(affected.map((e) => [e, world(e.sk, e.slot, e.att)]));
    // Bones that move with the turned one: its children and whatever constraints drive from it (a twist helper parented
    // elsewhere). A vertex weighted to them follows the turn.
    const pose = (sk: spine.Skeleton) => sk.bones.map((b) => [b.appliedPose.worldX, b.appliedPose.worldY, b.appliedPose.getWorldRotationX()]);
    const before = new Map([...new Set(affected.map((e) => e.sk))].map((sk) => [sk, pose(sk)]));
    turnBone(affected, boneIndex, degrees);
    const moved = new Map([...before].map(([sk, b0]) => [sk, new Set(pose(sk).flatMap((p, i) => (Math.hypot(p[0]! - b0[i]![0]!, p[1]! - b0[i]![1]!) > 1e-3 || Math.abs(p[2]! - b0[i]![2]!) > 1e-3 ? [i] : [])))]));
    const edges = new Map(affected.map((e) => [e, meshEdges(e.att.triangles as unknown as number[])]));
    const worst = new Map<StressEntry, number>();
    for (const dir of [1, -1]) {
      turnBone(affected, boneIndex, dir * degrees);
      for (const e of affected) {
        const s = setup.get(e)!, now = world(e.sk, e.slot, e.att);
        let w = worst.get(e) ?? 0;
        for (const [a, b] of edges.get(e)!) {
          const l0 = Math.hypot(s[b * 2]! - s[a * 2]!, s[b * 2 + 1]! - s[a * 2 + 1]!);
          if (l0 < 0.5) continue;
          w = Math.max(w, Math.abs(Math.hypot(now[b * 2]! - now[a * 2]!, now[b * 2 + 1]! - now[a * 2 + 1]!) / l0 - 1));
        }
        worst.set(e, w);
      }
    }
    turnBone(affected, boneIndex, 0);
    // Only the actionable case: a big part turned 10 degrees stretches any single painted mesh around it (a head on
    // its body), so a stretch counts when vertices along the bone explain it.
    const hits = affected.filter((e) => 100 * worst.get(e)! >= reportPercent).map((e) => {
      const { along, alongBones } = alongVertices(data, e, boneIndex, setup.get(e)!, moved.get(e.sk)!);
      return { slot: e.slot.data.name, attachment: e.att.name, stretchPercent: +(100 * worst.get(e)!).toFixed(1), along, alongBones };
    }).filter((h) => h.along > 0);
    if (hits.length) out.push({ bone: bd.name, degrees, attachments: hits.sort((a, b) => b.stretchPercent - a.stretchPercent) });
  }
  return out.sort((a, b) => b.attachments[0]!.stretchPercent - a.attachments[0]!.stretchPercent);
}

function meshEdges(tris: number[]): [number, number][] {
  const seen = new Set<string>(), out: [number, number][] = [];
  for (let i = 0; i < tris.length; i += 3) {
    for (const [a, b] of [[tris[i]!, tris[i + 1]!], [tris[i + 1]!, tris[i + 2]!], [tris[i + 2]!, tris[i]!]] as [number, number][]) {
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      if (!seen.has(k)) { seen.add(k); out.push([a, b]); }
    }
  }
  return out;
}

/**
 * Vertices of a mesh that lie along `boneIndex` (its segment, from the pivot over its length, is the nearest of the
 * mesh's weighting bones) but carry (almost) no weight on it or a bone below it. The skeleton is at its setup pose.
 */
function alongVertices(data: spine.SkeletonData, e: StressEntry, boneIndex: number, setup: number[], moved: Set<number>): { along: number; alongBones: string[] } {
  const turned = data.bones[boneIndex]!;
  const segs = [...new Set([...e.bones, boneIndex])].map((b) => {
    const p = e.sk.bones[b]!.appliedPose, len = data.bones[b]!.length;
    return { b, x: p.worldX, y: p.worldY, dx: p.a * len, dy: p.c * len };
  });
  const along01 = (s: (typeof segs)[number], x: number, y: number) => {
    const l2 = s.dx * s.dx + s.dy * s.dy;
    return l2 > 0 ? Math.max(0, Math.min(1, ((x - s.x) * s.dx + (y - s.y) * s.dy) / l2)) : 0;
  };
  const dist = (s: (typeof segs)[number], x: number, y: number) => {
    const t = along01(s, x, y);
    return Math.hypot(x - s.x - t * s.dx, y - s.y - t * s.dy);
  };
  const bones = e.att.bones!, v = e.att.vertices;
  let along = 0;
  const others = new Set<string>();
  for (let i = 0, w = 0, n = 0; i < bones.length; n++) {
    const count = bones[i++]!;
    let follow = 0;
    const by: number[] = [];
    for (let j = 0; j < count; j++, i++, w += 3) {
      const b = bones[i]!;
      by.push(b);
      if (b === boneIndex || moved.has(b)) follow += v[w + 2]!;
    }
    if (follow >= FOLLOWS) continue;
    const x = setup[n * 2]!, y = setup[n * 2 + 1]!;
    const nearest = segs.reduce((m, s) => (dist(s, x, y) < dist(m, x, y) ? s : m));
    // Around the pivot a blend with the parent is the joint itself: only vertices past PIVOT_ZONE of the length count.
    if (nearest.b !== boneIndex || turned.length <= 0 || along01(nearest, x, y) < PIVOT_ZONE) continue;
    along++;
    for (const b of by) others.add(data.bones[b]!.name);
  }
  return { along, alongBones: [...others] };
}

function isUnder(b: spine.BoneData, ancestor: spine.BoneData): boolean {
  for (let p: spine.BoneData | null = b.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

const FOLD_WARN = 5, FOLD_MIN = 1; // percent of the mesh's area: a visible fold warns, smaller or hidden ones are listed

/** spine_validate issues for one animation: a warning per visible fold, the small and hidden ones in one info. */
export function foldIssues(data: spine.SkeletonData, anim: spine.Animation, fps = 30): { severity: "warning" | "info"; code: string; message: string }[] {
  const folds = animationFolds(data, anim, fps).filter((f) => f.areaPercent >= FOLD_MIN);
  const name = (f: MeshFold) => `${f.slot}/${f.attachment}${f.skin === "default" ? "" : ` (skin ${f.skin})`}`;
  const out: { severity: "warning" | "info"; code: string; message: string }[] = [];
  for (const f of folds.filter((x) => !x.covered && x.areaPercent >= FOLD_WARN)) {
    out.push({ severity: "warning", code: "mesh-fold", message: `"${anim.name}": mesh ${name(f)} folds over itself at ${f.time}s: ${f.triangles} of ${f.of} triangles turn over (${f.areaPercent}% of its area), so the image is drawn mirrored there. Weights or deform keys pull those vertices past their neighbours: smooth the weights across the joint, or ease the bend.` });
  }
  const minor = folds.filter((x) => x.covered || x.areaPercent < FOLD_WARN);
  if (minor.length) out.push({ severity: "info", code: "mesh-fold-minor", message: `"${anim.name}": small or hidden mesh folds: ${minor.slice(0, 6).map((f) => `${name(f)} ${f.areaPercent}% at ${f.time}s${f.covered ? " (under a part drawn later)" : ""}`).join(", ")}${minor.length > 6 ? ", ..." : ""}.` });
  return out;
}
