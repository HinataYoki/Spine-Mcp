import { describe, expect, it } from "vitest";
import { buildRig, type Part } from "../src/spine/autorig.js";
import { applyRigEdits } from "../src/spine/rigedit.js";
import { loadSkeletonData, spine } from "../src/spine/runtime.js";
import type { SkeletonJson } from "../src/spine/types.js";

const shape = (name: string, left: number, top: number, width: number, height: number): Part => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (((x - width / 2) / (width / 2)) ** 2 + ((y - height / 2) / (height / 2)) ** 2 <= 1) data.set([180, 120, 90, 255], (y * width + x) * 4);
  return { name, path: name, left, top, width, height, data, opacity: 1 };
};
const parts = [shape("Body", 100, 100, 200, 300), shape("Lid", 160, 140, 60, 40)];
const bones = [
  { name: "Body", joint: [200, 390] as [number, number], tip: [200, 110] as [number, number], layers: ["Body"] },
  { name: "Lid", parent: "Body", joint: [190, 140] as [number, number], tip: [195, 180] as [number, number], layers: ["Lid"] },
];
const worldVerts = (doc: SkeletonJson, slotName: string) => {
  const sk = new spine.Skeleton(loadSkeletonData(structuredClone(doc)));
  sk.setupPose();
  sk.updateWorldTransform(spine.Physics.none);
  const slot = sk.findSlot(slotName)!, att = slot.pose.getAttachment()!;
  if (att instanceof spine.RegionAttachment) { const v = new Array(8).fill(0); att.computeWorldVertices(slot, att.getOffsets(slot.pose), v, 0, 2); return v; }
  const m = att as spine.MeshAttachment, v = new Array(m.worldVerticesLength).fill(0);
  m.computeWorldVertices(sk, slot, 0, m.worldVerticesLength, v, 0, 2);
  return v;
};

describe("rig edits for meshes", () => {
  it("traces a region into a mesh in place, rotated and scaled regions included", () => {
    const doc = buildRig(parts, { bones, mesh: "none", scale: 1 }).doc;
    const lid = (doc.skins![0]!.attachments as Record<string, Record<string, Record<string, number>>>).Lid!.Lid!;
    Object.assign(lid, { rotation: (lid.rotation ?? 0) + 20, scaleX: 1.3, scaleY: 0.8 });
    const quad = worldVerts(doc, "Lid");
    const img = parts[1]!;
    const out = applyRigEdits(doc, [{ op: "meshRegion", slot: "Lid" }], { image: () => ({ width: img.width, height: img.height, data: img.data }) });
    const mesh = (out.doc.skins![0]!.attachments as Record<string, Record<string, { type: string; uvs: number[] }>>).Lid!.Lid!;
    expect(mesh.type).toBe("mesh");
    const v = worldVerts(out.doc, "Lid");
    const [blx, bly, ulx, uly, , , brx, bry] = quad;
    for (let i = 0; i < mesh.uvs.length; i += 2) {
      const u = mesh.uvs[i]!, w = 1 - mesh.uvs[i + 1]!;
      const x = blx! + u * (brx! - blx!) + w * (ulx! - blx!), y = bly! + u * (bry! - bly!) + w * (uly! - bly!);
      expect(Math.hypot(v[i]! - x, v[i + 1]! - y)).toBeLessThan(0.01);
    }
    expect(out.applied[0]).toMatch(/traced into a mesh/);
  });

  it("copies a weighted mesh from a skeleton with the same setup pose, and refuses one whose bones differ", () => {
    const a = buildRig(parts, { bones, mesh: "sparse", weights: "joint", scale: 1 }).doc;
    const b = buildRig(parts, { bones, mesh: "none", scale: 1 }).doc;
    const out = applyRigEdits(b, [{ op: "copyMesh", from: "a.json", slot: "Body" }], { source: () => a });
    const want = worldVerts(a, "Body"), got = worldVerts(out.doc, "Body");
    expect(got.length).toBe(want.length);
    for (let i = 0; i < got.length; i++) expect(Math.abs(got[i]! - want[i]!)).toBeLessThan(1e-3);
    const moved = applyRigEdits(b, [{ op: "setBone", name: "Lid", x: 5 }]).doc;
    expect(() => applyRigEdits(moved, [{ op: "copyMesh", from: "a.json", slot: "Lid" }], { source: () => a })).toThrow(/set up differently/);
  });
});
