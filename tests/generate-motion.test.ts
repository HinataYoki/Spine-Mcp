import { describe, expect, it } from "vitest";
import { blink, breathe, cutWave, settle, sway, waveExtremes } from "../src/spine/generate.js";
import { samplePose } from "../src/spine/poses.js";
import { loadSkeletonData } from "../src/spine/runtime.js";
import type { AnimationJson, SkeletonJson } from "../src/spine/types.js";

const rig = (): SkeletonJson => ({
  skeleton: { spine: "4.3.26", width: 200, height: 400, fps: 30 },
  bones: [
    { name: "root" },
    { name: "hip", parent: "root", y: 100 },
    { name: "chest", parent: "hip", y: 80, rotation: 90 },
    { name: "head", parent: "chest", x: 90 },
    { name: "arm", parent: "chest", x: 60, y: -40, length: 50 },
    { name: "forearm", parent: "arm", x: 50, length: 40 },
    { name: "hand", parent: "forearm", x: 40, length: 15 },
    { name: "lid", parent: "head", x: 20 },
  ],
  slots: [{ name: "lash", bone: "lid", attachment: "lash" }],
  skins: [{ name: "default", attachments: { lash: { lash: { width: 10, height: 4 } } } }],
  animations: {},
} as unknown as SkeletonJson);

const withAnim = (doc: SkeletonJson, a: AnimationJson) => ({ ...doc, animations: { test: a } }) as SkeletonJson;
const sample = (doc: SkeletonJson, a: AnimationJson, bone: string, t: number) => samplePose(withAnim(doc, a), "test", t).bones[bone] ?? { rotate: 0, x: 0, y: 0, scaleX: 1, scaleY: 1 };

