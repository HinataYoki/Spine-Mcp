import { describe, expect, it } from "vitest";
import { valueAt } from "../src/spine/curves.js";
import { deriveAnimation, deriveAnimationWithNotes } from "../src/spine/derive.js";
import { animationDuration } from "../src/spine/inspect.js";
import { measureMotion } from "../src/spine/measure.js";
import { loadSkeletonData } from "../src/spine/runtime.js";
import { sampleAnimation } from "../src/spine/sample.js";
import { validateSkeleton } from "../src/spine/validate.js";
import { loadMini } from "./helpers.js";

const idle = () => loadMini().animations!.idle!;

function measureHead(anim = idle()) {
  const doc = loadMini();
  doc.animations!.v = anim;
  const data = loadSkeletonData(doc);
  return measureMotion(sampleAnimation(data, "v", { fps: 30, bones: ["head"] })).bones[0]!;
}

describe("deriveAnimation", () => {
  it("scales rotate values and their curve handles together", () => {
    const out = deriveAnimation(idle(), [{ op: "scaleValues", factor: 2, kinds: ["rotate"] }]);
    const keys = out.bones!.head!.rotate!;
    expect(keys[1]!.value).toBe(12);
    expect(keys[1]!.curve).toEqual([1.333, 12, 1.667, 0]);
    expect(measureHead(out).rotation.max).toBeCloseTo(12, 3);
    // Source is untouched.
    expect(idle().bones!.head!.rotate![1]!.value).toBe(6);
  });

  it("scales around the neutral value for scale timelines", () => {
    const a = idle();
    a.bones!.head!.scale = [{ x: 1.2, y: 0.8, curve: [0.5, 1.2, 0.5, 1.2, 0.5, 0.8, 0.5, 0.8] }, { time: 1 }];
    const out = deriveAnimation(a, [{ op: "scaleValues", factor: 0.5, kinds: ["scale"] }]);
    expect(out.bones!.head!.scale![0]).toMatchObject({ x: 1.1, y: 0.9 });
    expect(out.bones!.head!.scale![0]!.curve).toEqual([0.5, 1.1, 0.5, 1.1, 0.5, 0.9, 0.5, 0.9]);
  });

  it("retimes keys and curve time handles, keeping a valid skeleton", () => {
    const out = deriveAnimation(idle(), [{ op: "retime", factor: 1.5 }]);
    expect(animationDuration(out)).toBeCloseTo(3);
    const curve = out.bones!.head!.rotate![0]!.curve as number[];
    [0.4995, 0, 1.0005, 6].forEach((v, i) => expect(curve[i]).toBeCloseTo(v, 9));
    expect(out.events![0]!.time).toBeCloseTo(1.5);
    const doc = loadMini();
    doc.animations!.slow = out;
    expect(validateSkeleton(doc).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("keeps or drops bone timelines", () => {
    expect(Object.keys(deriveAnimation(idle(), [{ op: "keepBones", bones: ["head"] }]).bones!)).toEqual(["head"]);
    expect(Object.keys(deriveAnimation(idle(), [{ op: "dropBones", bones: ["head"] }]).bones!)).toEqual(["hip"]);
  });

  it("rejects invalid factors", () => {
    expect(() => deriveAnimation(idle(), [{ op: "retime", factor: 0 }])).toThrow();
  });
});

describe("deriveAnimation timing ops (verified by sampling with spine-core)", () => {
  const sampleLocal = (anim: ReturnType<typeof idle>, bone: string, field: "rotation" | "y" = "rotation") => {
    const doc = loadMini();
    doc.animations!.v = anim;
    const s = sampleAnimation(loadSkeletonData(doc), "v", { fps: 30, bones: [bone], warmupLoops: 0 });
    return s.samples.map((row) => row[0]!.local[field]);
  };

  it("offsetBones with wrap rotates the motion around the loop exactly", () => {
    const src = sampleLocal(idle(), "head");
    const out = deriveAnimation(idle(), [{ op: "offsetBones", bones: ["head"], seconds: 0.5 }]);
    const got = sampleLocal(out, "head");
    expect(animationDuration(out)).toBeCloseTo(2);
    const n = src.length - 1; // last sample wraps to frame 0
    for (let f = 0; f < n; f++) expect(got[f]!).toBeCloseTo(src[(f - 15 + n) % n]!, 1);
    // Other bones are untouched.
    expect(out.bones!.hip).toEqual(idle().bones!.hip);
  });

  it("offsetBones handles two-channel timelines and negative offsets", () => {
    const src = sampleLocal(idle(), "hip", "y");
    const got = sampleLocal(deriveAnimation(idle(), [{ op: "offsetBones", bones: ["hip"], seconds: -0.3 }]), "hip", "y");
    const n = src.length - 1;
    for (let f = 0; f < n; f++) expect(got[f]!).toBeCloseTo(src[(f + 9) % n]!, 1);
  });

  it("offsetBones without wrap delays the keys by whole frames", () => {
    const out = deriveAnimation(idle(), [{ op: "offsetBones", bones: ["head"], seconds: 0.3, wrap: false }]);
    expect(out.bones!.head!.rotate!.map((k) => k.time)).toEqual([0.3, 1.3, 2.3]);
    const half = deriveAnimationWithNotes(idle(), [{ op: "offsetBones", bones: ["head"], seconds: 0.25, wrap: false }]);
    expect(half.animation.bones!.head!.rotate!.map((k) => k.time)).toEqual([0.266667, 1.266667, 2.266667]);
    expect(half.notes.join(" ")).toMatch(/0\.25s shifted by 0\.266667s, whole frames at 30 fps/);
  });

  it("loopFix removes the seam pop", () => {
    const bad = loadMini().animations!["bad-loop"]!;
    const doc = loadMini();
    doc.animations!.fixed = deriveAnimation(bad, [{ op: "loopFix" }]);
    const data = loadSkeletonData(doc);
    const before = measureMotion(sampleAnimation(data, "bad-loop", { fps: 30, bones: ["head"] })).bones[0]!;
    const after = measureMotion(sampleAnimation(data, "fixed", { fps: 30, bones: ["head"] })).bones[0]!;
    expect(before.seam.ratio).toBeGreaterThan(10);
    expect(after.seam.ratio).toBeLessThan(1.5);
    expect(doc.animations!.fixed!.bones!.head!.rotate!.at(-1)!.value).toBe(0);
  });

  it("ease replaces segment curves", () => {
    const bad = loadMini().animations!["bad-loop"]!;
    const eased = deriveAnimation(bad, [{ op: "ease", easing: "easeInOut" }]);
    const keys = eased.bones!.head!.rotate!;
    expect(keys[0]!.curve).toEqual([0.21, 0, 0.29, 10]);
    expect(keys.at(-1)!.curve).toBeUndefined();
    const values = sampleLocal(eased, "head");
    expect(values[2]!).toBeLessThan(10 * (2 / 15)); // slow in
    expect(values[15]!).toBeCloseTo(10, 3);
    expect(deriveAnimation(bad, [{ op: "ease", easing: "stepped" }]).bones!.head!.rotate![0]!.curve).toBe("stepped");
    expect(() => deriveAnimation(bad, [{ op: "ease", easing: "bouncy" }])).toThrow(/Unknown easing/);
  });
});

describe("deriveAnimation review regressions", () => {
  it("uses the current duration after retime (loopFix / offset do not truncate)", () => {
    const out = deriveAnimation(idle(), [{ op: "retime", factor: 2 }, { op: "loopFix" }]);
    const head = out.bones!.head!.rotate!;
    expect(head.map((k) => k.time ?? 0)).toEqual([0, 2, 4]);
    expect(head[1]!.value).toBe(6);
    const off = deriveAnimation(idle(), [{ op: "retime", factor: 2 }, { op: "offsetBones", bones: ["head"], seconds: 0.5 }]);
    const times = off.bones!.head!.rotate!.map((k) => k.time ?? 0);
    expect(new Set(times).size).toBe(times.length);
    expect(Math.max(...times)).toBeCloseTo(4);
  });

  it("loopFix keeps whole turns of a continuous spin", () => {
    const spin = { bones: { head: { rotate: [{ value: 0 }, { time: 1, value: 360 }] } } };
    expect(deriveAnimation(spin, [{ op: "loopFix" }]).bones!.head!.rotate![1]!.value).toBe(360);
    const off = { bones: { head: { rotate: [{ value: 0 }, { time: 1, value: 370 }] } } };
    expect(deriveAnimation(off, [{ op: "loopFix" }]).bones!.head!.rotate![1]!.value).toBe(360);
  });

  it("offset with wrap keeps a seam jump instead of ramping (non-seamless source)", () => {
    // Keys only between 0.5 and 1.5; duration 2 comes from an event. Value holds 0 before, 10 after.
    const src = { bones: { head: { rotate: [{ time: 0.5, value: 0 }, { time: 1.5, value: 10 }] } }, events: [{ time: 2, name: "step" }] };
    const out = deriveAnimation(src, [{ op: "offsetBones", bones: ["head"], seconds: 0.5 }]);
    const keys = out.bones!.head!.rotate!;
    // original(t - 0.5): t in (0, 0.5) maps to 1.5..2 where the value holds 10.
    for (const t of [0.1, 0.25, 0.4]) expect(valueAtHead(keys, t)).toBeCloseTo(10, 6);
    expect(valueAtHead(keys, 0.75)).toBeCloseTo(0, 6);
    expect(valueAtHead(keys, 2)).toBeCloseTo(10, 6);
  });

  it("retime scales sequence delays", () => {
    const seq = { attachments: { default: { eyes: { "eyes-open": { sequence: [{ mode: "loop", delay: 0.1 }, { time: 1, mode: "loop", delay: 0.1 }] } } } } };
    const out = deriveAnimation(seq as never, [{ op: "retime", factor: 2 }]);
    const keys = (out as typeof seq).attachments.default.eyes["eyes-open"].sequence;
    expect(keys.map((k) => k.delay)).toEqual([0.2, 0.2]);
    expect(keys[1]!.time).toBe(2);
  });
});

function valueAtHead(keys: { time?: number; value?: number; curve?: unknown }[], t: number) {
  return valueAt(keys as never, "value", 0, 0, t);
}
