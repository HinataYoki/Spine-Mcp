import { iterateTimelines } from "./inspect.js";
import { loadSkeletonData, spine } from "./runtime.js";
import { validateSkeleton } from "./validate.js";
import type { AttachmentJson, SkeletonJson } from "./types.js";

export interface DiffItem {
  where: string;
  detail: string;
}

export interface AnimationChange {
  animation: string;
  /** Keys in timelines that existed before, now missing (e.g. attachment keys deleted with their attachment). */
  keysLost: number;
  timelinesRemoved: string[];
  timelinesAdded: string[];
  /** Played before and after with spine-core: largest bone movement, visible attachment and mesh changes. */
  behaviour: {
    maxBoneMove: number;
    worstBone?: string;
    attachmentChanges: string[];
    maxVertexMove: number;
    worstMesh?: string;
  };
}

export interface ReimportDiff {
  /** Things the re-import broke: lost keys, lost weights, meshes turned into regions, invalid deform. */
  broken: DiffItem[];
  /** Things that changed and may be intended: setup poses, image sizes, mesh shape, weights, structure. */
  changed: DiffItem[];
  animations: AnimationChange[];
  counts: { bones: [number, number]; slots: [number, number]; attachments: [number, number]; animations: [number, number] };
  notes: string[];
}

type Weighted = { bones: string[]; weights: number[] }[];

/** Per-vertex influences of a mesh (null when unweighted), with bone names resolved. */
function influences(a: AttachmentJson, uvCount: number, boneNames: string[]): Weighted | null {
  const v = a.vertices ?? [];
  if (v.length === uvCount * 2) return null;
  const out: Weighted = [];
  for (let i = 0; i < v.length && out.length < uvCount; ) {
    const n = v[i++]!;
    const bones: string[] = [], weights: number[] = [];
    for (let k = 0; k < n; k++, i += 4) {
      bones.push(boneNames[v[i]!] ?? `#${v[i]}`);
      weights.push(v[i + 3]!);
    }
    out.push({ bones, weights });
  }
  return out;
}

function attachmentsOf(doc: SkeletonJson): Map<string, AttachmentJson & { type: string }> {
  const m = new Map<string, AttachmentJson & { type: string }>();
  for (const skin of doc.skins ?? []) {
    for (const [slot, atts] of Object.entries(skin.attachments ?? {})) {
      for (const [name, a] of Object.entries(atts)) m.set(`${skin.name}/${slot}/${name}`, { ...a, type: a.type ?? "region" });
    }
  }
  return m;
}

const near = (a: unknown, b: unknown, eps = 1e-3) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= eps : a === b);
const fmt = (v: unknown) => (typeof v === "number" ? +v.toFixed(3) : String(v));

/**
 * What a re-import of art (or any edit) changed between two versions of a skeleton, sorted into what it broke and
 * what it changed, plus how every common animation now plays differently.
 */
