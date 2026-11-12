import { describe, expect, it } from "vitest";
import { bonesFromSkeleton, buildRig, checkRig, LID_OPEN_SCALE, liftFromShutLids, suggestRig, type Part } from "../src/spine/autorig.js";

const shape = (name: string, left: number, top: number, width: number, height: number, group: string, inside?: (x: number, y: number) => boolean, shut?: boolean): Part => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (!inside || inside(x, y)) data.set([180, 120, 90, 255], (y * width + x) * 4);
  return { name, path: name, left, top, width, height, data, opacity: 1, group, ...(shut ? { shut } : {}) };
};
const ellipse = (w: number, h: number) => (x: number, y: number) => ((x - w / 2) / (w / 2)) ** 2 + ((y - h / 2) / (h / 2)) ** 2 <= 1;

const hero = (dx = 0) => [
  shape("Hero_Body", 100 + dx, 100, 200, 400, "Hero"),
  shape("Hero_Eye_L", 150 + dx, 150, 30, 20, "Hero", ellipse(30, 20)),
  shape("Hero_Eye_R", 220 + dx, 150, 30, 20, "Hero", ellipse(30, 20)),
  shape("Hero_Brow_L", 150 + dx, 135, 30, 6, "Hero"),
  shape("Hero_Mouth", 170 + dx, 220, 60, 25, "Hero", ellipse(60, 25)),
  shape("Hero_Arm_L", 270 + dx, 300, 160, 40, "Hero"),
];
const pal = () => [shape("Pal_Body", 150, 40, 90, 90, "Pal", ellipse(90, 90)), shape("Pal_Hand", 250, 110, 30, 20, "Pal")];

