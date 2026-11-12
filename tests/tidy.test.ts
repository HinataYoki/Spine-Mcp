import { describe, expect, it } from "vitest";
import { valueAt } from "../src/spine/curves.js";
import { fitBezier, projectFps, roundHalfAway, roundValue, snapTime, tidyAnimation } from "../src/spine/tidy.js";
import type { AnimationJson, Key } from "../src/spine/types.js";

describe("frame grid and round values", () => {
  it("rounds half away from zero, the same on both sides", () => {
    expect([2.5, -2.5, 0.5, -0.5, 1.4999].map((v) => roundHalfAway(v))).toEqual([3, -3, 1, -1, 1]);
    expect([0.145, -0.145, 1.005, -1.005].map((v) => roundHalfAway(v, 2))).toEqual([0.15, -0.15, 1.01, -1.01]);
    expect(Object.is(roundHalfAway(-0.0001), 0)).toBe(true);
  });

  it("rounds by kind: whole degrees and units (halves under 2), two decimals for scale, alpha and deform", () => {
    expect([12.37, -12.5, 1.3, -0.2, 0.3].map((v) => roundValue("angle", v))).toEqual([12, -13, 1.5, 0, 0.5]);
    expect(roundValue("translate", 29.723483999999996)).toBe(30);
    expect([1.0133, 0.98684, 1.005].map((v) => roundValue("scale", v))).toEqual([1.01, 0.99, 1.01]);
    expect(roundValue("deform", -3.14159)).toBe(-3.14);
  });

  it("snaps times to whole frames at the project fps (30 when the skeleton has none)", () => {
    expect(projectFps({ skeleton: { fps: 24 } })).toBe(24);
    expect(projectFps({ skeleton: {} })).toBe(30);
    expect(snapTime(0.38, 30)).toBe(0.366667);
    expect(snapTime(0.24, 30)).toBe(0.233333);
    expect(snapTime(0.24, 24)).toBe(0.25);
    expect(snapTime(1 / 60, 30)).toBe(0.033333);
  });

  it("moves an off-frame key onto the grid and remaps its curve's time handles into the new segment", () => {
    const anim: AnimationJson = { bones: { a: { rotate: [
      { value: 0, curve: [0.1, 0, 0.2, 10] },
      { time: 0.38, value: 10, curve: [0.5, 10, 0.7, 20] },
      { time: 0.9, value: 20 },
    ] } } };
    const { animation, stats, note } = tidyAnimation(anim, 30);
    const keys = animation.bones!.a!.rotate!;
    expect(keys.map((k) => k.time ?? 0)).toEqual([0, 0.366667, 0.9]);
    const c0 = keys[0]!.curve as number[], c1 = keys[1]!.curve as number[];
    expect(c0[0]).toBeCloseTo((0.1 * 0.366667) / 0.38, 5);
    expect(c0[2]).toBeCloseTo((0.2 * 0.366667) / 0.38, 5);
    expect(c1[0]).toBeCloseTo(0.366667 + ((0.5 - 0.38) * (0.9 - 0.366667)) / (0.9 - 0.38), 5);
    expect(c1[1]).toBe(10);
    expect(stats.snapped).toBe(1);
    expect(note).toMatch(/1 key\(s\) moved onto the 30 fps frame grid/);
    expect(anim.bones!.a!.rotate![1]!.time).toBe(0.38);
  });

  it("rounds a value and shifts the handles on both sides of the key by the same amount, so the shape is kept", () => {
    const anim: AnimationJson = { bones: { a: { translate: [
      { x: 0, y: 0, curve: [0.1, 0, 0.2, 9.6, 0.1, 0, 0.2, 0] },
      { time: 0.3, x: 9.6, y: 0.2, curve: [0.4, 9.6, 0.5, 0, 0.4, 0.2, 0.5, 0] },
      { time: 0.6, x: 0, y: 0 },
    ] } } };
    const keys = tidyAnimation(anim, 30).animation.bones!.a!.translate!;
    expect(keys[1]).toMatchObject({ x: 10, y: 0 });
    expect((keys[0]!.curve as number[])[3]).toBeCloseTo(10, 6);
    expect((keys[0]!.curve as number[])[7]).toBeCloseTo(-0.2, 6);
    expect((keys[1]!.curve as number[])[1]).toBeCloseTo(10, 6);
    expect((keys[1]!.curve as number[])[5]).toBeCloseTo(0, 6);
  });

  it("merges keys that land on the same frame (the later wins), keeps a stepped hold a frame earlier", () => {
    const merged = tidyAnimation({ bones: { a: { rotate: [{ value: 0 }, { time: 0.49, value: 4 }, { time: 0.51, value: 6 }, { time: 1, value: 0 }] } } }, 30);
    expect(merged.animation.bones!.a!.rotate!.map((k) => [k.time ?? 0, k.value])).toEqual([[0, 0], [0.5, 6], [1, 0]]);
    expect(merged.stats.merged).toBe(1);
    const jump = tidyAnimation({ bones: { a: { rotate: [{ value: 0 }, { time: 0.499, value: 30, curve: "stepped" }, { time: 0.5, value: -30 }, { time: 1, value: 0 }] } } }, 30);
    expect(jump.animation.bones!.a!.rotate!.map((k) => [k.time ?? 0, k.value, k.curve ?? null])).toEqual([[0, 0, null], [0.466667, 30, "stepped"], [0.5, -30, null], [1, 0, null]]);
  });

  it("keeps the numbers the caller gave, exactly, and leaves deform curves (0 to 1) alone", () => {
    const anim: AnimationJson = {
      bones: { a: { rotate: [{ value: 0 }, { time: 0.5, value: 0.7000000000000001 }, { time: 1, value: 3.3 }] } },
      attachments: { default: { s: { m: { deform: [{ vertices: [0.123, -4.567], curve: [0.1, 0.25, 0.2, 0.75] }, { time: 0.5, vertices: [1, 2] }] } } } },
    };
    const out = tidyAnimation(anim, 30, { keep: [0.7] }).animation;
    expect(out.bones!.a!.rotate!.map((k) => k.value)).toEqual([0, 0.7, 3]);
    const deform = out.attachments!.default!.s!.m!.deform!;
    expect(deform[0]!.vertices).toEqual([0.12, -4.57]);
    expect(deform[0]!.curve).toEqual([0.1, 0.25, 0.2, 0.75]);
  });

  it("fits a sine with few bezier keys on frames, flat at the turning points, within tolerance", () => {
    const fps = 30, times = Array.from({ length: 31 }, (_, f) => f / fps), values = times.map((t) => 20 * Math.sin(2 * Math.PI * t));
    const fit = fitBezier(times, [{ values, tol: 0.15, kind: "angle" }], { loop: true });
    expect(fit.keys.length).toBeLessThanOrEqual(7);
    expect(fit.values.every(([v]) => Number.isInteger(v))).toBe(true);
    const keys: Key[] = fit.keys.map((i, n) => ({ ...(i ? { time: times[i]! } : {}), value: fit.values[n]![0]!, ...(fit.curves[n] ? { curve: fit.curves[n]! } : {}) }));
    for (const [i, t] of times.entries()) expect(Math.abs(valueAt(keys, "value", 0, 0, t) - values[i]!)).toBeLessThan(0.15 + 0.5 + 1e-6);
    const peak = fit.keys.findIndex((i) => Math.abs(values[i]!) > 19);
    expect(fit.curves[peak]![1]).toBeCloseTo(fit.values[peak]![0]!, 6);
  });
});
