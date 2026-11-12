import { describe, expect, it } from "vitest";
import { alphaContour, convexHull, delaunay, distanceToPolygon, meshPolygon, offsetPolygon, pointInPolygon, signedArea, simplify, type Pt } from "../src/spine/geometry.js";

const grid = (w: number, h: number, on: (x: number, y: number) => boolean) => (x: number, y: number) => (on(x, y) ? 255 : 0);

describe("geometry", () => {
  it("traces the outline of an opaque area through pixel centres", () => {
    const c = alphaContour(10, 6, grid(10, 6, () => true));
    expect(Math.abs(signedArea(c))).toBeCloseTo(9 * 5, 6);
    const ring = alphaContour(20, 20, grid(20, 20, (x, y) => (x - 9.5) ** 2 + (y - 9.5) ** 2 < 64));
    expect(Math.abs(signedArea(ring))).toBeGreaterThan(150);
    expect(Math.abs(signedArea(ring))).toBeLessThan(Math.PI * 64);
  });

  it("covers every island with one hull when no single island dominates", () => {
    const c = alphaContour(30, 10, grid(30, 10, (x, y) => y > 2 && y < 7 && (x < 6 || x > 23)));
    for (const q of [[1, 4], [28, 4], [15, 4]] as Pt[]) expect(pointInPolygon(q, c)).toBe(true);
  });

  it("closes the trace of one-pixel strokes instead of circling until the guard", () => {
    // A whisker or a glasses frame: the trace comes back to the start pixel from the other side, where Jacob's
    // criterion never fires (See-through's eyewear layer traced 19,625 points and auto rig never finished).
    const line = alphaContour(20, 20, grid(20, 20, (x, y) => y === 5 && x >= 2 && x < 18));
    expect(line.length).toBeLessThanOrEqual(2 * 16);
    const L = alphaContour(20, 20, grid(20, 20, (x, y) => (x === 3 && y > 2 && y < 15) || (y === 14 && x >= 3 && x < 15)));
    expect(L.length).toBeLessThanOrEqual(2 * 24);
    // A closed shape still traces once around (no repeated start point).
    const box = alphaContour(10, 6, grid(10, 6, () => true));
    expect(box).toHaveLength(new Set(box.map((q) => q.join())).size);
  });

  it("gives up meshing an outline that crosses itself instead of growing the boundary without end", () => {
    // A thin stroke circled 20 times, each lap a little off, as the old trace left it: the conforming split never
    // closes the missing edges (it took 99 s before the cap).
    const circling: Pt[] = [];
    for (let k = 0; k < 20; k++) {
      for (let x = 0; x < 120; x++) circling.push([x + 0.5, 5.5 + (k % 3) * 1.3]);
      for (let x = 119; x >= 0; x--) circling.push([x + 0.5, 6.5 - (k % 2) * 1.3]);
    }
    let outline = simplify(circling, 1.7);
    if (signedArea(outline) < 0) outline = outline.reverse();
    outline = offsetPolygon(outline, 2.7, 120, 38);
    const t0 = Date.now();
    expect(meshPolygon(outline, [], 14)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("simplifies within epsilon", () => {
    const circle: Pt[] = Array.from({ length: 200 }, (_, i) => [50 + 40 * Math.cos((i / 200) * 2 * Math.PI), 50 + 40 * Math.sin((i / 200) * 2 * Math.PI)]);
    const s = simplify(circle, 1);
    expect(s.length).toBeLessThan(40);
    for (const q of circle) expect(distanceToPolygon(q, s)).toBeLessThanOrEqual(1.0001);
  });

  it("Delaunay-triangulates a square with a centre point", () => {
    const tris = delaunay([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]]);
    expect(tris).toHaveLength(4);
    expect(convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]])).toHaveLength(4);
  });

  it("meshes a concave outline exactly, hull first", () => {
    // An L (a leg with a foot): Delaunay alone would bridge the notch.
    const L: Pt[] = [[0, 0], [10, 0], [10, 60], [50, 60], [50, 75], [0, 75]];
    const inner: Pt[] = [];
    for (let y = 4; y < 75; y += 8) for (let x = 4; x < 50; x += 8) inner.push([x, y]);
    const m = meshPolygon(L, inner, 12)!;
    expect(m).not.toBeNull();
    const area = m.triangles.reduce((s, [a, b, c]) => { const A = m.points[a]!, B = m.points[b]!, C = m.points[c]!; return s + Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1])) / 2; }, 0);
    expect(area).toBeCloseTo(Math.abs(signedArea(L)), 3);
    const hull = m.points.slice(0, m.hull);
    expect(Math.abs(signedArea(hull))).toBeCloseTo(Math.abs(signedArea(L)), 6);
    for (const [a, b, c] of m.triangles) {
      const A = m.points[a]!, B = m.points[b]!, C = m.points[c]!;
      expect(pointInPolygon([(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3], L)).toBe(true);
    }
  });

  it("offsets a polygon outward and clamps it to the image", () => {
    const sq: Pt[] = [[2, 2], [8, 2], [8, 8], [2, 8]];
    const poly = signedArea(sq) > 0 ? sq : [...sq].reverse();
    const out = offsetPolygon(poly, 1, 10, 10);
    expect(Math.abs(signedArea(out))).toBeGreaterThan(Math.abs(signedArea(poly)));
    const clamped = offsetPolygon(poly, 5, 10, 10);
    for (const [x, y] of clamped) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(10); expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(10); }
  });
});
