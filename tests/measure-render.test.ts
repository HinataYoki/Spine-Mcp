import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { angleDelta, measureMotion } from "../src/spine/measure.js";
import { contactSheet, pickEven } from "../src/spine/render.js";
import { loadSkeletonData } from "../src/spine/runtime.js";
import { sampleAnimation } from "../src/spine/sample.js";
import { loadMini } from "./helpers.js";

describe("sampleAnimation + measureMotion", () => {
  const data = loadSkeletonData(loadMini(), "mini");

  it("samples every frame including the wrapped end frame", () => {
    const s = sampleAnimation(data, "idle", { fps: 30, bones: ["head", "hip"] });
    expect(s.frames).toBe(61);
    expect(s.nanFrames).toEqual([]);
    expect(s.warmupLoops).toBe(1); // skeleton has a physics constraint
    expect(s.bounds.maxY).toBeGreaterThan(s.bounds.minY);
  });

  it("measures the keyed head rotation range", () => {
    const r = measureMotion(sampleAnimation(data, "idle", { fps: 30, bones: ["head"] }));
    const head = r.bones[0]!;
    expect(head.rotation.min).toBeCloseTo(0, 3);
    expect(head.rotation.max).toBeCloseTo(6, 3);
    expect(head.seam.ratio).toBeLessThan(2);
  });

  it("detects the seam jump of a non-looping key layout", () => {
    const r = measureMotion(sampleAnimation(data, "bad-loop", { fps: 30, bones: ["head"] }));
    // Last sampled frame before the wrap is at 29/30 s: 19.33 deg, then the loop snaps back to 0.
    expect(r.bones[0]!.seam.rotation).toBeCloseTo(19.333, 2);
    expect(r.bones[0]!.seam.ratio).toBeGreaterThan(10);
  });

  it("finds holds on bones that do not move", () => {
    const r = measureMotion(sampleAnimation(data, "bad-loop", { fps: 30, bones: ["hip"] }));
    expect(r.bones[0]!.moving).toBe(false);
    expect(r.bones[0]!.holds.length).toBeGreaterThan(0);
  });

  it("rejects unknown names", () => {
    expect(() => sampleAnimation(data, "nope")).toThrow(/not found/);
    expect(() => sampleAnimation(data, "idle", { bones: ["nope"] })).toThrow(/Bone "nope"/);
  });
});

describe("helpers", () => {
  it("angleDelta wraps around 360", () => {
    expect(angleDelta(350, 10)).toBe(20);
    expect(angleDelta(10, 350)).toBe(-20);
  });

  it("pickEven keeps first and last frames", () => {
    expect(pickEven(5, 12)).toEqual([0, 1, 2, 3, 4]);
    expect(pickEven(100, 4)).toEqual([0, 33, 66, 99]);
  });

  it("contactSheet tiles frames into one PNG", () => {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-test-"));
    const paths = [0, 1, 2, 3, 4].map((i) => {
      const png = new PNG({ width: 40, height: 20 });
      for (let p = 0; p < png.data.length; p += 4) png.data.set([i * 50, 0, 0, 255], p);
      const file = join(dir, `frame_${i}.png`);
      writeFileSync(file, PNG.sync.write(png));
      return file;
    });
    const sheet = contactSheet(paths, { maxFrames: 4, columns: 2, cell: 20 });
    const out = PNG.sync.read(sheet.png);
    expect(sheet.picked).toEqual([0, 1, 3, 4]);
    expect(out.width).toBe(2 * 20 + 3 * 4);
    expect(out.height).toBe(2 * 10 + 3 * 4);
  });
});

describe("sampling grid", () => {
  it("keeps the last sample on the loop end when duration * fps is not an integer", () => {
    const data = loadSkeletonData(loadMini(), "mini");
    const s = sampleAnimation(data, "bad-loop", { fps: 24.5, bones: ["head"] });
    expect(s.frames).toBe(Math.round(24.5) + 1);
    expect(s.fps).toBeCloseTo(25, 3);
    // Loop wraps: the final sample equals frame 0, so the seam step is the snap back from ~19.2 deg to 0.
    expect(s.samples.at(-1)![0]!.local.rotation).toBeCloseTo(s.samples[0]![0]!.local.rotation, 3);
  });
});

describe("sampling exactness (review #2)", () => {
  const noPhysics = () => {
    const doc = loadMini();
    doc.constraints = doc.constraints!.filter((c) => c.type !== "physics");
    return doc;
  };
  for (const duration of [1, 1.1, 1.34, 2.9, 3.7]) {
    it(`detects a seam pop without physics warm-up (D=${duration})`, () => {
      const doc = noPhysics();
      doc.animations!.pop = { bones: { head: { rotate: [{}, { time: duration, value: 20 }] } } };
      for (const fps of [24, 30, 60]) {
        const s = sampleAnimation(loadSkeletonData(doc), "pop", { fps, bones: ["head"] });
        expect(s.samples[0]![0]!.local.rotation).toBeCloseTo(0, 6);
        expect(s.samples.at(-1)![0]!.local.rotation).toBeCloseTo(0, 6); // wrapped
        expect(measureMotion(s).bones[0]!.seam.ratio).toBeGreaterThan(10);
      }
    });
  }

  it("starts on the loop start after physics warm-up", () => {
    const doc = loadMini();
    doc.animations!.pop = { bones: { head: { rotate: [{}, { time: 1, value: 20 }] } } };
    const s = sampleAnimation(loadSkeletonData(doc), "pop", { fps: 30, bones: ["head"], warmupLoops: 2 });
    expect(s.samples[0]![0]!.local.rotation).toBeCloseTo(0, 6);
  });
});

describe("seam and pop metrics are local (no false positives from long holds)", () => {
  it("does not flag a smooth loop with a long hold and slow drift", () => {
    const doc = loadMini();
    doc.animations!.hold = {
      bones: {
        head: { rotate: [{ curve: [0.08, 0, 0.17, 150] }, { time: 0.25, value: 150, curve: [0.6, 150, 1, 150] }, { time: 1.35, value: 150, curve: [1.43, 150, 1.52, 0] }, { time: 1.6 }] },
        hip: { translate: [{ curve: [0.27, 0, 0.53, 0, 0.27, 0, 0.53, -3] }, { time: 0.8, y: -3, curve: [1.07, 0, 1.33, 0, 1.07, -3, 1.33, 0] }, { time: 1.6 }] },
      },
    };
    const m = measureMotion(sampleAnimation(loadSkeletonData(doc), "hold", { fps: 30, bones: ["head"] })).bones[0]!;
    expect(m.seam.ratio).toBeLessThan(2);
    expect(m.pops).toEqual([]);
  });

  it("flags a single-frame snap in the middle of a motion", () => {
    const doc = loadMini();
    doc.animations!.snap = { bones: { head: { rotate: [{}, { time: 0.5, value: 10, curve: "stepped" }, { time: 0.52, value: 60 }, { time: 1, value: 70 }] } } };
    const m = measureMotion(sampleAnimation(loadSkeletonData(doc), "snap", { fps: 30, bones: ["head"] })).bones[0]!;
    expect(m.pops.length).toBeGreaterThan(0);
  });
});
