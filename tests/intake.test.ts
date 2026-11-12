import { describe, expect, it } from "vitest";
import { prepareForImport, rescaleStretchedRegions, sortWeightedBones, weightOrderConflicts } from "../src/spine/intake.js";
import { loadSkeletonData, spine } from "../src/spine/runtime.js";
import type { AnimationJson, AttachmentJson, SkeletonJson } from "../src/spine/types.js";
import { validateSkeleton } from "../src/spine/validate.js";

const corners = [[0, 0], [40, 0], [0, 40], [40, 40]] as const;
const weighted = (orders: number[][]): number[] => orders.flatMap((order, k) => [order.length, ...order.flatMap((b, i) => [b, corners[k]![0] + b * 3, corners[k]![1] - b * 2, order.length === 1 ? 1 : i === 0 ? 0.7 : 0.3 / (order.length - 1)])]);
const meshAtt = (orders: number[][]): AttachmentJson => ({ type: "mesh", uvs: [0, 1, 1, 1, 0, 0, 1, 0], triangles: [0, 1, 2, 1, 3, 2], vertices: weighted(orders), hull: 4, width: 40, height: 40 });
const skeleton = (att: AttachmentJson, animations?: Record<string, AnimationJson>): SkeletonJson => ({
  skeleton: { spine: "4.3.26" },
  bones: [{ name: "root" }, { name: "a", parent: "root", rotation: 10 }, { name: "b", parent: "a", x: 20, rotation: -15 }, { name: "c", parent: "b", x: 15 }],
  slots: [{ name: "m", bone: "b", attachment: "m" }],
  skins: [{ name: "default", attachments: { m: { m: att } } }],
  ...(animations ? { animations } : {}),
});
const worldAt = (doc: SkeletonJson, anim: string | null, t: number) => {
  const data = loadSkeletonData(doc);
  const sk = new spine.Skeleton(data);
  sk.setupPose();
  if (anim) data.findAnimation(anim)!.apply(sk, t, t, false, null, 1, spine.MixFrom.setup, false, false, false);
  sk.updateWorldTransform(spine.Physics.none);
  const s = sk.findSlot("m")!, att = s.pose.getAttachment() as spine.MeshAttachment;
  const out = new Array<number>(att.worldVerticesLength).fill(0);
  att.computeWorldVertices(sk, s, 0, att.worldVerticesLength, out, 0, 2);
  return out;
};

describe("weighted bone order", () => {
  it("finds vertices that list shared bones in another order than the rest, not a consistent order Spine writes itself", () => {
    expect(weightOrderConflicts(meshAtt([[1, 2], [1, 2], [1, 2], [2, 1]]))).toBe(4);
    expect(weightOrderConflicts(meshAtt([[2, 1], [2, 1], [2, 1], [2, 1]]))).toBe(0);
    expect(weightOrderConflicts(meshAtt([[1], [1], [1], [2, 1]]))).toBe(0);
    expect(weightOrderConflicts(meshAtt([[1, 2], [2, 3], [3, 1], [1]]))).toBe(1);
  });

  it("validate flags a mixed order as an error and stays quiet on a consistent one", () => {
    expect(validateSkeleton(skeleton(meshAtt([[1, 2], [1, 2], [1, 2], [2, 1]])), { runtime: false }).filter((i) => i.code === "weight-bone-order")).toHaveLength(1);
    expect(validateSkeleton(skeleton(meshAtt([[2, 1], [2, 1], [3, 2, 1], [2, 1]])), { runtime: false }).filter((i) => i.code === "weight-bone-order")).toHaveLength(0);
  });

  it("sorting keeps the pose and the deform keys in place", () => {
    const orders = [[1, 2], [3, 1, 2], [1, 2], [2, 1]];
    const deform: AnimationJson = { attachments: { default: { m: { m: { deform: [{ time: 0 }, { time: 0.5, offset: 2, vertices: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17] }] } } } } };
    const before = skeleton(meshAtt(orders), { d: deform });
    const after = structuredClone(before);
    const report = sortWeightedBones(after);
    expect(report.meshes).toHaveLength(1);
    expect(weightOrderConflicts(after.skins![0]!.attachments!.m!.m!)).toBe(0);
    for (const t of [0, 0.25, 0.5]) worldAt(after, "d", t).forEach((v, i) => expect(v).toBeCloseTo(worldAt(before, "d", t)[i]!, 6));
    worldAt(after, null, 0).forEach((v, i) => expect(v).toBeCloseTo(worldAt(before, null, 0)[i]!, 6));
  });
});

