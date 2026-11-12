// Mesh fit: art a mesh cuts off, mostly empty meshes, image files no longer the mesh's size (spine_rig_qa and
// spine_update_images).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { artOutside, coverage, fitOf, meshFits, mostlyEmpty } from "../src/spine/meshfit.js";
import { rigQa } from "../src/spine/rigqa.js";
import type { SkeletonJson } from "../src/spine/types.js";

type Img = { width: number; height: number; data: Uint8ClampedArray };
const blank = (w: number, h: number): Img => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
const fill = (img: Img, x0: number, y0: number, x1: number, y1: number) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data.set([200, 100, 50, 255], (y * img.width + x) * 4); return img; };
// A quad over [u0, u1] x [v0, v1] in UV space, two triangles.
const quad = (u0: number, v0: number, u1: number, v1: number) => ({ uvs: [u0, v0, u1, v0, u1, v1, u0, v1], triangles: [0, 1, 2, 2, 3, 0] });

describe("mesh fit", () => {
  it("covers the pixels whose centre lies in a triangle, with no crack between triangles", () => {
    const full = quad(0, 0, 1, 1);
    expect(coverage(full.uvs, full.triangles, 10, 10).reduce((s, v) => s + v, 0)).toBe(100);
    const half = coverage([0, 0, 1, 0, 0, 1], [0, 1, 2], 10, 10).reduce((s, v) => s + v, 0);
    expect(half).toBeGreaterThanOrEqual(50);
    expect(half).toBeLessThanOrEqual(55);
  });

  it("measures art the mesh cuts off and how far out it goes", () => {
    // Art over the whole 40 x 40 image, a mesh over the middle half: 10 px of art on every side not drawn.
    const img = fill(blank(40, 40), 0, 0, 40, 40), f = fitOf(img, [quad(0.25, 0.25, 0.75, 0.75)]);
    expect(f.outsidePx).toBe(1600 - 400);
    expect(f.outsidePercent).toBe(75);
    expect(f.farthestPx).toBeGreaterThanOrEqual(10);
    expect(artOutside(f)).toBe(true);
    // The art inside the mesh: nothing cut off, the rest of the mesh empty.
    const small = fitOf(fill(blank(40, 40), 10, 10, 30, 30), [quad(0, 0, 1, 1)]);
    expect(small).toMatchObject({ outsidePx: 0, farthestPx: 0, emptyInsidePercent: 75, emptyInsidePx: 1200 });
    expect(artOutside(small)).toBe(false);
  });

  it("joins the meshes drawing one image, and leaves stray specks out", () => {
    const img = fill(blank(40, 40), 0, 0, 40, 40);
    // Two meshes, each over one half: together they draw everything (goblins' hand and thumb share an image).
    expect(fitOf(img, [quad(0, 0, 0.5, 1), quad(0.5, 0, 1, 1)]).outsidePx).toBe(0);
    // Art inside the mesh plus a 2 x 2 speck far outside it.
    const speck = fill(fill(blank(80, 80), 0, 0, 40, 40), 70, 70, 72, 72);
    expect(fitOf(speck, [quad(0, 0, 0.5, 0.5)])).toMatchObject({ outsidePx: 0, farthestPx: 0 });
  });

  it("reports mostly empty meshes only when large, never for blank images or sequence frames", () => {
    const big = fitOf(fill(blank(200, 200), 0, 0, 40, 40), [quad(0, 0, 1, 1)]);
    expect(mostlyEmpty(big)).toBe(true);
    expect(mostlyEmpty({ ...big, sequence: true })).toBe(false);
    expect(mostlyEmpty(fitOf(fill(blank(40, 40), 0, 0, 8, 8), [quad(0, 0, 1, 1)]))).toBe(false);
    const empty = fitOf(blank(200, 200), [quad(0, 0, 1, 1)]);
    expect(empty.blank).toBe(true);
    expect(mostlyEmpty(empty)).toBe(false);
  });
});

// A skeleton with one mesh ("cape", 40 x 40) and a linked mesh in a second skin using another image ("cape-red").
const doc = (w = 40, h = 40): SkeletonJson => ({
  skeleton: { spine: "4.3.26", images: "./images/" }, bones: [{ name: "root" }], slots: [{ name: "cape", bone: "root", attachment: "cape" }],
  skins: [
    { name: "default", attachments: { cape: { cape: { type: "mesh", uvs: [0.25, 0.25, 0.75, 0.25, 0.75, 0.75, 0.25, 0.75], triangles: [0, 1, 2, 2, 3, 0], vertices: [-10, -10, 10, -10, 10, 10, -10, 10], hull: 4, width: w, height: h } } } },
    { name: "red", attachments: { cape: { cape: { type: "linkedmesh", path: "cape-red", skin: "default", source: "cape", width: w, height: h } } } },
  ],
} as unknown as SkeletonJson);

describe("mesh fit on a skeleton", () => {
  it("checks linked meshes against their own image, and finds a file no longer the mesh's size", () => {
    const imgs: Record<string, Img> = { cape: fill(blank(40, 40), 10, 10, 30, 30), "cape-red": fill(blank(40, 40), 0, 0, 40, 40) };
    const { fits, missing } = meshFits(doc(), (p) => imgs[p] ?? null);
    expect(missing).toEqual([]);
    const by = Object.fromEntries(fits.map((f) => [f.image, f]));
    expect(by.cape).toMatchObject({ outsidePx: 0, attachments: ["default/cape/cape"] });
    expect(by["cape-red"]).toMatchObject({ outsidePx: 1200, attachments: ["red/cape/cape"] });
    expect(by.cape!.resized).toBeUndefined();
    expect(meshFits(doc(), (p) => (p === "cape" ? fill(blank(60, 40), 0, 0, 1, 1) : null)).fits[0]!.resized).toEqual({ mesh: [40, 40], image: [60, 40] });
  });

  it("rig QA reports art outside a mesh and a resized mesh image from the images folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-meshfit-"));
    mkdirSync(join(dir, "images"));
    const write = (name: string, img: Img) => { const p = new PNG({ width: img.width, height: img.height }); p.data.set(img.data); writeFileSync(join(dir, "images", `${name}.png`), PNG.sync.write(p)); };
    write("cape", fill(blank(40, 40), 10, 10, 30, 30));
    write("cape-red", fill(blank(48, 40), 0, 0, 48, 40));
    const r = rigQa(doc(), { baseDir: dir });
    const by = Object.fromEntries(r.findings.map((f) => [f.code, f]));
    expect(by["mesh-art-outside"]!.items).toEqual([expect.stringMatching(/^cape-red: \d+ px \(\d+(\.\d+)?%\), up to \d+(\.\d+)? px out$/)]);
    expect(by["mesh-image-resized"]!.items).toEqual(["cape-red: mesh 40x40, file 48x40"]);
    expect(by["mesh-mostly-empty"]).toBeUndefined();
  });
});
