import { iterateTimelines } from "./inspect.js";
import { spine } from "./runtime.js";
import type { AnimationJson, Key } from "./types.js";

/** Per-frame render metrics, named after Spine's Metrics view (plus a draw call estimate). */
export interface FrameMetrics {
  visibleAttachments: number;
  vertices: number;
  vertexTransforms: number;
  triangles: number;
  /** Pixels drawn at full size, transparent pixels and overdraw included (fill rate). */
  area: number;
  clippingPolygons: number;
  clippedTriangles: number;
  /** Batch breaks on texture page or blend mode changes (spine-webgl, spine-player and most runtimes); pages known only with an atlas. */
  drawCalls: number;
  /** Batch breaks on texture page changes only: spine-unity's SkeletonRenderer with its default materials draws other blend modes in the same batch (measured with spine_unity_check batching); Blend Mode Materials add breaks. */
  drawCallsPagesOnly: number;
  /** Visible attachments whose slot alpha is 0: they still cost fill rate (hide them instead). */
  invisibleButDrawn: number;
}

export interface AnimationBudget {
  name: string;
  timelines: number;
  /** Timelines whose keys never change the value: still applied every frame. */
  staticTimelines: number;
  deformTimelines: number;
  max: FrameMetrics;
  /** Time (s) of the frame with the most vertex transforms. */
  peakAt: number;
}

export interface BudgetLimits {
  bones?: number;
  constraints?: number;
  vertexTransforms?: number;
  vertices?: number;
  drawCalls?: number;
  clippedTriangles?: number;
  area?: number;
}

export interface BudgetResult {
  skeleton: {
    bones: number;
    slots: number;
    constraints: { ik: number; ikTwoBone: number; transform: number; path: number; physics: number; slider: number };
    attachments: { total: number; byType: Record<string, number> };
    maxBonesPerVertex: number;
  };
  setup: FrameMetrics;
  animations: AnimationBudget[];
  /** Worst value of each metric over the setup pose and every sampled frame. */
  worst: FrameMetrics & { where: Partial<Record<keyof FrameMetrics, string>> };
  pagesKnown: boolean;
  overBudget: string[];
  findings: string[];
  notes: string[];
}

const EMPTY = (): FrameMetrics => ({ visibleAttachments: 0, vertices: 0, vertexTransforms: 0, triangles: 0, area: 0, clippingPolygons: 0, clippedTriangles: 0, drawCalls: 0, drawCallsPagesOnly: 0, invisibleButDrawn: 0 });

function triangleArea(v: ArrayLike<number>, tris: ArrayLike<number>): number {
  let a = 0;
  for (let i = 0; i < tris.length; i += 3) {
    const p = tris[i]! * 2, q = tris[i + 1]! * 2, r = tris[i + 2]! * 2;
    a += Math.abs((v[q]! - v[p]!) * (v[r + 1]! - v[p + 1]!) - (v[r]! - v[p]!) * (v[q + 1]! - v[p + 1]!)) / 2;
  }
  return a;
}

const pageOf = (att: spine.Attachment): string | null => {
  const region = (att as unknown as { sequence?: spine.Sequence }).sequence?.regions?.[0] as (spine.TextureRegion & { page?: { name: string } }) | undefined;
  return region?.page?.name ?? null;
};

/** Measures what the renderer gets for the skeleton's current pose, walking the draw order like a runtime does. */
function frameMetrics(sk: spine.Skeleton, triangulator: spine.Triangulator, clipCache: Map<spine.ClippingAttachment, number>): FrameMetrics {
  const m = EMPTY();
  let clipEnd: spine.SlotData | null = null;
  let batch: string | null = null, pageBatch: string | null = null;
  const world = new Array<number>(512);
  for (const slot of sk.drawOrder.pose) {
    const att = slot.pose.getAttachment();
    if (att && (att instanceof spine.RegionAttachment || att instanceof spine.MeshAttachment)) {
      m.visibleAttachments++;
      if (slot.pose.color.a <= 0) m.invisibleButDrawn++;
      let verts: number, tris: number, transforms: number, area: number;
      if (att instanceof spine.RegionAttachment) {
        const p = slot.bone.appliedPose;
        verts = 4; tris = 2; transforms = 4;
        area = Math.abs(att.width * att.height * att.scaleX * att.scaleY * (p.a * p.d - p.b * p.c));
      } else {
        verts = att.worldVerticesLength / 2;
        tris = att.triangles.length / 3;
        transforms = att.bones ? att.bones.length - verts : verts;
        if (world.length < att.worldVerticesLength) world.length = att.worldVerticesLength;
        att.computeWorldVertices(sk, slot, 0, att.worldVerticesLength, world, 0, 2);
        area = triangleArea(world, att.triangles);
      }
      m.vertices += verts; m.triangles += tris; m.vertexTransforms += transforms; m.area += area;
      if (clipEnd) m.clippedTriangles += tris;
      const key = `${pageOf(att) ?? "?"}|${slot.data.blendMode}`;
      if (key !== batch) { m.drawCalls++; batch = key; }
      const page = pageOf(att) ?? "?";
      if (page !== pageBatch) { m.drawCallsPagesOnly++; pageBatch = page; }
    } else if (att instanceof spine.ClippingAttachment) {
      if (!clipCache.has(att)) {
        const poly = Array.from(att.vertices.slice(0, att.worldVerticesLength));
        clipCache.set(att, triangulator.decompose(poly, triangulator.triangulate(poly)).length);
      }
      m.clippingPolygons += clipCache.get(att)!;
      m.vertexTransforms += att.bones ? att.bones.length - att.worldVerticesLength / 2 : att.worldVerticesLength / 2;
      clipEnd = att.endSlot;
    }
    if (clipEnd && slot.data === clipEnd) clipEnd = null;
  }
  m.area = Math.round(m.area);
  return m;
}