export function diffSkeletons(before: SkeletonJson, after: SkeletonJson, o: { fps?: number } = {}): ReimportDiff {
  const broken: DiffItem[] = [], changed: DiffItem[] = [];
  const notes: string[] = [];

  // Bones.
  const bBones = new Map(before.bones.map((b) => [b.name, b])), aBones = new Map(after.bones.map((b) => [b.name, b]));
  for (const [n] of bBones) if (!aBones.has(n)) broken.push({ where: `bone ${n}`, detail: "removed" });
  for (const [n] of aBones) if (!bBones.has(n)) changed.push({ where: `bone ${n}`, detail: "added" });
  const SETUP = ["parent", "x", "y", "rotation", "length", "scaleX", "scaleY", "shearX", "shearY", "inherit"] as const;
  const DEFAULTS: Record<string, unknown> = { x: 0, y: 0, rotation: 0, length: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, inherit: "normal" };
  for (const [n, b] of bBones) {
    const a = aBones.get(n);
    if (!a) continue;
    const diffs = SETUP.filter((f) => !near((b as Record<string, unknown>)[f] ?? DEFAULTS[f], (a as Record<string, unknown>)[f] ?? DEFAULTS[f])).map((f) => `${f} ${fmt((b as Record<string, unknown>)[f] ?? DEFAULTS[f])} → ${fmt((a as Record<string, unknown>)[f] ?? DEFAULTS[f])}`);
    if (diffs.length) changed.push({ where: `bone ${n}`, detail: `setup ${diffs.join(", ")}` });
  }

  // Slots (and setup draw order).
  const bSlots = before.slots ?? [], aSlots = after.slots ?? [];
  const aSlotMap = new Map(aSlots.map((s) => [s.name, s]));
  for (const s of bSlots) {
    const a = aSlotMap.get(s.name);
    if (!a) { broken.push({ where: `slot ${s.name}`, detail: "removed" }); continue; }
    for (const f of ["bone", "attachment", "color", "dark", "blend"] as const) {
      if (((s as Record<string, unknown>)[f] ?? null) !== ((a as Record<string, unknown>)[f] ?? null)) changed.push({ where: `slot ${s.name}`, detail: `${f} ${(s as Record<string, unknown>)[f] ?? "-"} → ${(a as Record<string, unknown>)[f] ?? "-"}` });
    }
  }
  for (const s of aSlots) if (!bSlots.some((x) => x.name === s.name)) changed.push({ where: `slot ${s.name}`, detail: "added" });
  const order = (sl: typeof bSlots) => sl.map((s) => s.name).filter((n) => aSlotMap.has(n) && bSlots.some((x) => x.name === n));
  if (order(bSlots).join() !== order(aSlots).join()) changed.push({ where: "draw order", detail: "setup draw order of existing slots changed" });

  // Constraints.
  const key = (c: { type?: string; name: string }) => `${c.type ?? "?"} ${c.name}`;
  const bCons = new Map((before.constraints ?? []).map((c) => [key(c), c])), aCons = new Map((after.constraints ?? []).map((c) => [key(c), c]));
  for (const [k, c] of bCons) {
    const a = aCons.get(k);
    if (!a) broken.push({ where: `constraint ${k}`, detail: "removed" });
    else if (JSON.stringify(c) !== JSON.stringify(a)) {
      const fields = [...new Set([...Object.keys(c), ...Object.keys(a)])].filter((f) => JSON.stringify((c as Record<string, unknown>)[f]) !== JSON.stringify((a as Record<string, unknown>)[f]));
      changed.push({ where: `constraint ${k}`, detail: `changed: ${fields.join(", ")}` });
    }
  }
  for (const [k] of aCons) if (!bCons.has(k)) changed.push({ where: `constraint ${k}`, detail: "added" });

  // Events.
  for (const ev of Object.keys(before.events ?? {})) if (!(ev in (after.events ?? {}))) broken.push({ where: `event ${ev}`, detail: "removed" });

  // Attachments: type, image size, path, mesh topology, vertices and weights.
  const bAtt = attachmentsOf(before), aAtt = attachmentsOf(after);
  const bNames = before.bones.map((b) => b.name), aNames = after.bones.map((b) => b.name);
  for (const [k, b] of bAtt) {
    const a = aAtt.get(k);
    if (!a) { changed.push({ where: `attachment ${k}`, detail: "removed" }); continue; }
    if (b.type !== a.type) {
      (b.type === "mesh" || b.type === "linkedmesh" ? broken : changed).push({ where: `attachment ${k}`, detail: `type ${b.type} → ${a.type}${b.type === "mesh" ? " (mesh, weights and deform lost)" : ""}` });
      continue;
    }
    if ((b.path ?? null) !== (a.path ?? null)) changed.push({ where: `attachment ${k}`, detail: `image path ${b.path ?? "(name)"} → ${a.path ?? "(name)"}` });
    if (!near(b.width, a.width, 0.5) || !near(b.height, a.height, 0.5)) {
      changed.push({ where: `attachment ${k}`, detail: `image size ${fmt(b.width)}x${fmt(b.height)} → ${fmt(a.width)}x${fmt(a.height)}${b.type === "mesh" ? " (UVs stay, so the mesh stretches the new image)" : ""}` });
    }
    if (b.type !== "mesh") continue;
    const bn = (b.uvs?.length ?? 0) / 2, an = (a.uvs?.length ?? 0) / 2;
    if (bn !== an) { changed.push({ where: `attachment ${k}`, detail: `mesh vertices ${bn} → ${an}` }); continue; }
    if (JSON.stringify(b.triangles) !== JSON.stringify(a.triangles)) changed.push({ where: `attachment ${k}`, detail: "mesh triangles changed" });
    const uvMove = Math.max(0, ...(b.uvs ?? []).map((u, i) => Math.abs(u - (a.uvs?.[i] ?? u))));
    if (uvMove > 1e-4) changed.push({ where: `attachment ${k}`, detail: `UVs moved up to ${uvMove.toFixed(4)}` });
    const bw = influences(b, bn, bNames), aw = influences(a, an, aNames);
    if (bw && !aw) broken.push({ where: `attachment ${k}`, detail: `weights lost (was weighted to ${new Set(bw.flatMap((v) => v.bones)).size} bones, now unweighted)` });
    else if (!bw && aw) changed.push({ where: `attachment ${k}`, detail: "now weighted" });
    else if (bw && aw) {
      let verts = 0, maxDelta = 0;
      bw.forEach((v, i) => {
        const w = aw[i]!;
        const all = new Set([...v.bones, ...w.bones]);
        let d = 0;
        for (const bone of all) d = Math.max(d, Math.abs((v.weights[v.bones.indexOf(bone)] ?? 0) - (w.weights[w.bones.indexOf(bone)] ?? 0)));
        if (d > 0.01) { verts++; maxDelta = Math.max(maxDelta, d); }
      });
      if (verts) changed.push({ where: `attachment ${k}`, detail: `weights changed on ${verts}/${bn} vertices (max ${maxDelta.toFixed(2)})` });
    } else {
      const move = Math.max(0, ...Array.from({ length: bn }, (_, i) => Math.hypot((b.vertices![i * 2]! - a.vertices![i * 2]!), (b.vertices![i * 2 + 1]! - a.vertices![i * 2 + 1]!))));
      if (move > 0.01) changed.push({ where: `attachment ${k}`, detail: `vertices moved up to ${move.toFixed(2)}` });
    }
  }
  for (const [k, a] of aAtt) if (!bAtt.has(k)) changed.push({ where: `attachment ${k}`, detail: `added (${a.type})` });

  // Animations: removed, timelines and keys lost, and how they play now.
  const bAnims = before.animations ?? {}, aAnims = after.animations ?? {};
  for (const n of Object.keys(bAnims)) if (!(n in aAnims)) broken.push({ where: `animation ${n}`, detail: "removed" });
  for (const n of Object.keys(aAnims)) if (!(n in bAnims)) changed.push({ where: `animation ${n}`, detail: "added" });
  const tlKey = (t: { kind: string; owner: string; attachment?: { skin: string; slot: string; name: string } }) => `${t.kind} ${t.attachment ? `${t.attachment.skin}/${t.attachment.slot}/${t.attachment.name}` : t.owner}`.trim();
  const dataB = loadSkeletonData(before), dataA = loadSkeletonData(after);
  const animations: AnimationChange[] = [];
  for (const [n, ba] of Object.entries(bAnims)) {
    const aa = aAnims[n];
    if (!aa) continue;
    const bt = new Map([...iterateTimelines(ba)].map((t) => [tlKey(t), t.keys])), at = new Map([...iterateTimelines(aa)].map((t) => [tlKey(t), t.keys]));
    const removed = [...bt.keys()].filter((k) => !at.has(k)), added = [...at.keys()].filter((k) => !bt.has(k));
    let lost = removed.reduce((s, k) => s + bt.get(k)!.length, 0);
    for (const [k, keys] of bt) {
      const now = at.get(k);
      if (now && now.length < keys.length) lost += keys.length - now.length;
    }
    const behaviour = playDiff(dataB, dataA, n, o.fps ?? 30);
    const change: AnimationChange = { animation: n, keysLost: lost, timelinesRemoved: removed, timelinesAdded: added, behaviour };
    if (lost || removed.length || added.length || behaviour.maxBoneMove > 0.01 || behaviour.attachmentChanges.length || behaviour.maxVertexMove > 0.01) animations.push(change);
    if (lost) broken.push({ where: `animation ${n}`, detail: `${lost} key(s) lost${removed.length ? ` (timelines removed: ${removed.slice(0, 4).join(", ")}${removed.length > 4 ? ", …" : ""})` : ""}` });
    // Attachment keys Spine rewrote: when an attachment is deleted it keeps the key but sets it to none (hide).
    for (const [k, keys] of bt) {
      if (!k.startsWith("slot.attachment")) continue;
      const now = at.get(k);
      if (!now) continue;
      const rewritten = keys.filter((key) => {
        const match = now.find((x) => Math.abs((x.time ?? 0) - (key.time ?? 0)) < 1e-4);
        return match && (match.name ?? null) !== (key.name ?? null);
      });
      if (rewritten.length) {
        const first = rewritten[0]!, after1 = now.find((x) => Math.abs((x.time ?? 0) - (first.time ?? 0)) < 1e-4)!;
        broken.push({ where: `animation ${n}`, detail: `${rewritten.length} attachment key(s) in slot ${k.split(" ")[1]} changed, e.g. at ${first.time ?? 0}s "${first.name ?? "none"}" → "${after1.name ?? "none"}"${after1.name ? "" : " (attachment deleted: the slot is hidden there)"}` });
      }
    }
    for (const k of removed.filter((r) => r.startsWith("slot.attachment"))) notes.push(`${n}: attachment visibility keys of ${k.split(" ")[1]} are gone; re-key them or restore the snapshot`);
  }
  // References that now point to nothing. Spine keeps an attachment key whose attachment was deleted (no warning); the
  // slot then shows nothing from that key on.
  const existsInSlot = (slot: string, name: string) => (after.skins ?? []).some((sk) => sk.attachments?.[slot]?.[name]);
  for (const [n, anim] of Object.entries(aAnims)) {
    for (const [slot, tl] of Object.entries(anim.slots ?? {})) {
      const dangling = (tl.attachment ?? []).filter((k) => k.name && !existsInSlot(slot, k.name as string));
      if (dangling.length) broken.push({ where: `animation ${n}`, detail: `${dangling.length} attachment key(s) in slot ${slot} point to a missing attachment (${[...new Set(dangling.map((k) => k.name))].join(", ")}, first at ${(dangling[0]!.time ?? 0)}s): the slot shows nothing there` });
    }
  }
  for (const sl of aSlots) if (sl.attachment && !existsInSlot(sl.name, sl.attachment)) broken.push({ where: `slot ${sl.name}`, detail: `setup attachment "${sl.attachment}" no longer exists` });
  // Other dangling references the validator knows (bones, slots, constraints keyed by animations, deform on wrong meshes).
  for (const i of validateSkeleton(after, { runtime: false })) {
    if (i.severity !== "error" || i.code === "missing-attachment") continue;
    broken.push({ where: i.where ?? i.code, detail: i.message });
  }
  if ((before.skins ?? []).length > 1) notes.push("Animations are played with the default skin only.");
  return {
    broken, changed, animations,
    counts: { bones: [before.bones.length, after.bones.length], slots: [bSlots.length, aSlots.length], attachments: [bAtt.size, aAtt.size], animations: [Object.keys(bAnims).length, Object.keys(aAnims).length] },
    notes,
  };
}

