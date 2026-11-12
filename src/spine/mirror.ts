import { loadSkeletonData, spine } from "./runtime.js";
import type { AnimationJson, Key, SkeletonJson, TimelineMap } from "./types.js";

/** Name tokens that identify the two sides of a rig. Mirror uses left/right only; swap also uses front/back/rear. */
const MIRROR_TOKENS: [string, string][] = [["left", "right"], ["l", "r"]];
const SWAP_TOKENS: [string, string][] = [...MIRROR_TOKENS, ["front", "back"], ["front", "rear"]];
const SIDE_SUFFIXES = ["back", "rear"];

/** The other side's name by swapping one side token (keeps the token's case), or null. */
function swapToken(name: string, tokens: [string, string][]): string[] {
  const parts = name.split(/([-_ .])/);
  const out: string[] = [];
  parts.forEach((p, i) => {
    if (i % 2 === 1) return;
    for (const [a, b] of tokens) {
      const lower = p.toLowerCase();
      const other = lower === a ? b : lower === b ? a : null;
      if (!other) continue;
      const cased = p === p.toUpperCase() ? other.toUpperCase() : p[0] === p[0]!.toUpperCase() ? other[0]!.toUpperCase() + other.slice(1) : other;
      out.push([...parts.slice(0, i), cased, ...parts.slice(i + 1)].join(""));
    }
  });
  return out;
}

/** Names the other side of `name` could have: swapped side tokens, plus -back/-rear suffixes for swap. */
function sideVariants(name: string, mode: "mirror" | "swap"): string[] {
  const out = swapToken(name, mode === "mirror" ? MIRROR_TOKENS : SWAP_TOKENS);
  if (mode === "swap") {
    for (const s of SIDE_SUFFIXES) {
      out.push(`${name}-${s}`, `${name}_${s}`);
      for (const sep of ["-", "_"]) if (name.endsWith(`${sep}${s}`)) out.push(name.slice(0, -(s.length + 1)));
    }
  }
  return out;
}

/** Pairs found from names (each name appears in at most one pair). */
export function autoPairs(names: string[], mode: "mirror" | "swap"): [string, string][] {
  const set = new Set(names);
  const taken = new Set<string>();
  const pairs: [string, string][] = [];
  for (const n of names) {
    if (taken.has(n)) continue;
    const partner = sideVariants(n, mode).find((c) => c !== n && set.has(c) && !taken.has(c));
    if (partner) {
      pairs.push([n, partner]);
      taken.add(n).add(partner);
    }
  }
  return pairs;
}

function partnerMap(pairs: [string, string][]): Map<string, string> {
  const m = new Map<string, string>();
  for (const [a, b] of pairs) {
    if (m.has(a) || m.has(b)) throw new Error(`"${m.has(a) ? a : b}" appears in more than one pair`);
    m.set(a, b).set(b, a);
  }
  return m;
}

const CONSTRAINT_SECTIONS = ["ik", "transform", "path", "physics", "slider"] as const;
type ConstraintSection = (typeof CONSTRAINT_SECTIONS)[number];

/** Partners per name space: a pair only applies where both names exist (a bone pair never renames a slot). */
export interface Partners {
  bones: Map<string, string>;
  slots: Map<string, string>;
  constraints: Record<ConstraintSection, Map<string, string>>;
  notes: string[];
}

