import { describe, expect, it } from "vitest";
import { valueAt } from "../src/spine/curves.js";
import { deriveAnimationWithNotes } from "../src/spine/derive.js";
import type { AnimationJson, Key, SkeletonJson } from "../src/spine/types.js";
import { frameGridIssues } from "./helpers.js";

const skeleton: SkeletonJson = {
  skeleton: { spine: "4.3.26", fps: 30 },
  bones: [{ name: "root" }, { name: "arm", parent: "root", length: 100 }, { name: "hand", parent: "arm", x: 100, length: 30 }],
};
const baked = (): AnimationJson => ({
  bones: {
    arm: {
      rotate: Array.from({ length: 61 }, (_, f) => ({ ...(f ? { time: +(f / 30 + 0.004).toFixed(4) } : {}), value: +(20 * Math.sin((2 * Math.PI * f) / 60)).toFixed(4) })),
      scale: [{ x: 1, y: 1 }, { time: 1.0133, x: 1.0337, y: 1 }, { time: 2, x: 1, y: 1 }],
    },
    hand: { rotate: [{ value: 0 }, { time: 0.38, value: 4.1172 }, { time: 1, value: 0 }] },
  },
});
const rotateAt = (keys: Key[], t: number) => valueAt(keys, "value", 0, 0, t);

describe("derive clean", () => {
  it("fits a baked timeline with a few bezier keys on whole frames and rounds every value", () => {
    const source = baked();
    const { animation, notes } = deriveAnimationWithNotes(source, [{ op: "clean" }], { skeleton });
    const keys = animation.bones!.arm!.rotate!;
    expect(keys.length).toBeLessThanOrEqual(9);
    expect(frameGridIssues(animation as never, 30)).toEqual([]);
    for (let f = 0; f <= 60; f++) expect(Math.abs(rotateAt(keys, f / 30) - rotateAt(source.bones!.arm!.rotate!, f / 30))).toBeLessThan(1.5);
    expect(animation.bones!.hand!.rotate!.map((k) => [k.time ?? 0, k.value])).toEqual([[0, 0], [0.366667, 4], [1, 0]]);
    expect(animation.bones!.arm!.scale!.map((k) => k.x)).toEqual([1, 1.03, 1]);
    expect(notes.join(" ")).toMatch(/1 timeline\(s\) keyed on almost every frame fitted with bezier keys, 61 -> \d keys/);
    expect(notes.join(" ")).toMatch(/bones move at most [\d.]+ units from the source \(hand at/);
  });

  it("keeps the key count without thinning and only touches the bones asked for", () => {
    const { animation } = deriveAnimationWithNotes(baked(), [{ op: "clean", thin: false, bones: ["hand"] }], { skeleton });
    expect(animation.bones!.arm!.rotate!).toHaveLength(61);
    expect(animation.bones!.arm!.rotate![1]!.time).toBe(0.0373);
    expect(animation.bones!.hand!.rotate![1]).toMatchObject({ time: 0.366667, value: 4 });
  });

  it("leaves stepped timelines and clean data alone", () => {
    const anim: AnimationJson = { bones: { arm: { rotate: [{ value: 0, curve: "stepped" }, { time: 0.5, value: 10 }, { time: 1, value: 0 }] } } };
    const { animation, notes } = deriveAnimationWithNotes(anim, [{ op: "clean" }], { skeleton });
    expect(animation).toEqual(anim);
    expect(notes.join(" ")).not.toMatch(/fitted|rounded|moved onto/);
  });
});
