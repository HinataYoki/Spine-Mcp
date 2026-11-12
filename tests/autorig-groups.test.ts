import { describe, expect, it } from "vitest";
import { buildRig, suggestRig, type Part } from "../src/spine/autorig.js";

const shape = (name: string, left: number, top: number, width: number, height: number, group?: string, inside?: (x: number, y: number) => boolean): Part => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (!inside || inside(x, y)) data.set([180, 120, 90, 255], (y * width + x) * 4);
  return { name, path: name, left, top, width, height, data, opacity: 1, ...(group ? { group } : {}) };
};
const ellipse = (w: number, h: number) => (x: number, y: number) => ((x - w / 2) / (w / 2)) ** 2 + ((y - h / 2) / (h / 2)) ** 2 <= 1;

const hero = (g = "Hero") => [
  shape(`${g}_Body`, 100, 100, 200, 400, g),
  shape(`${g}_Eye_L`, 150, 150, 30, 20, g, ellipse(30, 20)),
  shape(`${g}_Eye_R`, 220, 150, 30, 20, g, ellipse(30, 20)),
  shape(`${g}_Pupil_L`, 160, 155, 10, 10, g, ellipse(10, 10)),
  shape(`${g}_Brow_L`, 150, 135, 30, 6, g),
  shape(`${g}_Mouth`, 170, 220, 60, 25, g, ellipse(60, 25)),
  shape(`${g}_Arm_L`, 270, 300, 160, 40, g),
];
const parentOf = (bones: { name: string; parent?: string }[]) => Object.fromEntries(bones.map((b) => [b.name, b.parent ?? null]));