function resolvePartners(anim: AnimationJson, skeleton: SkeletonJson | undefined, pairs: [string, string][] | undefined, mode: "mirror" | "swap"): Partners {
  if (pairs) partnerMap(pairs); // reject a name used twice
  const spaces: Record<string, string[]> = {
    bones: skeleton ? (skeleton.bones ?? []).map((b) => b.name) : Object.keys(anim.bones ?? {}),
    slots: skeleton ? (skeleton.slots ?? []).map((s) => s.name) : Object.keys(anim.slots ?? {}),
  };
  for (const c of CONSTRAINT_SECTIONS) {
    spaces[c] = skeleton ? (skeleton.constraints ?? []).filter((k) => k.type === c).map((k) => k.name) : Object.keys(anim[c] ?? {});
  }
  const maps: Record<string, Map<string, string>> = {};
  const used: [string, string][] = [];
  for (const [space, names] of Object.entries(spaces)) {
    const set = new Set(names);
    const found = pairs ? pairs.filter(([a, b]) => set.has(a) && set.has(b)) : autoPairs(names, mode);
    maps[space] = partnerMap(found);
    for (const p of found) if (!used.some(([a, b]) => a === p[0] && b === p[1])) used.push(p);
  }
  const notes = [used.length ? `pairs: ${used.map(([a, b]) => `${a}<->${b}`).join(", ")}` : "no pairs found (nothing swapped)"];
  if (mode === "mirror" && !pairs && !used.length) {
    // Front/back names are left/right on a character drawn facing the camera but stay apart on a side view, so they
    // are never paired by default: say so, or every bone is mirrored in place without a word (an arm across the face).
    const sides = autoPairs(spaces.bones!, "swap");
    if (sides.length) notes.push(`no left/right names, but front/back pairs exist: ${sides.map(([a, b]) => `${a}<->${b}`).join(", ")}. Each bone was mirrored in place, which suits a side view; for a character drawn facing the camera pass them as pairs (e.g. [${sides.slice(0, 2).map(([a, b]) => `["${a}", "${b}"]`).join(", ")}]).`);
  }
  if (pairs) {
    const unused = pairs.filter((p) => !used.some(([a, b]) => a === p[0] && b === p[1]));
    if (unused.length) notes.push(`ignored (not both bones, slots or constraints of one type): ${unused.map(([a, b]) => `${a}<->${b}`).join(", ")}`);
  }
  return {
    bones: maps.bones!, slots: maps.slots!, notes,
    constraints: Object.fromEntries(CONSTRAINT_SECTIONS.map((c) => [c, maps[c]!])) as Record<ConstraintSection, Map<string, string>>,
  };
}

const renameKeys = <T>(map: Record<string, T> | undefined, partner: Map<string, string>) =>
  map && Object.fromEntries(Object.entries(map).map(([k, v]) => [partner.get(k) ?? k, v]));

/**
 * The attachment a key names once it moves from `fromSlot` to `toSlot`: the same name if the target slot has it, else
 * the name with the slot name or a side token swapped (e.g. "upper-arm" -> "upper-arm-back"); null if none exists.
 */
function mapAttachmentName(name: string, fromSlot: string, toSlot: string, skeleton: SkeletonJson | undefined, mode: "mirror" | "swap", skin?: string): string | null {
  if (!skeleton) return name;
  const exists = (n: string) => (skeleton.skins ?? []).some((s) => (skin === undefined || s.name === skin) && s.attachments?.[toSlot]?.[n]);
  if (exists(name)) return name;
  const candidates = [...(fromSlot.length >= 3 && name.includes(fromSlot) ? [name.split(fromSlot).join(toSlot)] : []), ...sideVariants(name, mode)];
  return candidates.find(exists) ?? null;
}

/** Vertex count of a mesh or linked mesh (deform keys need the same count on both sides), else null. */
export function meshVertexCount(skeleton: SkeletonJson, skin: string, slot: string, att: string, depth = 0): number | null {
  const a = (skeleton.skins ?? []).find((s) => s.name === skin)?.attachments?.[slot]?.[att];
  if (!a || depth > 4) return null;
  if (a.type === "mesh") return (a.uvs?.length ?? 0) / 2;
  if (a.type === "linkedmesh") return meshVertexCount(skeleton, (a.skin as string | undefined) ?? "default", (a.slot as string | undefined) ?? slot, a.source as string, depth + 1);
  return null;
}

/**
 * Drops slot pairs whose keyed attachments have no counterpart on the other side (asymmetric rigs, e.g. a gun only in
 * the front hand): swapping them would key attachments the partner slot does not have.
 */
