import { describe, expect, it } from "vitest";
import { compareMotion } from "../src/spine/compare-motion.js";
import { deriveAnimation } from "../src/spine/derive.js";
import { loadSkeletonData } from "../src/spine/runtime.js";
import { classifySegment, timingReport } from "../src/spine/timing.js";
import { loadMini } from "./helpers.js";

describe("timingReport", () => {
  it("finds key poses, intervals and eases", () => {
    const rep = timingReport("idle", loadMini().animations!.idle!);
    expect(rep.duration).toBe(2);
    expect(rep.keyPoses).toEqual([[0, 2], [1, 2], [2, 2]]);
    expect(rep.poseIntervals).toMatchObject({ min: 1, max: 1, mean: 1 });
    expect(rep.segments.byEase["ease-in-out"]).toBe(4);
    expect(rep.segments.total).toBe(4);
  });

  it("classifies linear, stepped, hold and one-sided eases", () => {
    const a = { time: 0, value: 0 }, b = { time: 1, value: 10 };
    expect(classifySegment(a, b, ["value"], 0)).toBe("linear");
    expect(classifySegment({ ...a, curve: "stepped" }, b, ["value"], 0)).toBe("stepped");
    expect(classifySegment(a, { time: 1, value: 0 }, ["value"], 0)).toBe("hold");
    expect(classifySegment({ ...a, curve: [0.42, 0, 1, 10] }, b, ["value"], 0)).toBe("ease-in");
    expect(classifySegment({ ...a, curve: [0, 0, 0.58, 10] }, b, ["value"], 0)).toBe("ease-out");
  });

  it("measures the effect of retime on pose intervals", () => {
    const slow = deriveAnimation(loadMini().animations!.idle!, [{ op: "retime", factor: 1.5 }]);
    expect(timingReport("slow", slow).poseIntervals.mean).toBeCloseTo(1.5);
  });
});

describe("compareMotion", () => {
  it("reports amplitude and duration changes of a derived variant", () => {
    const doc = loadMini();
    doc.animations!.big = deriveAnimation(doc.animations!.idle!, [{ op: "scaleValues", factor: 2, kinds: ["rotate"] }, { op: "retime", factor: 2 }]);
    const r = compareMotion(loadSkeletonData(doc), doc.animations!, "idle", "big", { fps: 30, bones: ["head", "hip"] });
    expect(r.duration).toEqual([2, 4]);
    const head = r.bones.find((b) => b.bone === "head")!;
    expect(head.rotationRange[0]).toBeCloseTo(6, 2);
    expect(head.rotationRange[1]).toBeCloseTo(12, 2);
    expect(r.timing.meanPoseInterval).toEqual([1, 2]);
  });
});
