import { describe, expect, it } from "vitest";
import { gaze } from "../src/spine/face.js";
import { breathe, restCost } from "../src/spine/generate.js";
import { loadSkeletonData, spine } from "../src/spine/runtime.js";
import type { AnimationJson, SkeletonJson } from "../src/spine/types.js";

const rig = (): SkeletonJson => ({
  skeleton: { spine: "4.3.26", height: 800, fps: 30 },
  bones: [
    { name: "root" },
    { name: "Hip", parent: "root", rotation: 90, length: 150 },
    { name: "Chest", parent: "Hip", x: 150, length: 200 },
    { name: "Head", parent: "Chest", x: 200, length: 200 },
    { name: "Arm", parent: "Chest", x: 150, y: -60, rotation: -120, length: 180 },
    { name: "Brow_L", parent: "Head", x: 150, y: -40, rotation: -90, length: 10 },
    { name: "Brow_L-outer", parent: "Brow_L", x: 10, length: 10 },
    { name: "Pupils", parent: "Head", x: 120 },
  ],
  slots: [],
  skins: [{ name: "default", attachments: {} }],
  animations: {},
} as unknown as SkeletonJson);

const sample = (doc: SkeletonJson, anim: AnimationJson, t: number) => {
  const data = loadSkeletonData({ ...doc, animations: { a: anim } });
  const sk = new spine.Skeleton(data);
  sk.setupPose();
  data.findAnimation("a")!.apply(sk, t, t, false, null, 1, spine.MixFrom.setup, false, false, false);
  sk.updateWorldTransform(spine.Physics.none);
  const at = (n: string) => sk.findBone(n)!.appliedPose;
  return { y: at("Brow_L").worldY, tipY: at("Brow_L-outer").worldY + at("Brow_L-outer").c * 10 };
};

describe("face motion generators", () => {
  it("starts a figure-eight breath with followers nearest the setup pose with restStart", () => {
    const doc = rig();
    const o = { torso: ["Chest"], followers: ["Head", "Arm"], path: "figure8" as const, period: 3, rise: 3, sway: 1.5 };
    const best = breathe(doc, { ...o, restStart: true });
    const cost = restCost(doc, best.animation);
    for (const phase of [0, 0.1, 0.25, 0.5, 0.75, 0.9]) expect(cost).toBeLessThanOrEqual(restCost(doc, breathe(doc, { ...o, phase }).animation) + 1e-6);
    expect(cost).toBeLessThan(restCost(doc, breathe(doc, { ...o, phase: 0 }).animation));
    expect(best.notes.join(" ")).toMatch(/Rest start: phase/);
  });

  it("lifts and arches the brows on a look away, dips them on a blink, and rests at the loop's ends", () => {
    const doc = rig();
    const r = gaze(doc, { bones: ["Pupils"], fixations: [{ time: 0.5, x: 3, y: 1 }, { time: 1.5, x: 0, y: 0 }], duration: 3, dart: 2 / 30, brows: { bones: ["Brow_L"], lift: 2, arch: 5, dips: [2.2] } });
    const rest = sample(doc, r.animation, 0);
    const look = sample(doc, r.animation, 1.0);
    expect(look.y - rest.y).toBeCloseTo(2, 2);
    expect(look.tipY - look.y).toBeGreaterThan(rest.tipY - rest.y + 0.5);
    const shut = sample(doc, r.animation, 2.2 + 3 / 30);
    expect(shut.y - rest.y).toBeCloseTo(-2, 2);
    expect(sample(doc, r.animation, 3).y).toBeCloseTo(rest.y, 3);
    expect(r.notes.join(" ")).toMatch(/Brows \(Brow_L\): up 2/);
  });
});