function checkSlotPairs(anim: AnimationJson, skeleton: SkeletonJson | undefined, slots: Map<string, string>, mode: "mirror" | "swap", notes: string[]) {
  if (!skeleton) return;
  const problem = (from: string, to: string): string | null => {
    for (const k of anim.slots?.[from]?.attachment ?? []) {
      if (k.name && mapAttachmentName(k.name, from, to, skeleton, mode) === null) return `attachment "${k.name}" has no counterpart in "${to}"`;
    }
    for (const [skin, bySlot] of Object.entries(anim.attachments ?? {})) {
      for (const [att, timelines] of Object.entries(bySlot[from] ?? {})) {
        const target = mapAttachmentName(att, from, to, skeleton, mode, skin);
        if (target === null) return `attachment "${att}" (skin ${skin}) has no counterpart in "${to}"`;
        if (timelines.deform && meshVertexCount(skeleton, skin, from, att) !== meshVertexCount(skeleton, skin, to, target)) {
          return `deform of "${att}" does not fit "${target}" in "${to}" (different mesh)`;
        }
      }
    }
    return null;
  };
  for (const [a, b] of [...slots]) {
    if (a > b || !slots.has(a)) continue;
    const why = problem(a, b) ?? problem(b, a);
    if (why) {
      slots.delete(a);
      slots.delete(b);
      notes.push(`slots ${a}<->${b} not swapped: ${why}`);
    }
  }
}

/** Draw order as a list of names from Spine's offsets (offsets are relative to `base`, sorted by base index). */
export function decodeDrawOrder(base: string[], offsets: { slot: string; offset: number }[]): string[] | null {
  const order = new Array<string | undefined>(base.length).fill(undefined);
  const placed = new Set<string>();
  for (const o of offsets) {
    const i = base.indexOf(o.slot), p = i + o.offset;
    if (i < 0 || p < 0 || p >= base.length || order[p] !== undefined) return null;
    order[p] = o.slot;
    placed.add(o.slot);
  }
  const rest = base.filter((n) => !placed.has(n));
  let r = 0;
  for (let p = 0; p < order.length; p++) if (order[p] === undefined) order[p] = rest[r++];
  return order as string[];
}

export function encodeDrawOrder(base: string[], order: string[]): { slot: string; offset: number }[] {
  // Like Spine: list only the slots that moved. The slots that stay unlisted must keep their relative order, so the
  // fewest listed slots are the complement of a longest increasing subsequence of base indices in draw order.
  const idx = order.map((n) => base.indexOf(n));
  const tails: number[] = [], prev = new Array<number>(idx.length).fill(-1);
  idx.forEach((v, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (idx[tails[mid]!]! < v) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  });
  const stay = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) stay.add(idx[i]!);
  return base.flatMap((n, i) => (stay.has(i) ? [] : [{ slot: n, offset: order.indexOf(n) - i }]));
}

/** Partner slots take each other's draw position (offsets re-encoded, so Spine and the runtimes read them back). */
function swapDrawOrderKeys(keys: Key[] | undefined, base: string[], slots: Map<string, string>, notes: string[]) {
  const inBase = new Set(base);
  for (const k of keys ?? []) {
    const offsets = k.offsets as { slot: string; offset: number }[] | undefined;
    if (!offsets) continue;
    const order = decodeDrawOrder(base, offsets);
    if (!order) {
      notes.push(`draw order key at ${k.time ?? 0}s could not be decoded; left unchanged`);
      continue;
    }
    const swapped = order.map((n) => (slots.has(n) && inBase.has(slots.get(n)!) ? slots.get(n)! : n));
    k.offsets = encodeDrawOrder(base, swapped);
  }
}

export interface PairResult {
  animation: AnimationJson;
  notes: string[];
}

interface SwapResult extends PairResult {
  partners: Partners;
}

/**
 * Exchanges the timelines of paired bones, slots and constraints (values unchanged). Attachment keys are renamed to the
 * target slot's counterpart; slot pairs without counterparts stay in place. Draw order keys swap the pair's positions.
 */
