import { describe, expect, it } from "vitest";
import { budgetReport } from "../src/spine/budget.js";
import { mixCheck } from "../src/spine/mix.js";
import { loadSkeletonData } from "../src/spine/runtime.js";
import type { SkeletonJson } from "../src/spine/types.js";

const ARM = { name: "arm", parent: "root", length: 100 };
const rot = (v: number, t = 0) => ({ time: t, value: v });

function mixRig(): SkeletonJson {
  return {
    skeleton: { spine: "4.3.26" },
    bones: [{ name: "root" }, ARM, { name: "hand", parent: "arm", x: 100, length: 20 }],
    slots: [],
    skins: [{ name: "default", attachments: {} }],
    animations: {
      low: { bones: { arm: { rotate: [rot(0), rot(0, 1)] } } },
      high: { bones: { arm: { rotate: [rot(90), rot(90, 1)] } } },
      base: { bones: { arm: { rotate: [rot(45), rot(45, 1)] } } },
      other: { bones: { hand: { rotate: [rot(0), rot(10, 0.5), rot(0, 1)] } } },
      // Keys the arm only from 0.5 s: over a base on track 0 it holds the base's value, then jumps.
      late: { bones: { arm: { rotate: [rot(90, 0.5), rot(90, 1)] } } },
    },
  } as unknown as SkeletonJson;
}

describe("spine_mix_check", () => {
  const doc = mixRig();
  const data = loadSkeletonData(doc);

  it("does not call a smooth mix between very different poses a pop", () => {
    const r = mixCheck(data, doc.animations!, { transitions: [{ from: "low", to: "high", mix: 0.25 }] });
    expect(r.transitions[0]!.ok).toBe(true);
  });

  it("flags a hard cut (mix 0) at the switch", () => {
    const r = mixCheck(data, doc.animations!, { transitions: [{ from: "low", to: "high", mix: 0 }] });
    const pop = r.transitions[0]!.pops[0]!;
    expect(pop.bone).toBe("hand"); // the arm's end moves 141 units in one frame
    expect(pop.phase).toBe("switch");
    expect(pop.kind).toBe("position");
  });

  it("finds the late-first-key jump on a layered track and lists the late key", () => {
    const r = mixCheck(data, doc.animations!, { track: 1, base: "base", transitions: [{ from: "other", to: "late" }] });
    expect(r.layeredPops.some((p) => p.animation === "late" && Math.abs(p.time - 0.5) < 0.02)).toBe(true);
    expect(r.lateFirstKeys).toContainEqual({ animation: "late", timeline: "bone.rotate arm", firstKey: 0.5 });
  });

  it("needs track >= 1 for a base animation", () => {
    expect(() => mixCheck(data, doc.animations!, { base: "base" })).toThrow(/track >= 1/);
  });
});

function budgetRig(): SkeletonJson {
  return {
    skeleton: { spine: "4.3.26" },
    bones: [{ name: "root" }, ARM, { name: "b2", parent: "root", x: 50 }],
    slots: [
      { name: "body", bone: "root", attachment: "body" },
      { name: "clip", bone: "root", attachment: "clip" },
      { name: "mesh", bone: "arm", attachment: "mesh" },
      { name: "glow", bone: "root", attachment: "glow", blend: "additive" },
      { name: "top", bone: "root", attachment: "top" },
    ],
    skins: [{
      name: "default",
      attachments: {
        body: { body: { width: 100, height: 50 } },
        // Concave (an L): two convex polygons.
        clip: { clip: { type: "clipping", end: "mesh", vertexCount: 6, vertices: [0, 0, 100, 0, 100, 40, 40, 40, 40, 100, 0, 100] } },
        // Weighted: vertex 0 on 2 bones, vertices 1-3 on 1 bone -> 5 vertex transforms.
        mesh: {
          mesh: {
            type: "mesh", uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 2, 3, 0], hull: 4, width: 10, height: 10,
            vertices: [2, 1, 0, 0, 0.5, 2, 0, 0, 0.5, 1, 1, 10, 0, 1, 1, 1, 10, 10, 1, 1, 1, 0, 10, 1],
          },
        },
        glow: { glow: { width: 10, height: 10 } },
        top: { top: { width: 10, height: 10 } },
      },
    }],
    animations: {
      fade: { slots: { top: { rgba: [{ color: "ffffff00" }, { time: 1, color: "ffffff00" }] } }, bones: { arm: { rotate: [rot(0), rot(30, 1)] } } },
    },
  } as unknown as SkeletonJson;
}

describe("spine_budget", () => {
  const doc = budgetRig();
  const r = budgetReport(loadSkeletonData(doc), doc.animations!, { pagesKnown: false, limits: { vertexTransforms: 10, drawCalls: 2 } });

  it("counts like Spine's Metrics view", () => {
    expect(r.setup).toMatchObject({ visibleAttachments: 4, vertices: 16, triangles: 8, vertexTransforms: 4 + 5 + 4 + 4 + 6, clippingPolygons: 2, clippedTriangles: 2 });
    // Mesh vertex 0 sits halfway between root (0,0) and b2 (50,0): the quad is (25,0) (10,0) (10,10) (0,10) = 125.
    expect(r.setup.area).toBe(5000 + 125 + 100 + 100);
    expect(r.skeleton.maxBonesPerVertex).toBe(2);
    expect(r.skeleton.attachments.byType).toMatchObject({ region: 3, clipping: 1, mesh: 1 });
  });

  it("estimates batches from blend mode changes and flags alpha-0 drawing", () => {
    expect(r.setup.drawCalls).toBe(3); // normal | additive | normal
    expect(r.setup.drawCallsPagesOnly).toBe(1); // spine-unity default materials: one page, one batch
    expect(r.worst.invisibleButDrawn).toBe(1);
    expect(r.worst.where.invisibleButDrawn).toMatch(/^fade@/);
    expect(r.findings.join("\n")).toMatch(/alpha 0/);
    expect(r.findings.join("\n")).toMatch(/Clipping is very expensive/);
  });

  it("counts static timelines and checks the given limits", () => {
    expect(r.animations[0]).toMatchObject({ name: "fade", timelines: 2, staticTimelines: 1 });
    expect(r.overBudget.join("\n")).toMatch(/vertexTransforms 23 > 10/);
    expect(r.overBudget.join("\n")).toMatch(/drawCalls 3 > 2/);
  });
});