/** One skin, or several combined in order like a mix-and-match runtime does (Skin.addSkin: later skins win a slot). */
export function combineSkins(data: spine.SkeletonData, names: string[]): spine.Skin {
  const skins = names.map((n) => {
    const skin = data.findSkin(n);
    if (!skin) throw new Error(`Skin "${n}" not found. Skins: ${data.skins.map((k) => k.name).slice(0, 30).join(", ")}`);
    return skin;
  });
  if (skins.length === 1) return skins[0]!;
  const combined = new spine.Skin(names.join("+"));
  for (const skin of skins) combined.addSkin(skin);
  return combined;
}

const sameValue = (a: Key, b: Key) => {
  const strip = ({ time: _t, curve: _c, ...rest }: Key) => JSON.stringify(rest);
  return strip(a) === strip(b);
};

/**
 * Performance budget of a skeleton: Spine's Metrics view numbers for the setup pose and every frame of every
 * animation, plus a draw call estimate, static timelines and pass/fail against the limits you give.
 */
export function budgetReport(data: spine.SkeletonData, animations: Record<string, AnimationJson>, o: { fps?: number; limits?: BudgetLimits; pagesKnown: boolean; skin?: string | string[] }): BudgetResult {
  const fps = o.fps ?? 30;
  const sk = new spine.Skeleton(data);
  if (o.skin?.length) sk.setSkin(combineSkins(data, typeof o.skin === "string" ? [o.skin] : o.skin));
  const triangulator = new spine.Triangulator();
  const clipCache = new Map<spine.ClippingAttachment, number>();
  const pose = (anim?: spine.Animation, t = 0) => {
    sk.setupPose();
    anim?.apply(sk, t, t, false, null, 1, spine.MixFrom.setup, false, false, false);
    sk.updateWorldTransform(spine.Physics.none);
    return frameMetrics(sk, triangulator, clipCache);
  };
  const setup = pose();
  const worst = { ...setup, where: Object.fromEntries(Object.keys(setup).map((k) => [k, "setup"])) as Partial<Record<keyof FrameMetrics, string>> };
  const take = (m: FrameMetrics, where: string) => {
    for (const k of Object.keys(m) as (keyof FrameMetrics)[]) if (m[k] > worst[k]) { worst[k] = m[k]; worst.where[k] = where; }
  };

  const results: AnimationBudget[] = data.animations.map((anim) => {
    const max = EMPTY();
    let peakAt = 0;
    const frames = Math.max(1, Math.round(anim.duration * fps));
    for (let k = 0; k <= frames; k++) {
      const t = (anim.duration * k) / frames;
      const m = pose(anim, t);
      if (m.vertexTransforms > max.vertexTransforms) peakAt = +t.toFixed(3);
      for (const key of Object.keys(m) as (keyof FrameMetrics)[]) max[key] = Math.max(max[key], m[key]);
      take(m, `${anim.name}@${t.toFixed(2)}s`);
    }
    let staticTimelines = 0, deformTimelines = 0;
    for (const tl of iterateTimelines(animations[anim.name] ?? {})) {
      if (tl.kind.endsWith("deform")) deformTimelines++;
      // Zero-length pose animations (used on layered tracks) are static by design.
      if (anim.duration === 0 || tl.kind === "events" || tl.kind.startsWith("drawOrder") || tl.kind.endsWith("attachment") || tl.kind.endsWith("sequence")) continue;
      if (tl.keys.length && tl.keys.every((k) => sameValue(k, tl.keys[0]!))) staticTimelines++;
    }
    return { name: anim.name, timelines: anim.timelines.length, staticTimelines, deformTimelines, max, peakAt };
  });

  // Skeleton-level counts.
  const byType: Record<string, number> = {};
  let total = 0, maxBones = 0;
  for (const skin of data.skins) {
    for (const entry of skin.getAttachments()) {
      total++;
      const a = entry.attachment;
      const type = a.constructor.name.replace(/Attachment$/, "").toLowerCase();
      byType[type] = (byType[type] ?? 0) + 1;
      const bones = (a as spine.VertexAttachment).bones;
      if (bones) for (let i = 0; i < bones.length; i += bones[i]! + 1) maxBones = Math.max(maxBones, bones[i]!);
    }
  }
  const cons = { ik: 0, ikTwoBone: 0, transform: 0, path: 0, physics: 0, slider: 0 };
  for (const c of data.constraints) {
    if (c instanceof spine.IkConstraintData) { cons.ik++; if (c.bones.length > 1) cons.ikTwoBone++; }
    else if (c instanceof spine.TransformConstraintData) cons.transform++;
    else if (c instanceof spine.PathConstraintData) cons.path++;
    else if (c instanceof spine.PhysicsConstraintData) cons.physics++;
    else cons.slider++;
  }

  const findings: string[] = [];
  if (worst.clippedTriangles > 0) findings.push(`Clipping clips up to ${worst.clippedTriangles} triangles (${worst.where.clippedTriangles}). Esoteric: "Clipping is very expensive and should be avoided whenever possible"; keep clipping polygons convex, with few vertices, clipping few triangles.`);
  if (worst.invisibleButDrawn > 0) findings.push(`Up to ${worst.invisibleButDrawn} attachment(s) drawn at alpha 0 (${worst.where.invisibleButDrawn}): transparent pixels still use fill rate; hide them with an attachment key instead.`);
  if (o.pagesKnown && worst.drawCalls > 1) findings.push(`Up to ${worst.drawCalls} draw calls (${worst.where.drawCalls}) where batches break on texture page or blend mode changes in draw order (spine-webgl, spine-player and most runtimes): group additive/multiply slots and pack into fewer pages. spine-unity with its default materials breaks only on pages: ${worst.drawCallsPagesOnly} (Blend Mode Materials add breaks; spine_unity_check batching measures it).`);
  if (!o.pagesKnown && worst.drawCalls > 1) findings.push(`Blend mode changes alone split the draw order into ${worst.drawCalls} batches (${worst.where.drawCalls}).`);
  if (maxBones > 4) findings.push(`Some vertices are weighted to ${maxBones} bones; weights multiply vertex transforms (CPU). Prune weights where the deformation does not need them.`);
  const staticTotal = results.reduce((a, r) => a + r.staticTimelines, 0);
  if (staticTotal) findings.push(`${staticTotal} timeline(s) never change their value but are applied every frame. Before removing them (Animation clean up), run spine_mix_check: a missing key can cause a pop when animations mix.`);

  if (worst.visibleAttachments === 0 && data.skins.length > 1 && !o.skin) {
    findings.push(`Nothing is visible without a skin (skins: ${data.skins.map((k) => k.name).filter((n) => n !== "default").slice(0, 8).join(", ")}). Pass skin to measure one.`);
  }
  const limits = o.limits ?? {};
  const overBudget: string[] = [];
  const check = (name: string, value: number, limit?: number, where?: string) => { if (limit !== undefined && value > limit) overBudget.push(`${name} ${value} > ${limit}${where ? ` (${where})` : ""}`); };
  check("bones", data.bones.length, limits.bones);
  check("constraints", data.constraints.length, limits.constraints);
  check("vertexTransforms", worst.vertexTransforms, limits.vertexTransforms, worst.where.vertexTransforms);
  check("vertices", worst.vertices, limits.vertices, worst.where.vertices);
  check("drawCalls", worst.drawCalls, limits.drawCalls, worst.where.drawCalls);
  check("clippedTriangles", worst.clippedTriangles, limits.clippedTriangles, worst.where.clippedTriangles);
  check("area", worst.area, limits.area, worst.where.area);

  return {
    skeleton: { bones: data.bones.length, slots: data.slots.length, constraints: cons, attachments: { total, byType }, maxBonesPerVertex: maxBones },
    setup, animations: results, worst, pagesKnown: o.pagesKnown, overBudget, findings,
    notes: [
      "Metrics follow Spine's Metrics view (per skeleton instance; multiply by the number on screen). Draw calls are an estimate: a batch per run of the same texture page and blend mode.",
      o.pagesKnown ? "Texture pages come from the atlas." : "Texture pages unknown (no atlas): draw calls count blend mode changes only. Pass an atlas, or use spine_export first.",
      "No universal limits exist; pass `limits` with your target device's budget to get pass/fail.",
    ],
  };
}