function swapWithPartners(source: AnimationJson, skeleton: SkeletonJson | undefined, pairs: [string, string][] | undefined, mode: "mirror" | "swap"): SwapResult {
  const partners = resolvePartners(source, skeleton, pairs, mode);
  const notes = [...partners.notes];
  checkSlotPairs(source, skeleton, partners.slots, mode, notes);
  const anim: AnimationJson = structuredClone(source);
  anim.bones = renameKeys(anim.bones, partners.bones);
  if (anim.slots) {
    anim.slots = renameKeys(anim.slots, partners.slots)!;
    for (const [slot, timelines] of Object.entries(anim.slots)) {
      if (!partners.slots.has(slot)) continue;
      for (const k of timelines.attachment ?? []) if (k.name) k.name = mapAttachmentName(k.name, partners.slots.get(slot)!, slot, skeleton, mode) ?? k.name;
    }
  }
  for (const section of CONSTRAINT_SECTIONS) {
    if (anim[section]) (anim as Record<string, unknown>)[section] = renameKeys(anim[section] as Record<string, unknown>, partners.constraints[section]);
  }
  if (anim.attachments) {
    for (const skin of Object.keys(anim.attachments)) {
      const bySlot = renameKeys(anim.attachments[skin], partners.slots)!;
      for (const [slot, atts] of Object.entries(bySlot)) {
        if (!partners.slots.has(slot)) continue;
        bySlot[slot] = Object.fromEntries(Object.entries(atts).map(([att, tl]) => [mapAttachmentName(att, partners.slots.get(slot)!, slot, skeleton, mode, skin) ?? att, tl]));
      }
      anim.attachments[skin] = bySlot;
    }
  }
  if (partners.slots.size) {
    if (skeleton) {
      swapDrawOrderKeys(anim.drawOrder, (skeleton.slots ?? []).map((s) => s.name), partners.slots, notes);
      for (const folder of anim.drawOrderFolder ?? []) swapDrawOrderKeys(folder.keys, folder.slots ?? [], partners.slots, notes);
    } else if (anim.drawOrder?.length || anim.drawOrderFolder?.length) notes.push("draw order keys left unchanged (no skeleton to decode them)");
  }
  return { animation: anim, notes, partners };
}

export function swapAnimation(source: AnimationJson, skeleton: SkeletonJson | undefined, pairs?: [string, string][], mode: "mirror" | "swap" = "swap"): PairResult {
  const { animation, notes } = swapWithPartners(source, skeleton, pairs, mode);
  return { animation, notes };
}

type M2 = [number, number, number, number]; // [a, b, c, d] = [[a, b], [c, d]]
const mul = (x: M2, y: M2): M2 => [x[0] * y[0] + x[1] * y[2], x[0] * y[1] + x[1] * y[3], x[2] * y[0] + x[3] * y[2], x[2] * y[1] + x[3] * y[3]];
const inv = (x: M2): M2 => {
  const det = x[0] * x[3] - x[1] * x[2];
  return [x[3] / det, -x[1] / det, -x[2] / det, x[0] / det];
};
const MIRROR_X: M2 = [-1, 0, 0, 1];

/** Setup-pose world matrix of each bone's parent (identity for the root), i.e. the frame its translate keys live in. */
function parentFrames(skeleton: SkeletonJson): Map<string, M2> {
  const data = loadSkeletonData(skeleton);
  const sk = new spine.Skeleton(data);
  sk.setupPose();
  sk.updateWorldTransform(spine.Physics.none);
  const frames = new Map<string, M2>();
  for (const b of sk.bones) {
    const p = b.parent?.appliedPose;
    frames.set(b.data.name, p ? [p.a, p.b, p.c, p.d] : [1, 0, 0, 1]);
  }
  return frames;
}

/**
 * Horizontal mirror (character's left <-> right): paired bones exchange timelines and every bone's keys are mirrored in
 * world space. A source bone's keys land on its partner through T = P'^-1 * M * P, where P and P' are the setup world
 * frames of the two bones' parents and M flips world X. Rotation and shear flip sign with det(T); translate keys go
 * through T (exact when T is axis-aligned, otherwise approximated and noted). IK bend directions invert.
 */