describe("regions drawn at another size than their image", () => {
  it("moves the stretch into the region's scale so the size survives Spine's export", () => {
    const doc = skeleton({ type: "region", width: 1320, height: 2868, scaleX: 0.5 } as AttachmentJson);
    const images = (path: string) => (path === "m" ? { width: 4, height: 4, data: new Uint8Array(64) } : null);
    const found = rescaleStretchedRegions(doc, images);
    expect(found).toEqual([{ id: "default/m/m", image: "m", size: [1320, 2868], file: [4, 4] }]);
    expect(doc.skins![0]!.attachments!.m!.m).toMatchObject({ width: 4, height: 4, scaleX: 165, scaleY: 717 });
    expect(prepareForImport(doc, images)).toEqual([]);
  });
});

describe("validate checks from foreign files", () => {
  const base = (): SkeletonJson => ({
    skeleton: { spine: "4.3.26" },
    bones: [{ name: "root" }],
    slots: [{ name: "clip", bone: "root", attachment: "clip" }, { name: "inner", bone: "root", attachment: "inner" }, { name: "art", bone: "root" }, { name: "end", bone: "root" }],
    skins: [{ name: "default", attachments: {
      clip: { clip: { type: "clipping", end: "end", vertexCount: 6, vertices: [0, 0, 100, 0, 100, 100, 50, 40, 0, 100, 0, 50] } },
      inner: { inner: { type: "clipping", end: "art", inverse: true, vertexCount: 4, vertices: [0, 0, 10, 0, 10, 10, 0, 10] } },
    } }],
  });

  it("warns about a concave clip, an inverse clip and a clip that starts inside another one", () => {
    const codes = validateSkeleton(base(), { runtime: false }).map((i) => i.code);
    expect(codes).toContain("clip-concave");
    expect(codes).toContain("clip-inverse-lost");
    expect(codes).toContain("clip-nested");
    const convex = base();
    convex.skins![0]!.attachments!.clip!.clip!.vertices = [0, 0, 100, 0, 100, 100, 0, 100];
    convex.skins![0]!.attachments!.clip!.clip!.vertexCount = 4;
    expect(validateSkeleton(convex, { runtime: false }).map((i) => i.code)).not.toContain("clip-concave");
  });

  it("refuses 4.2 constraint arrays in data labelled 4.3", () => {
    const doc = { ...base(), ik: [{ name: "leg", bones: ["root"], target: "root" }] } as SkeletonJson;
    expect(validateSkeleton(doc, { runtime: false }).find((i) => i.code === "legacy-constraint-block")?.severity).toBe("error");
    expect(validateSkeleton({ ...doc, skeleton: { spine: "4.2.40" } }, { runtime: false }).map((i) => i.code)).not.toContain("legacy-constraint-block");
  });

  it("reports keys between frames, keys on every frame, long decimals and a loop timeline that ends late", () => {
    const doc = base();
    doc.skeleton.fps = 30;
    doc.animations = {
      idle: { bones: { root: {
        rotate: [{ time: 0, value: 0 }, { time: 0.38, value: 4.1172 }, { time: 1, value: 0 }],
        translate: Array.from({ length: 31 }, (_, f) => ({ time: f / 30, x: f, y: 0 })),
        scale: [{ time: 0, x: 1, y: 1 }, { time: 1.0667, x: 1.0133, y: 1 }],
      } } },
    };
    const issues = validateSkeleton(doc, { runtime: false });
    expect(issues.find((i) => i.code === "key-off-frame")?.message).toMatch(/1 of 36 keys .*0\.38s \(frame 11\.4\)/);
    expect(issues.find((i) => i.code === "key-dense")?.message).toMatch(/bone\.translate root \(31 keys\)/);
    expect(issues.find((i) => i.code === "key-long-decimals")?.message).toMatch(/2 key value\(s\).*4\.1172.*1\.0133/);
    expect(issues.find((i) => i.code === "timeline-end-mismatch")?.message).toMatch(/bone\.scale root ends at 1\.0667s/);
    expect(issues.every((i) => !i.code.startsWith("key-") || i.severity === "info")).toBe(true);
  });

  it("stays quiet on clean keys", () => {
    const doc = base();
    doc.animations = { idle: { bones: { root: { rotate: [{ time: 0, value: 0 }, { time: 0.4, value: 4.5 }, { time: 1, value: 0 }], scale: [{ time: 0, x: 1, y: 1 }, { time: 1, x: 1.05, y: 1 }] } } } };
    expect(validateSkeleton(doc, { runtime: false }).map((i) => i.code).filter((c) => c.startsWith("key-") || c === "timeline-end-mismatch")).toEqual([]);
  });
});
