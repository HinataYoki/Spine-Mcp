import { describe, expect, it } from "vitest";
import { buildRig, suggestRig, type Part } from "../src/spine/autorig.js";

const shape = (name: string, left: number, top: number, width: number, height: number, group: string, inside?: (x: number, y: number) => boolean): Part => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (!inside || inside(x, y)) data.set([180, 120, 90, 255], (y * width + x) * 4);
  return { name, path: name, left, top, width, height, data, opacity: 1, group };
};

describe("auto rig on big parts", () => {
  it("suggests a rig for a large fully opaque part without running out of stack", () => {
    const parts = [shape("Big_Body", 0, 0, 1400, 1800, "Big"), shape("Big_Arm", 1300, 400, 600, 160, "Big")];
    const sug = suggestRig(parts);
    expect(sug.bones.map((b) => b.name)).toEqual(expect.arrayContaining(["Big_Body", "Big_Arm"]));
  });

  it("traces an auto mesh with inner points where the first outline offset fails, instead of ear clipping", () => {
    const slit = (x: number, y: number) => !(y < 900 && x >= 298 && x < 302) && !(y > 1000 && (x < 40 || x > 560));
    const parts = [shape("Big_Body", 0, 0, 600, 1100, "Big", slit)];
    const rig = buildRig(parts, { bones: [{ name: "Big_Body", joint: [300, 1050], layers: ["Big_Body"] }], mesh: "auto", weights: "joint", scale: 1 });
    const r = rig.report[0]!;
    expect(r.fallback).toBeUndefined();
    expect(r.mesh!.vertices).toBeGreaterThan(r.mesh!.hull + 20);
  });
});
