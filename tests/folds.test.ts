// Mesh folds: triangles turned over against the setup pose, in animations and under a stress turn of each bone.
import { describe, expect, it } from "vitest";
import { animationFolds, foldIssues, stressFolds, stressStretch } from "../src/spine/folds.js";
import { rigQa } from "../src/spine/rigqa.js";
import { loadSkeletonData } from "../src/spine/runtime.js";
import type { SkeletonJson } from "../src/spine/types.js";
import { validateSkeleton } from "../src/spine/validate.js";

/**
 * An arm: a 200 x 20 strip, four quads, on bones upper (0..100) and lower (100..200). Columns at x 0, 50, 100 belong
 * to upper, 150 and 200 to lower (a hard step at the elbow). Optionally a patch drawn over the elbow.
 */
function arm(o: { cover?: boolean } = {}): SkeletonJson {
  const xs = [0, 50, 100, 150, 200];
  const vertices: number[] = [], uvs: number[] = [];
  for (const y of [10, -10]) for (const x of xs) {
    vertices.push(1, x <= 100 ? 1 : 2, x <= 100 ? x : x - 100, y, 1);
    uvs.push(x / 200, y > 0 ? 0 : 1);
  }
  const triangles: number[] = [];
  for (let i = 0; i < 4; i++) triangles.push(i, i + 1, i + 5, i + 1, i + 6, i + 5);
  return {
    skeleton: { spine: "4.3.26" },
    bones: [{ name: "root" }, { name: "upper", parent: "root", length: 100 }, { name: "lower", parent: "upper", x: 100, length: 100 }],
    slots: [{ name: "arm", bone: "root", attachment: "arm" }, ...(o.cover ? [{ name: "patch", bone: "upper", attachment: "patch" }] : [])],
    skins: [{ name: "default", attachments: {
      arm: { arm: { type: "mesh", uvs, triangles, vertices, hull: 10, width: 200, height: 20 } },
      ...(o.cover ? { patch: { patch: { x: 100, y: 0, width: 160, height: 160 } } } : {}),
    } }],
    animations: {
      // The elbow bends past the strip's thickness: a triangle of the quad between x 100 and 150 turns over.
      bend: { bones: { lower: { rotate: [{ value: 0 }, { time: 1, value: 150 }] } } },
      gentle: { bones: { lower: { rotate: [{ value: 0 }, { time: 1, value: 20 }] } } },
      mirror: { bones: { upper: { scale: [{ x: -1, y: 1 }] } } },
      flatten: { bones: { upper: { scale: [{ x: 1, y: 1 }, { time: 1, x: 1, y: -0.1 }] }, lower: { scale: [{ x: 1, y: 1 }, { time: 1, x: 1, y: -0.1 }] } } },
    },
  } as unknown as SkeletonJson;
}

describe("mesh folds in animations", () => {
  it("finds the elbow quad turning over, and leaves gentle bends, mirrors and edge-on squashes alone", () => {
    const doc = arm();
    const data = loadSkeletonData(doc);
    const [fold] = animationFolds(data, data.findAnimation("bend")!);
    expect(fold).toMatchObject({ slot: "arm", attachment: "arm", triangles: 1, of: 8, covered: false });
    expect(fold!.areaPercent).toBeCloseTo(12.5, 1);
    expect(fold!.time).toBeGreaterThan(0.5);
    for (const n of ["gentle", "mirror", "flatten"]) expect(animationFolds(data, data.findAnimation(n)!), n).toEqual([]);
    const issues = validateSkeleton(doc, {}).filter((i) => i.code.startsWith("mesh-fold"));
    expect(issues.map((i) => [i.code, i.where])).toEqual([["mesh-fold", "animations/bend"]]);
    expect(issues[0]!.message).toMatch(/arm\/arm folds over itself at .*1 of 8 triangles turn over \(12.5% of its area\)/);
  });

  it("calls a fold hidden when a part drawn later covers it, and lists it as minor", () => {
    const data = loadSkeletonData(arm({ cover: true }));
    const anim = data.findAnimation("bend")!;
    expect(animationFolds(data, anim)[0]).toMatchObject({ covered: true });
    expect(foldIssues(data, anim)).toEqual([{ severity: "info", code: "mesh-fold-minor", message: expect.stringMatching(/arm\/arm 12.5% at .*under a part drawn later/) }]);
  });

  it("checks meshes in every skin, once each: a part skin past the sixth and its copy in a composite skin", () => {
    const doc = arm();
    const mesh = (doc.skins![0]!.attachments as Record<string, Record<string, unknown>>).arm!.arm!;
    // Eight skins before the one holding the arm, then a composite skin with its own copy of it.
    doc.skins = [{ name: "default", attachments: {} }, ...Array.from({ length: 8 }, (_, i) => ({ name: `other/${i}`, attachments: {} })),
      { name: "parts/arm", attachments: { arm: { arm: mesh } } }, { name: "full/hero", attachments: { arm: { arm: structuredClone(mesh) } } }] as never;
    const data = loadSkeletonData(doc);
    expect(animationFolds(data, data.findAnimation("bend")!).map((f) => `${f.skin}/${f.slot}/${f.attachment}`)).toEqual(["parts/arm/arm/arm"]);
  });

  it("tells apart two skins' different meshes under one placeholder, and stress-tests meshes outside the default skin", () => {
    const doc = arm();
    const mesh = (doc.skins![0]!.attachments as Record<string, Record<string, { vertices: number[] }>>).arm!.arm!;
    // red: the same strip weighted to the upper bone only (rigid, never folds); blue: the elbow step.
    const rigid = structuredClone(mesh);
    for (let i = 0; i < rigid.vertices.length; i += 5) if (rigid.vertices[i + 1] === 2) { rigid.vertices[i + 1] = 1; rigid.vertices[i + 2]! += 100; }
    doc.skins = [{ name: "default", attachments: {} }, { name: "red", attachments: { arm: { arm: rigid } } }, { name: "blue", attachments: { arm: { arm: mesh } } }] as never;
    const data = loadSkeletonData(doc);
    expect(animationFolds(data, data.findAnimation("bend")!).map((f) => f.skin)).toEqual(["blue"]);
    expect(stressFolds(data).map((s) => s.bone)).toEqual(["lower"]);
  });
});