export function mirrorAnimation(source: AnimationJson, skeleton: SkeletonJson, pairs?: [string, string][]): PairResult {
  const swapped = swapWithPartners(source, skeleton, pairs, "mirror");
  const partner = swapped.partners.bones;
  const anim = swapped.animation;
  const notes = [...swapped.notes];
  const frames = parentFrames(skeleton);
  let approximated = 0;

  for (const [target, timelines] of Object.entries(anim.bones ?? {})) {
    const from = partner.get(target) ?? target;
    const P = frames.get(from), Pt = frames.get(target);
    if (!P || !Pt) {
      notes.push(`bone "${from}" or "${target}" not in the skeleton; keys copied unmirrored`);
      continue;
    }
    const T = mul(inv(Pt), mul(MIRROR_X, P));
    const s = Math.sign(T[0] * T[3] - T[1] * T[2]) || 1;
    const scale = Math.hypot(T[0], T[2]) || 1;
    const axisAligned = Math.abs(T[1]) + Math.abs(T[2]) < 1e-6 * scale;
    const swapsAxes = Math.abs(T[0]) + Math.abs(T[3]) < 1e-6 * scale;
    const out: TimelineMap = {};
    for (const [prop, keys] of Object.entries(timelines)) {
      if (prop === "rotate" || prop === "shearx" || prop === "sheary") out[prop] = signKeys(keys, ["value"], s);
      else if (prop === "shear") out[prop] = signKeys(keys, ["x", "y"], s);
      else if (prop === "translate") {
        if (!axisAligned && !swapsAxes) approximated++;
        out[prop] = keys.map((k) => transformTranslate(k, T, axisAligned, swapsAxes));
      } else if (prop === "translatex" || prop === "translatey") {
        const isX = prop === "translatex";
        if (axisAligned) out[prop] = scaleSingle(keys, isX ? T[0] : T[3]);
        else if (swapsAxes) out[isX ? "translatey" : "translatex"] = scaleSingle(keys, isX ? T[2] : T[1]);
        else {
          approximated++;
          out[prop] = scaleSingle(keys, isX ? T[0] : T[3]);
        }
      } else out[prop] = keys; // scale, inherit: unchanged by a mirror
    }
    anim.bones![target] = out;
  }
  for (const keys of Object.values(anim.ik ?? {})) for (const k of keys) k.bendPositive = !((k.bendPositive as boolean | undefined) ?? true);
  if (approximated) notes.push(`${approximated} translate timeline(s) under a rotated parent frame were mirrored approximately (curves combined linearly)`);
  mirrorDeforms(source, anim, skeleton, swapped.partners.slots, partner, notes);
  return { animation: anim, notes };
}

/** World positions (setup pose) and per-vertex offset frames of a mesh attachment, from spine-core. */
interface MeshFrame {
  world: number[];
  /** Per vertex: the 2x2 bone matrices and weights its offsets go through (one entry for unweighted meshes). */
  entries: { m: M2; w: number; bone: string }[][];
  /** Number of deform values (2 per vertex unweighted, 2 per weight entry weighted). */
  deformLength: number;
}

function meshFrame(sk: spine.Skeleton, skin: string, slotName: string, attName: string): MeshFrame | null {
  const slot = sk.findSlot(slotName);
  const att = slot && sk.data.findSkin(skin)?.getAttachment(slot.data.index, attName);
  if (!slot || !(att instanceof spine.VertexAttachment)) return null;
  const world = new Array<number>(att.worldVerticesLength).fill(0);
  att.computeWorldVertices(sk, slot, 0, att.worldVerticesLength, world, 0, 2);
  const count = att.worldVerticesLength / 2;
  const entries: { m: M2; w: number; bone: string }[][] = [];
  const matrix = (b: spine.Bone): M2 => { const p = b.appliedPose; return [p.a, p.b, p.c, p.d]; };
  if (!att.bones) {
    const m = matrix(slot.bone);
    for (let i = 0; i < count; i++) entries.push([{ m, w: 1, bone: slot.bone.data.name }]);
    return { world, entries, deformLength: att.vertices.length };
  }
  let entry = 0;
  for (let i = 0, b = 0; i < count; i++) {
    const n = att.bones[b++]!;
    const list: { m: M2; w: number; bone: string }[] = [];
    for (let k = 0; k < n; k++, b++, entry++) {
      const bone = sk.bones[att.bones[b]!]!;
      list.push({ m: matrix(bone), w: att.vertices[entry * 3 + 2]!, bone: bone.data.name });
    }
    entries.push(list);
  }
  return { world, entries, deformLength: entry * 2 };
}

/**
 * Vertex correspondence target -> source under a mirror about x = x0: every target vertex must sit on a mirrored source
 * vertex (within 1% of the mesh size), one to one. Null when the meshes are not mirror images.
 */