describe("motion generators", () => {
  it("cuts a wave of turning points exactly at the loop ends: same value both ends, same shape inside", () => {
    const pts = waveExtremes(2, 3, 0.7, 1, 6);
    const keys = cutWave(pts, 6);
    expect(keys[0]!.time).toBe(0);
    expect(keys[keys.length - 1]!.time).toBe(6);
    expect(keys[0]!.value).toBeCloseTo(keys[keys.length - 1]!.value, 3);
    expect(Math.max(...keys.map((k) => Math.abs(k.value)))).toBeCloseTo(2, 3);
    expect(keys.length).toBe(6);
  });

  it("breathes on a figure-eight: x at half the frequency, loop closed, followers in order and later, phase shifts it", () => {
    const doc = rig();
    const { animation: a } = breathe(doc, { torso: ["chest"], followers: ["head", "arm"], path: "figure8", period: 3, rise: 3, sway: 1.5, lag: 0.1 });
    expect(() => loadSkeletonData(withAnim(doc, a))).not.toThrow();
    const ys = Array.from({ length: 121 }, (_, i) => i * 0.05).map((t) => sample(doc, a, "chest", t));
    const at = (t: number) => sample(doc, a, "chest", t);
    expect(at(0).x).toBeCloseTo(at(6).x, 3);
    expect(at(0).y).toBeCloseTo(at(6).y, 3);
    const world = ys.map((p) => [p.x, p.y]);
    expect(Math.max(...world.map(([, y]) => Math.abs(y!)))).toBeCloseTo(3, 1);
    expect(Math.max(...world.map(([x]) => Math.abs(x!)))).toBeCloseTo(1.5, 1);
    const peak = (bone: string) => { let best = 0, when = 0; for (let t = 0; t <= 3; t += 0.01) { const r = Math.abs(sample(doc, a, bone, t).rotate); if (r > best) { best = r; when = t; } } return when; };
    expect(peak("arm")).toBeGreaterThan(peak("head"));
    const shifted = breathe(doc, { torso: ["chest"], path: "figure8", period: 3, rise: 3, sway: 1.5, phase: 0.25 }).animation;
    expect(sample(doc, shifted, "chest", 1.5).y).toBeCloseTo(sample(doc, a, "chest", 0).y, 2);
  });

  it("switches hidden slots on whole frames: off on the first frame past the threshold, back on the last frame still past it", () => {
    const doc = rig();
    const r = blink(doc, { lids: [{ bone: "lid", closed: { y: -10 } }], hide: ["lash"], blinks: [{ time: 1 }], duration: 3, closeTime: 2 / 30, holdTime: 2 / 30, openTime: 3 / 30, hideAt: 0.15 });
    const keys = (r.animation.slots!.lash!.attachment as { time?: number; name?: string }[]);
    const off = keys.find((k) => k.time !== undefined && !k.name)!.time!, on = keys.find((k) => (k.time ?? 0) > off && k.name)!.time!;
    const closure = (t: number) => sample(doc, r.animation, "lid", t).y / -10;
    for (const t of [off, on]) expect(Math.abs(t * 30 - Math.round(t * 30))).toBeLessThan(1e-4);
    expect(closure(off)).toBeGreaterThanOrEqual(0.15 - 1e-6);
    expect(closure(off - 1 / 30)).toBeLessThan(0.15);
    expect(closure(on)).toBeGreaterThanOrEqual(0.15 - 1e-6);
    expect(closure(on + 1 / 30)).toBeLessThan(0.15);
    expect(r.notes.join(" ")).toMatch(/whole frames by the lids' 15% shut point/);
  });

  it("sways a chain in whole cycles from rest: each bone later and smaller, loop closed", () => {
    const doc = rig();
    const { animation: a } = sway(doc, { bones: ["arm", "forearm", "hand"], amount: 4, period: 2, duration: 4, lag: 0.1 });
    expect(sample(doc, a, "arm", 0).rotate).toBeCloseTo(0, 3);
    for (const b of ["arm", "forearm", "hand"]) expect(sample(doc, a, b, 0).rotate).toBeCloseTo(sample(doc, a, b, 4).rotate, 2);
    const amp = (b: string) => Math.max(...Array.from({ length: 81 }, (_, i) => Math.abs(sample(doc, a, b, i * 0.05).rotate)));
    expect(amp("arm")).toBeLessThanOrEqual(4.05);
    expect(amp("forearm")).toBeLessThan(amp("arm"));
    expect((a.bones!.arm!.rotate as unknown[]).length).toBeLessThan(12);
  });

  it("settles a gesture: rest before it, decaying swings, the far joint later and smaller, back at rest", () => {
    const doc = rig();
    const { animation: a } = settle(doc, { bones: ["arm", "hand"], at: 0.5, amount: 6, swings: 5, decay: 0.7, period: 0.8, duration: 3 });
    expect(sample(doc, a, "arm", 0.4).rotate).toBeCloseTo(0, 3);
    const ext: number[] = [];
    let prev = 0, dir = 0;
    for (let t = 0.5; t < 3; t += 0.005) {
      const v = sample(doc, a, "arm", t).rotate, d = Math.sign(v - prev);
      if (dir && d && d !== dir) ext.push(Math.abs(prev));
      if (d) dir = d;
      prev = v;
    }
    expect(ext[0]!).toBeGreaterThan(4);
    expect(ext[1]! / ext[0]!).toBeGreaterThan(0.6);
    expect(ext[1]! / ext[0]!).toBeLessThanOrEqual(0.8);
    const first = (b: string) => { for (let t = 0.5; t < 2; t += 0.005) if (Math.abs(sample(doc, a, b, t).rotate) > 0.05) return t; return 9; };
    expect(first("hand")).toBeGreaterThan(first("arm") + 0.05);
    const end = Math.max(...Object.values(a.bones!).flatMap((tl) => (tl.rotate as { time?: number }[]).map((k) => k.time ?? 0)));
    expect(sample(doc, a, "arm", end).rotate).toBeCloseTo(0, 2);
    expect(sample(doc, a, "hand", end).rotate).toBeCloseTo(0, 2);
  });

  it("settles through an explicit swing pattern: the energy can come back before it decays", () => {
    const doc = rig();
    const { animation: a } = settle(doc, { bones: ["arm"], at: 0.5, amounts: [-1.3, 1.4, -1.0, 0.7], period: 1.8 });
    const ext = (a.bones!.arm!.rotate as { time?: number; value: number }[]).filter((k) => (k.time ?? 0) > 0.5 && Math.abs(k.value) > 0.05).map((k) => k.value);
    expect(ext.map((v) => +v.toFixed(1))).toEqual([-1.3, 1.4, -1, 0.7]);
  });
});
