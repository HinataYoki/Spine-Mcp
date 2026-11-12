import { describe, expect, it } from "vitest";
import { buildRig, type Part } from "../src/spine/autorig.js";

const shape = (name: string, left: number, top: number, width: number, height: number, group: string, inside?: (x: number, y: number) => boolean): Part => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (!inside || inside(x, y)) data.set([180, 120, 90, 255], (y * width + x) * 4);
  return { name, path: name, left, top, width, height, data, opacity: 1, group };
};
const ellipse = (w: number, h: number) => (x: number, y: number) => ((x - w / 2) / (w / 2)) ** 2 + ((y - h / 2) / (h / 2)) ** 2 <= 1;
const holes = (list: [number, number, number, number][]) => (x: number, y: number) => !list.some(([l, t, w, h]) => ellipse(w, h)(x - l, y - t) && x >= l && y >= t && x < l + w && y < t + h);

const weightsOf = (rig: ReturnType<typeof buildRig>, slot: string) => {
  const bones = (rig.doc.bones as { name: string }[]).map((x) => x.name);
  const a = (rig.doc.skins![0]!.attachments as Record<string, Record<string, { vertices: number[] }>>)[slot]![slot]!;
  const out: Record<string, number>[] = [];
  for (let i = 0; i < a.vertices.length;) { const n = a.vertices[i++]!, row: Record<string, number> = {}; for (let k = 0; k < n; k++) { row[bones[a.vertices[i]!]!] = a.vertices[i + 3]!; i += 4; } out.push(row); }
  return out;
};

describe("sparse meshes on a big body with the face drawn under it", () => {
  const body = shape("Fox_Body", 100, 0, 600, 1000, "Fox", holes([[220, 160, 120, 150], [380, 160, 120, 150], [230, 540, 140, 110]]));
  const parts = [
    shape("Fox_Whites", 310, 150, 320, 180, "Fox", ellipse(320, 180)),
    shape("Fox_Lid_L", 470, 150, 130, 160, "Fox", ellipse(130, 160)),
    body,
  ];
  const bones = [
    { name: "Hip", joint: [400, 980] as [number, number], tip: [400, 850] as [number, number], layers: ["Fox_Body"] },
    { name: "Spine", parent: "Hip", joint: [400, 850] as [number, number], tip: [400, 600] as [number, number], layers: [] },
    { name: "Head", parent: "Spine", joint: [400, 595] as [number, number], tip: [400, 100] as [number, number], layers: [] },
    { name: "Eyes", parent: "Head", joint: [470, 240] as [number, number], layers: ["Fox_Whites"] },
    { name: "Lid_L", parent: "Head", joint: [535, 150] as [number, number], tip: [535, 310] as [number, number], layers: ["Fox_Lid_L"] },
  ];

  it("measures a joint that sits in a hole of the body (an open mouth) across the whole body, so face parts above it take nothing from the spine", () => {
    const rig = buildRig(parts, { bones, mesh: "sparse", weights: "joint", scale: 1 });
    for (const slot of ["Fox_Whites", "Fox_Lid_L"]) {
      const spine = Math.max(...weightsOf(rig, slot).map((r) => r.Spine ?? 0));
      expect(spine).toBeLessThan(0.02);
    }
    const head = weightsOf(rig, "Fox_Body").filter((r) => (r.Head ?? 0) > 0.99);
    expect(head.length).toBeGreaterThan(3);
  });
});
