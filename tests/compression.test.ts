// Device texture compression: the loss measure and the per-format report built from Unity's read-back files.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { formatMB, textureMemory } from "../src/spine/export.js";
import { renderFolder } from "../src/platform.js";
import { compressionReport } from "../src/spine/unity.js";
import { lossDiff, VISIBLE } from "../src/spine/visual.js";

/** A w x h PNG: pixel (x, y) gets fn(x, y) as RGBA. */
function png(file: string, w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]) {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p.data.set(fn(x, y), (y * w + x) * 4);
  writeFileSync(file, PNG.sync.write(p));
}

const grey = [127, 127, 127, 255] as [number, number, number, number];

describe("loss against a reference", () => {
  it("measures drawn pixels only, as PSNR and the share that moved visibly", () => {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-loss-"));
    // A page: left half drawn (alpha 255), right half transparent. The copy moves a quarter of the drawn pixels by 16.
    png(join(dir, "a.png"), 8, 8, (x) => (x < 4 ? [200, 100, 50, 255] : [0, 0, 0, 0]));
    png(join(dir, "b.png"), 8, 8, (x, y) => (x < 4 ? (y < 2 ? [216, 100, 50, 255] : [200, 100, 50, 255]) : [0, 0, 0, 0]));
    const d = lossDiff(join(dir, "a.png"), join(dir, "b.png"));
    expect(d.pixels).toBe(32);
    expect(d.visiblePercent).toBe(25);
    expect(d.maxDelta).toBe(16);
    // 8 pixels with one channel off by 16, over 32 pixels x 4 channels.
    expect(d.psnr).toBeCloseTo(10 * Math.log10((255 * 255) / ((8 * 256) / 128)), 2);
    expect(lossDiff(join(dir, "a.png"), join(dir, "a.png")).psnr).toBeNull();
    // On a background: only pixels off it count, colour channels only; a step under VISIBLE is not visible.
    png(join(dir, "r1.png"), 4, 4, (x) => (x < 2 ? [10, 20, 30, 255] : grey));
    png(join(dir, "r2.png"), 4, 4, (x) => (x < 2 ? [10 + VISIBLE - 1, 20, 30, 255] : grey));
    const r = lossDiff(join(dir, "r1.png"), join(dir, "r2.png"), [127, 127, 127]);
    expect(r).toMatchObject({ pixels: 8, visiblePercent: 0, maxDelta: VISIBLE - 1 });
  });
});

describe("compression report", () => {
  it("pools pages and frames per format, flags an override Unity did not load, and keeps memory in step with the pack sweep", () => {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-comp-"));
    const page = (fmt: string, delta: number) => {
      mkdirSync(join(dir, fmt, "~pages"), { recursive: true });
      png(join(dir, fmt, "~pages", "00.png"), 16, 16, (x, y) => [100 + ((x + y) % 2 ? delta : 0), 80, 60, 255]);
      mkdirSync(join(dir, fmt, renderFolder("walk")), { recursive: true });
      for (const k of [0, 1]) png(join(dir, fmt, renderFolder("walk"), `frame_00${k}.png`), 8, 8, (x) => (x < 4 ? [100 + (k ? delta : 0), 80, 60, 255] : grey));
    };
    page("RGBA32", 0);
    page("ASTC_4x4", 4);
    page("ASTC_12x12", 40);
    const raw = [
      { format: "RGBA32", pages: [{ texture: "p.png", loaded: "RGBA32", supported: true, size: [1024, 512] as [number, number] }] },
      { format: "ASTC_4x4", pages: [{ texture: "p.png", loaded: "ASTC_4x4", supported: true, size: [1024, 512] as [number, number] }] },
      { format: "ASTC_12x12", pages: [{ texture: "p.png", loaded: "RGBA32", supported: true, size: [1024, 512] as [number, number] }] },
    ];
    const { report, png: image } = compressionReport(raw, ["astc4x4", "astc12x12"], dir, ["walk"]);
    const [a4, a12] = report.formats;
    expect(report.baselineMB).toBe(textureMemory(1024 * 512).rgba32MB);
    expect(a4).toMatchObject({ applied: true, memoryMB: formatMB(1024 * 512, "astc4x4"), loaded: ["ASTC_4x4"] });
    expect(a12!.applied).toBe(false);
    expect(a4!.texture.psnr!).toBeGreaterThan(a12!.texture.psnr!);
    expect(a4!.render).toMatchObject({ frames: 2, worst: { animation: "walk", frame: 1 } });
    expect(a12!.render.visiblePercent).toBe(50);
    expect(image).toBeInstanceOf(Buffer);
    // The pack sweep's ASTC 6x6 column comes from the same table.
    expect(textureMemory(1024 * 1024).astc6x6MB).toBe(formatMB(1024 * 1024, "astc6x6"));
  });
});