/** Plays one animation on both versions (physics off) and compares bones, visible attachments and mesh vertices by name. */
function playDiff(dataB: spine.SkeletonData, dataA: spine.SkeletonData, name: string, fps: number): AnimationChange["behaviour"] {
  const out: AnimationChange["behaviour"] = { maxBoneMove: 0, attachmentChanges: [], maxVertexMove: 0 };
  const ab = dataB.findAnimation(name), aa = dataA.findAnimation(name);
  if (!ab || !aa) return out;
  const sb = new spine.Skeleton(dataB), sa = new spine.Skeleton(dataA);
  const D = Math.max(ab.duration, aa.duration);
  const steps = Math.max(1, Math.round(D * fps));
  const bufB: number[] = [], bufA: number[] = [];
  const seen = new Set<string>();
  for (let k = 0; k <= steps; k++) {
    const t = (D * k) / steps;
    for (const [sk, an] of [[sb, ab], [sa, aa]] as const) {
      sk.setupPose();
      an.apply(sk, t, t, false, null, 1, spine.MixFrom.setup, false, false, false);
      sk.updateWorldTransform(spine.Physics.none);
    }
    for (const b of sb.bones) {
      const a = sa.findBone(b.data.name);
      if (!a) continue;
      const d = Math.hypot(b.appliedPose.worldX - a.appliedPose.worldX, b.appliedPose.worldY - a.appliedPose.worldY);
      if (d > out.maxBoneMove) { out.maxBoneMove = +d.toFixed(3); out.worstBone = `${b.data.name}@${t.toFixed(2)}s`; }
    }
    for (const s of sb.slots) {
      const a = sa.findSlot(s.data.name);
      if (!a) continue;
      const x = s.pose.getAttachment(), y = a.pose.getAttachment();
      if ((x?.name ?? null) !== (y?.name ?? null)) {
        const msg = `${s.data.name}: ${x?.name ?? "none"} → ${y?.name ?? "none"}`;
        if (!seen.has(msg) && out.attachmentChanges.length < 12) { seen.add(msg); out.attachmentChanges.push(`${msg} (from ${t.toFixed(2)}s)`); }
        continue;
      }
      if (x instanceof spine.MeshAttachment && y instanceof spine.MeshAttachment && x.worldVerticesLength === y.worldVerticesLength) {
        bufB.length = bufA.length = x.worldVerticesLength;
        x.computeWorldVertices(sb, s, 0, x.worldVerticesLength, bufB, 0, 2);
        y.computeWorldVertices(sa, a, 0, y.worldVerticesLength, bufA, 0, 2);
        for (let i = 0; i < bufB.length; i += 2) {
          const d = Math.hypot(bufB[i]! - bufA[i]!, bufB[i + 1]! - bufA[i + 1]!);
          if (d > out.maxVertexMove) { out.maxVertexMove = +d.toFixed(3); out.worstMesh = `${s.data.name}/${x.name}@${t.toFixed(2)}s`; }
        }
      }
    }
  }
  return out;
}