function mirrorCorrespondence(src: number[], dst: number[], sameMesh: boolean): number[] | null {
  if (src.length !== dst.length) return null;
  const n = src.length / 2;
  const mean = (v: number[]) => v.reduce((a, x, i) => (i % 2 === 0 ? a + x : a), 0) / n;
  const x0 = sameMesh ? mean(src) : (mean(src) + mean(dst)) / 2;
  const xs = src.filter((_, i) => i % 2 === 0), ys = src.filter((_, i) => i % 2 === 1);
  const size = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const tol = Math.max(0.5, size * 0.01);
  const used = new Set<number>();
  const out: number[] = [];
  for (let j = 0; j < n; j++) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(2 * x0 - src[i * 2]! - dst[j * 2]!, src[i * 2 + 1]! - dst[j * 2 + 1]!);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (bestD > tol || used.has(best)) return null;
    used.add(best);
    out.push(best);
  }
  return out;
}

/**
 * Mirrors deform keys: each source vertex offset is taken to world space at the setup pose, flipped in X and expressed
 * in the frame of its mirror vertex (per weight entry for weighted meshes). Exact over time when the bone mirror is
 * exact. Meshes that are not mirror images keep their offsets and are reported.
 */
function mirrorDeforms(source: AnimationJson, anim: AnimationJson, skeleton: SkeletonJson, slots: Map<string, string>, bones: Map<string, string>, notes: string[]) {
  if (!source.attachments) return;
  const sk = new spine.Skeleton(loadSkeletonData(skeleton));
  sk.setupPose();
  sk.updateWorldTransform(spine.Physics.none);
  let mirrored = 0;
  const skipped: string[] = [], setupOnly: string[] = [];
  for (const [skin, bySlot] of Object.entries(source.attachments)) {
    for (const [from, atts] of Object.entries(bySlot)) {
      const to = slots.get(from) ?? from;
      for (const [att, timelines] of Object.entries(atts)) {
        if (!timelines.deform?.length) continue;
        const target = from === to ? att : mapAttachmentName(att, from, to, skeleton, "mirror", skin) ?? att;
        const a = meshFrame(sk, skin, from, att), b = meshFrame(sk, skin, to, target);
        const corr = a && b && mirrorCorrespondence(a.world, b.world, from === to && att === target);
        if (!a || !b || !corr) {
          skipped.push(`${from}/${att}`);
          continue;
        }
        const exact = entriesMatch(a, b, corr, bones);
        if (!exact) setupOnly.push(`${from}/${att}`);
        anim.attachments![skin]![to]![target]!.deform = timelines.deform.map((k) => mirrorDeformKey(k, a, b, corr, exact));
        mirrored++;
      }
    }
  }
  if (mirrored) notes.push(`${mirrored} deform timeline(s) mirrored vertex by vertex`);
  if (setupOnly.length) notes.push(`deform mirrored exactly at the setup pose only (weights do not pair up across the mirror): ${setupOnly.join(", ")}`);
  if (skipped.length) notes.push(`deform not mirrored (meshes are not mirror images, offsets kept as authored): ${skipped.join(", ")}`);
}

/** For each target weight entry, the source entry on the partner bone with the same weight (null if any is missing). */
function entriesMatch(a: MeshFrame, b: MeshFrame, corr: number[], bones: Map<string, string>): number[][] | null {
  const starts: number[] = [];
  let e = 0;
  for (const list of a.entries) { starts.push(e); e += list.length; }
  const out: number[][] = [];
  for (let j = 0; j < b.entries.length; j++) {
    const i = corr[j]!, src = a.entries[i]!;
    const row: number[] = [];
    for (const t of b.entries[j]!) {
      const k = src.findIndex((s) => (bones.get(s.bone) ?? s.bone) === t.bone && Math.abs(s.w - t.w) < 1e-4);
      if (k < 0) return null;
      row.push(starts[i]! + k);
    }
    out.push(row);
  }
  return out;
}

/**
 * One mirrored deform key. With paired weight entries each entry maps through its own bones
 * (off' = M'^-1 * F * M * off), exact over time; otherwise the vertex's world offset at the setup pose is flipped and
 * spread over the target's entries.
 */