describe("auto rig from an approved rig, riders and shut lids", () => {
  it("parents a character that sits on another to its nearest body bone with riders: true", () => {
    const parts = [...hero(), ...pal()];
    const apart = suggestRig(parts);
    expect(apart.bones.find((b) => b.name === "Pal_Body")!.parent).toBeUndefined();
    expect(apart.notes.join(" ")).toMatch(/pass riders: true/);
    const sug = suggestRig(parts, 1, { riders: true });
    const by = Object.fromEntries(sug.bones.map((b) => [b.name, b]));
    expect(by.Pal_Body!.parent).toBe("Hero_Body-head");
    for (const b of sug.bones.filter((x) => x.name.startsWith("Pal_") && !x.parent)) expect(b).toBeUndefined();
    expect(sug.notes.join(" ")).toMatch(/"Pal" rides on "Hero"/);
    const rig = buildRig(parts, { bones: sug.bones, mesh: "sparse", weights: "joint", scale: 1 });
    expect(checkRig(rig.doc, rig.expected).setupError).toBeLessThan(0.05);
  });

  it("rigs a lid drawn shut and hidden with its bone collapsed, and hangs its lash from the head instead", () => {
    const parts = [...hero(), shape("Hero_Lid_L", 150, 145, 30, 30, "Hero", ellipse(30, 30), true), shape("Hero_Lash_L", 148, 143, 34, 5, "Hero")];
    const sug = suggestRig(parts);
    const by = Object.fromEntries(sug.bones.map((b) => [b.name, b]));
    expect(by.Hero_Lash_L!.parent).toBe(by.Hero_Lid_L!.parent);
    expect(sug.notes.join(" ")).toMatch(/drawn shut and hidden/);
    const rig = buildRig(parts, { bones: sug.bones, mesh: "sparse", weights: "joint", scale: 1 });
    const lid = (rig.doc.bones as { name: string; scaleX?: number }[]).find((b) => b.name === "Hero_Lid_L")!;
    expect(lid.scaleX).toBe(LID_OPEN_SCALE);
    expect(checkRig(rig.doc, rig.expected).setupError).toBeLessThan(0.05);
  });

  it("moves bones hanging from a shut lid to the lid's parent", () => {
    const parts = [...hero(), shape("Hero_Lid_L", 150, 145, 30, 30, "Hero", ellipse(30, 30), true)];
    const bones = [
      { name: "Head", joint: [200, 260] as [number, number], layers: ["Hero_Body"] },
      { name: "Lid", parent: "Head", joint: [165, 145] as [number, number], tip: [165, 175] as [number, number], layers: ["Hero_Lid_L"] },
      { name: "LashPin", parent: "Lid", joint: [165, 150] as [number, number], layers: [] },
      { name: "Lash", parent: "LashPin", joint: [165, 150] as [number, number], layers: [] },
    ];
    const out = liftFromShutLids(bones, parts);
    expect(out.moved).toEqual(["LashPin"]);
    expect(out.bones.find((b) => b.name === "LashPin")!.parent).toBe("Head");
    expect(out.bones.find((b) => b.name === "Lash")!.parent).toBe("LashPin");
  });

  it("weights a body through a head bone that carries the face itself, as approved rigs often do", () => {
    const parts = hero();
    const bones = [
      { name: "Hip", joint: [200, 490] as [number, number], tip: [200, 380] as [number, number], layers: ["Hero_Body"] },
      { name: "Spine", parent: "Hip", joint: [200, 380] as [number, number], tip: [200, 260] as [number, number], layers: [] },
      { name: "Head", parent: "Spine", joint: [200, 260] as [number, number], tip: [200, 110] as [number, number], layers: ["Hero_Eye_L", "Hero_Eye_R", "Hero_Brow_L", "Hero_Mouth"] },
      { name: "Arm", parent: "Spine", joint: [280, 320] as [number, number], tip: [420, 320] as [number, number], layers: ["Hero_Arm_L"] },
    ];
    const rig = buildRig(parts, { bones, mesh: "sparse", weights: "joint", scale: 1 });
    expect(rig.report.find((r) => r.slot === "Hero_Body")!.weightedTo).toContain("Head");
    expect(rig.report.find((r) => r.slot === "Hero_Eye_L")!.weightedTo).toEqual(["Head"]);
    expect(checkRig(rig.doc, rig.expected).setupError).toBeLessThan(0.05);
  });

  it("runs a body's chain up its head, not into an empty arm bone, a point bone or a rider's root", () => {
    const parts = [...hero(), ...pal()];
    const bones = [
      { name: "Hip", joint: [200, 490] as [number, number], tip: [200, 380] as [number, number], layers: ["Hero_Body"] },
      { name: "Spine", parent: "Hip", joint: [200, 380] as [number, number], tip: [200, 260] as [number, number], layers: [] },
      { name: "Shoulder", parent: "Spine", joint: [270, 320] as [number, number], tip: [330, 320] as [number, number], layers: [] },
      { name: "Hand", parent: "Shoulder", joint: [330, 320] as [number, number], tip: [420, 320] as [number, number], layers: ["Hero_Arm_L"] },
      { name: "Head", parent: "Spine", joint: [200, 260] as [number, number], tip: [200, 110] as [number, number], layers: ["Hero_Eye_L", "Hero_Eye_R", "Hero_Mouth"] },
      { name: "Brow", parent: "Head", joint: [165, 138] as [number, number], layers: ["Hero_Brow_L"] },
      { name: "PalRoot", parent: "Head", joint: [195, 125] as [number, number], tip: [195, 110] as [number, number], layers: [] },
      { name: "PalBody", parent: "PalRoot", joint: [195, 110] as [number, number], tip: [195, 60] as [number, number], layers: ["Pal_Body", "Pal_Hand"] },
    ];
    const rig = buildRig(parts, { bones, mesh: "sparse", weights: "joint", scale: 1 });
    expect(new Set(rig.report.find((r) => r.slot === "Hero_Body")!.weightedTo)).toEqual(new Set(["Hip", "Spine", "Head"]));
    expect(checkRig(rig.doc, rig.expected).setupError).toBeLessThan(0.05);
  });

  it("reads an approved skeleton's joints back in the parts' pixels, wherever its canvas sits", () => {
    const sug = suggestRig(hero());
    const rig = buildRig(hero(), { bones: sug.bones, mesh: "sparse", weights: "joint", scale: 1 });
    const back = bonesFromSkeleton(rig.doc, hero(12));
    const by = Object.fromEntries(back.bones.map((b) => [b.name, b]));
    for (const b of sug.bones) {
      const got = by[b.name]!;
      expect(got.parent).toBe(b.parent);
      expect(Math.abs(got.joint[0] - (b.joint[0] + 12))).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(Math.abs(got.joint[1] - b.joint[1])).toBeLessThanOrEqual(0.5 + 1e-6);
      if (b.tip) expect(Math.hypot(got.tip![0] - b.tip[0] - 12, got.tip![1] - b.tip[1])).toBeLessThan(2);
      expect(got.layers).toEqual(b.layers);
    }
    expect(back.notes.join(" ")).toMatch(/6 of 6 parts matched/);
  });
});