describe("auto rig for painted characters", () => {
  it("keeps character groups apart, picks each body by name and hangs details on the part they lie on", () => {
    const sidekick = [shape("Pal_Body", 260, 60, 120, 120, "Pal"), shape("Pal_Head", 270, 0, 100, 80, "Pal", ellipse(100, 80))];
    const sug = suggestRig([...hero(), ...sidekick]);
    const p = parentOf(sug.bones);
    expect(p.Hero_Body).toBeNull();
    expect(p.Pal_Body).toBeNull();
    expect(p.Pal_Head).toBe("Pal_Body");
    for (const [child, parent] of Object.entries(p)) if (parent && !parent.startsWith("Hero_Body-")) expect(child.split("_")[0]).toBe(parent.split("_")[0]);
    expect(p.Hero_Pupil_L).toBe("Hero_Body-head");
    expect(p.Hero_Brow_L).toBe("Hero_Body-head");
    expect(sug.notes.join(" ")).toMatch(/one per character group/);
    expect(sug.notes.join(" ")).toMatch(/"Pal" overlaps "Hero_Body"/);
    expect(sug.ik).toEqual([]);
  });

  it("puts a spine and a head bone inside a body that carries the face, the head joint below the lowest face part", () => {
    const sug = suggestRig(hero());
    const b = Object.fromEntries(sug.bones.map((x) => [x.name, x]));
    expect(b["Hero_Body-spine"]!.parent).toBe("Hero_Body");
    expect(b["Hero_Body-head"]!.parent).toBe("Hero_Body-spine");
    expect(b["Hero_Body-head"]!.layers).toEqual([]);
    expect(b["Hero_Body-head"]!.joint[1]).toBeGreaterThan(245);
    expect(b["Hero_Body-head"]!.joint[1]).toBeLessThan(b["Hero_Body-spine"]!.joint[1]);
    expect(b.Hero_Body!.joint[1]).toBeGreaterThan(450);
    expect(b.Hero_Mouth!.parent).toBe("Hero_Body-head");
    expect(b.Hero_Mouth!.tip).toBeUndefined();
    expect(b.Hero_Arm_L!.parent).toBe("Hero_Body-spine");
  });

  it("weights a body along its inner chain, 50 % on each joint, and gives a face part the weights of the mesh under it", () => {
    const parts = hero();
    const sug = suggestRig(parts);
    const rig = buildRig(parts, { bones: sug.bones, mesh: "sparse", weights: "joint", scale: 1 });
    const bones = (rig.doc.bones as { name: string }[]).map((x) => x.name);
    const weightsOf = (slot: string) => {
      const a = (rig.doc.skins![0]!.attachments as Record<string, Record<string, { vertices: number[]; uvs: number[] }>>)[slot]![slot]!;
      const out: Record<string, number>[] = [];
      for (let i = 0; i < a.vertices.length;) { const n = a.vertices[i++]!, row: Record<string, number> = {}; for (let k = 0; k < n; k++) { row[bones[a.vertices[i]!]!] = a.vertices[i + 3]!; i += 4; } out.push(row); }
      return out;
    };
    const body = weightsOf("Hero_Body");
    expect(new Set(body.flatMap((r) => Object.keys(r)))).toEqual(new Set(["Hero_Body", "Hero_Body-spine", "Hero_Body-head"]));
    for (const r of body) { expect(Object.keys(r).length).toBeLessThanOrEqual(3); expect(Object.values(r).reduce((s, v) => s + v, 0)).toBeCloseTo(1, 3); }
    const mid = body.filter((r) => r["Hero_Body"] !== undefined && r["Hero_Body-spine"] !== undefined && Math.abs(r["Hero_Body"]! - 0.5) < 0.02);
    expect(mid.length).toBeGreaterThan(0);
    const mouth = rig.report.find((r) => r.slot === "Hero_Mouth")!;
    expect(mouth.weightedTo).toContain("Hero_Mouth");
    expect(mouth.weightedTo).not.toContain("Hero_Body-head");
    const eye = rig.report.find((r) => r.slot === "Hero_Eye_L")!;
    expect(eye.mesh!.vertices).toBeLessThan(buildRig(parts, { bones: sug.bones, mesh: "auto", weights: "joint", scale: 1 }).report.find((r) => r.slot === "Hero_Eye_L")!.mesh!.vertices + 1);
  });

  it("builds brows to be touched later: a bone at the inner end, an outer bone at the middle, weights across both", () => {
    const parts = [...hero(), shape("Hero_Brow_R", 220, 135, 30, 6, "Hero")];
    const sug = suggestRig(parts);
    const b = Object.fromEntries(sug.bones.map((x) => [x.name, x]));
    expect(b["Hero_Brow_L-outer"]!.parent).toBe("Hero_Brow_L");
    expect(b["Hero_Brow_L-outer"]!.layers).toEqual([]);
    expect(b.Hero_Brow_L!.joint[0]).toBeGreaterThan(170);
    expect(b["Hero_Brow_L-outer"]!.tip![0]).toBeLessThan(160);
    expect(b.Hero_Brow_R!.joint[0]).toBeLessThan(230);
    expect(b["Hero_Brow_R-outer"]!.tip![0]).toBeGreaterThan(240);
    expect(sug.notes.join(" ")).toMatch(/touched later/);
    const rig = buildRig(parts, { bones: sug.bones, mesh: "sparse", weights: "joint", scale: 1 });
    const brow = rig.report.find((r) => r.slot === "Hero_Brow_L")!;
    expect(new Set(brow.weightedTo)).toEqual(new Set(["Hero_Brow_L", "Hero_Brow_L-outer"]));
  });

  it("pivots a lid at the top end of its eye's axis and hangs a lash on its lid", () => {
    const parts = [...hero(), shape("Hero_Lid_L", 150, 145, 30, 30, "Hero", ellipse(30, 30)), shape("Hero_Lash_L", 148, 143, 34, 5, "Hero")];
    const b = Object.fromEntries(suggestRig(parts).bones.map((x) => [x.name, x]));
    expect(b.Hero_Lid_L!.joint[1]).toBeLessThan(149);
    expect(b.Hero_Lid_L!.tip![1]).toBeGreaterThan(171);
    expect(b.Hero_Lash_L!.parent).toBe("Hero_Lid_L");
  });

  it("leaves rigs without groups or face parts as before: no inner bones", () => {
    const sug = suggestRig([shape("torso", 100, 100, 100, 200), shape("arm", 180, 120, 120, 30)]);
    expect(sug.bones.map((b) => b.name).sort()).toEqual(["arm", "torso"]);
  });
});