function mirrorDeformKey(k: Key, a: MeshFrame, b: MeshFrame, corr: number[], exact: number[][] | null): Key {
  const src = new Array<number>(a.deformLength).fill(0);
  ((k.vertices as number[] | undefined) ?? []).forEach((v, i) => (src[((k.offset as number | undefined) ?? 0) + i] = v));
  const flat = a.entries.flat();
  const toWorld = (e: number): [number, number] => {
    const { m } = flat[e]!, ox = src[e * 2]!, oy = src[e * 2 + 1]!;
    return [m[0] * ox + m[1] * oy, m[2] * ox + m[3] * oy];
  };
  const out = new Array<number>(b.deformLength).fill(0);
  let e = 0, start = 0;
  const starts = a.entries.map((l) => { const s0 = start; start += l.length; return s0; });
  b.entries.forEach((list, j) => {
    let vertexWorld: [number, number] | null = null;
    list.forEach(({ m }, n) => {
      let wx: number, wy: number;
      if (exact) [wx, wy] = toWorld(exact[j]![n]!);
      else {
        if (!vertexWorld) {
          const i = corr[j]!;
          vertexWorld = a.entries[i]!.reduce<[number, number]>((acc, en, q) => { const [x, y] = toWorld(starts[i]! + q); return [acc[0] + en.w * x, acc[1] + en.w * y]; }, [0, 0]);
        }
        [wx, wy] = vertexWorld;
      }
      const [ia, ib, ic, id] = inv(m);
      out[e * 2] = ia * -wx + ib * wy;
      out[e * 2 + 1] = ic * -wx + id * wy;
      e++;
    });
  });
  const nz = out.map((v, i) => (Math.abs(v) > 1e-9 ? i : -1)).filter((i) => i >= 0);
  const key: Key = { ...k };
  delete key.offset;
  delete key.vertices;
  if (nz.length) {
    const first = nz[0]!, last = nz[nz.length - 1]!;
    if (first) key.offset = first;
    key.vertices = out.slice(first, last + 1);
  }
  return key;
}

function signKeys(keys: Key[], fields: string[], s: number): Key[] {
  return keys.map((k) => {
    const out: Key = { ...k };
    for (const f of fields) if (typeof k[f] === "number") out[f] = (k[f] as number) * s;
    if (Array.isArray(k.curve)) out.curve = k.curve.map((c, i) => (i % 2 === 1 ? c * s : c));
    return out;
  });
}

function scaleSingle(keys: Key[], f: number): Key[] {
  return keys.map((k) => {
    const out: Key = { ...k };
    if (typeof k.value === "number") out.value = k.value * f;
    if (Array.isArray(k.curve)) out.curve = k.curve.map((c, i) => (i % 2 === 1 ? c * f : c));
    return out;
  });
}

/** (x, y) -> T (x, y). Curve channels follow their values: kept per axis, swapped, or combined linearly. */
function transformTranslate(k: Key, T: M2, axisAligned: boolean, swapsAxes: boolean): Key {
  const x = (k.x as number | undefined) ?? 0, y = (k.y as number | undefined) ?? 0;
  const out: Key = { ...k, x: T[0] * x + T[1] * y, y: T[2] * x + T[3] * y };
  if (Array.isArray(k.curve) && k.curve.length === 8) {
    const cx = k.curve.slice(0, 4), cy = k.curve.slice(4, 8);
    const comb = (wx: number, wy: number, timeFrom: number[]) => [timeFrom[0]!, wx * cx[1]! + wy * cy[1]!, timeFrom[2]!, wx * cx[3]! + wy * cy[3]!];
    if (axisAligned) out.curve = [...comb(T[0], 0, cx), ...comb(0, T[3], cy)];
    else if (swapsAxes) out.curve = [...comb(0, T[1], cy), ...comb(T[2], 0, cx)];
    else out.curve = [...comb(T[0], T[1], Math.abs(T[0]) >= Math.abs(T[1]) ? cx : cy), ...comb(T[2], T[3], Math.abs(T[3]) >= Math.abs(T[2]) ? cy : cx)];
  }
  return out;
}