/**
 * A three-bone arm along x: upper (0..100), elbow (100..140), hand (140..200); a 200 x 20 strip with columns every 20
 * (10 over the elbow bone). `forearm` decides who the columns over the elbow bone (x 110..130) follow: "elbow" (a clean
 * chain) or "upper" (left on its parent, as when a joint is added to an existing mesh).
 */
function chain(forearm: "elbow" | "upper"): SkeletonJson {
  const xs = [0, 20, 40, 60, 80, 100, 110, 120, 130, 140, 160, 180, 200];
  const bones: [number, number][] = [[1, 0], [2, 100], [3, 140]];
  const owner = (x: number) => (x <= 100 ? 0 : x < 140 ? (forearm === "elbow" ? 1 : 0) : 2);
  const vertices: number[] = [], uvs: number[] = [];
  for (const y of [10, -10]) for (const x of xs) {
    const [b, ox] = bones[owner(x)]!;
    vertices.push(1, b, x - ox, y, 1);
    uvs.push(x / 200, y > 0 ? 0 : 1);
  }
  const n = xs.length, triangles: number[] = [];
  for (let i = 0; i < n - 1; i++) triangles.push(i, i + 1, i + n, i + 1, i + n + 1, i + n);
  return {
    skeleton: { spine: "4.3.26" },
    bones: [{ name: "root" }, { name: "upper", parent: "root", length: 100 }, { name: "elbow", parent: "upper", x: 100, length: 40 },
      { name: "hand", parent: "elbow", x: 40, length: 60 }],
    slots: [{ name: "arm", bone: "root", attachment: "arm" }],
    skins: [{ name: "default", attachments: { arm: { arm: { type: "mesh", uvs, triangles, vertices, hull: 2 * n, width: 200, height: 20 } } } }],
  } as unknown as SkeletonJson;
}

describe("weight stretch test", () => {
  it("names the vertices along a bone that stay on its parent, and passes the clean chain", () => {
    const [s, ...rest] = stressStretch(loadSkeletonData(chain("upper")));
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ bone: "elbow", degrees: 10 });
    // Columns 120 and 130 lie past the elbow's pivot zone (x 114) on its segment: 2 columns x 2 rows.
    expect(s!.attachments[0]).toMatchObject({ slot: "arm", attachment: "arm", along: 4, alongBones: ["upper"] });
    expect(s!.attachments[0]!.stretchPercent).toBeGreaterThan(15);
    expect(stressStretch(loadSkeletonData(chain("elbow")))).toEqual([]);
    const qa = rigQa(chain("upper")).findings.find((f) => f.code === "stretch-prone-weights")!;
    expect(qa.items![0]).toMatch(/^elbow: arm \d+(\.\d)?% \(4 vertices along it weighted to upper\)$/);
    expect(rigQa(chain("elbow")).findings.some((f) => f.code === "stretch-prone-weights")).toBe(false);
  });

  it("counts vertices on a bone a constraint drives from the turned one as following it", () => {
    // A twist helper outside the elbow's hierarchy, driven by it, carries the forearm's vertices; the hand's are left
    // on the upper arm (a real stretch, so the elbow turn is measured at all).
    const doc = chain("elbow") as unknown as { bones: { name: string; parent?: string; x?: number; length?: number }[]; skins: { attachments: { arm: { arm: { vertices: number[] } } } }[]; constraints?: unknown[] };
    doc.bones.push({ name: "twist", parent: "root", x: 100 }); // helpers have no length
    doc.constraints = [{ type: "transform", name: "twist-follow", bones: ["twist"], source: "elbow", properties: { rotate: { to: { rotate: { max: 360 } } } } }];
    const v = doc.skins[0]!.attachments.arm.arm.vertices, twist = doc.bones.findIndex((b) => b.name === "twist");
    const xs = [0, 20, 40, 60, 80, 100, 110, 120, 130, 140, 160, 180, 200];
    for (let k = 0; k < xs.length * 2; k++) {
      const x = xs[k % xs.length]!, o = k * 5;
      if (x >= 110 && x <= 130) { v[o + 1] = twist; v[o + 2] = x - 100; }
      if (x >= 160) { v[o + 1] = 1; v[o + 2] = x; }
    }
    const found = stressStretch(loadSkeletonData(doc as unknown as SkeletonJson));
    expect(found.flatMap((f) => f.attachments.flatMap((a) => a.alongBones))).not.toContain("twist");
  });
});

describe("weight stress test", () => {
  it("turns each weighting bone until a mesh folds, and reports it in rig QA", () => {
    const doc = arm();
    const s = stressFolds(loadSkeletonData(doc));
    expect(s.map((x) => x.bone)).toEqual(["lower"]);
    expect(s[0]!.degrees).toBeGreaterThanOrEqual(30);
    expect(s[0]!.attachments[0]).toMatchObject({ slot: "arm", attachment: "arm", triangles: expect.any(Number) });
    const qa = rigQa(doc).findings.find((f) => f.code === "fold-prone-weights")!;
    expect(qa.items![0]).toMatch(new RegExp(`^lower at ${s[0]!.degrees}°: arm \\d`));
  });
});
