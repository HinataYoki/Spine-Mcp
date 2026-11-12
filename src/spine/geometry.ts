// 2D helpers for building meshes from image alpha: contour tracing, simplification, Delaunay triangulation.

export type Pt = [number, number];

/**
 * Outline of the opaque area (alpha > threshold) in pixel coordinates: Moore-neighbour tracing of the largest island
 * when it holds nearly all opaque pixels, otherwise the convex hull of every opaque pixel (one mesh hull must cover
 * all islands, e.g. two eyes drawn on one layer).
 */
export function alphaContour(width: number, height: number, alpha: (x: number, y: number) => number, threshold = 16): Pt[] {
  const ins = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && alpha(x, y) > threshold;
  // Islands by flood fill.
  const label = new Int32Array(width * height).fill(-1);
  const sizes: number[] = [], starts: Pt[] = [];
  let total = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!ins(x, y) || label[y * width + x]! >= 0) continue;
    const id = sizes.length, stack: number[] = [y * width + x];
    label[y * width + x] = id;
    let n = 0;
    while (stack.length) {
      const i = stack.pop()!, cx = i % width, cy = (i - cx) / width;
      n++;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + ox, ny = cy + oy;
        if (ins(nx, ny) && label[ny * width + nx]! < 0) { label[ny * width + nx] = id; stack.push(ny * width + nx); }
      }
    }
    sizes.push(n); starts.push([x, y]); total += n;
  }
  if (!total) return [];
  const big = sizes.indexOf(Math.max(...sizes));
  if (sizes[big]! < 0.95 * total) {
    const pts: Pt[] = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (ins(x, y)) pts.push([x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]);
    return convexHull(pts);
  }
  const inBig = (x: number, y: number) => ins(x, y) && label[y * width + x] === big;
  // Moore-neighbour tracing (clockwise, y down) from the island's top-left pixel. Jacob's criterion alone (back at
  // the start pixel, entered the same way) never fires on one-pixel strokes, which re-enter the start from the other
  // side: the trace also ends where it would repeat its first move.
  const dirs: Pt[] = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
  const s0 = starts[big]!;
  let p: Pt = s0, back: Pt = [s0[0] - 1, s0[1]];
  const out: Pt[] = [[s0[0] + 0.5, s0[1] + 0.5]];
  const startBack: Pt = back;
  let first: Pt | undefined;
  let closed = false;
  for (let guard = 0; guard < 4 * width * height + 16; guard++) {
    let k = dirs.findIndex(([dx, dy]) => p[0] + dx === back[0] && p[1] + dy === back[1]);
    if (k < 0) k = 0;
    let found = false;
    for (let step = 1; step <= 8; step++) {
      const [dx, dy] = dirs[(k + step) % 8]!;
      const n: Pt = [p[0] + dx, p[1] + dy];
      if (inBig(n[0], n[1])) {
        if (first && p[0] === s0[0] && p[1] === s0[1] && n[0] === first[0] && n[1] === first[1]) { closed = true; break; }
        first ??= n;
        const [bx, by] = dirs[(k + step - 1) % 8]!;
        back = [p[0] + bx, p[1] + by];
        p = n;
        found = true;
        break;
      }
    }
    if (closed) break;
    if (!found) { closed = true; break; } // a single pixel
    if (p[0] === s0[0] && p[1] === s0[1] && back[0] === startBack[0] && back[1] === startBack[1]) { closed = true; break; }
    out.push([p[0] + 0.5, p[1] + 0.5]);
  }
  if (closed) {
    const last = out[out.length - 1]!;
    if (out.length > 1 && last[0] === out[0]![0] && last[1] === out[0]![1]) out.pop();
    return out;
  }
  // The trace never closed: an outline circling several times crosses itself and cannot be meshed. The hull of the
  // island's pixels always covers the art.
  const pts: Pt[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (inBig(x, y)) pts.push([x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]);
  return convexHull(pts);
}

/** Monotone chain convex hull (counter-clockwise in y-down pixel space means clockwise on screen). */
export function convexHull(points: Pt[]): Pt[] {
  const pts = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [], upper: Pt[] = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop(); lower.push(p); }
  for (const p of [...pts].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop(); upper.push(p); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Ramer-Douglas-Peucker on a closed polygon. */
export function simplify(points: Pt[], epsilon: number): Pt[] {
  if (points.length < 4) return points;
  // Split the ring at the two farthest-apart points so both halves are open polylines.
  let a = 0, b = 0, far = -1;
  for (let i = 0; i < points.length; i += Math.max(1, Math.floor(points.length / 64))) {
    for (let j = 0; j < points.length; j++) {
      const d = (points[i]![0] - points[j]![0]) ** 2 + (points[i]![1] - points[j]![1]) ** 2;
      if (d > far) { far = d; a = i; b = j; }
    }
  }
  const [i0, i1] = a < b ? [a, b] : [b, a];
  const first = rdp(points.slice(i0, i1 + 1), epsilon);
  const second = rdp([...points.slice(i1), ...points.slice(0, i0 + 1)], epsilon);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts;
  const [ax, ay] = pts[0]!, [bx, by] = pts[pts.length - 1]!;
  const len = Math.hypot(bx - ax, by - ay) || 1e-9;
  let idx = 0, max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((bx - ax) * (ay - pts[i]![1]) - (ax - pts[i]![0]) * (by - ay)) / len;
    if (d > max) { max = d; idx = i; }
  }
  if (max <= eps) return [pts[0]!, pts[pts.length - 1]!];
  return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
}

export function signedArea(poly: Pt[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const [x0, y0] = poly[i]!, [x1, y1] = poly[(i + 1) % poly.length]!; s += x0 * y1 - x1 * y0; }
  return s / 2;
}

export function pointInPolygon([x, y]: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distanceToPolygon([x, y]: Pt, poly: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]!, [bx, by] = poly[(i + 1) % poly.length]!;
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / (((bx - ax) ** 2 + (by - ay) ** 2) || 1e-9)));
    best = Math.min(best, Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))));
  }
  return best;
}

/** Bowyer-Watson Delaunay triangulation; returns index triples into `points`. */
export function delaunay(points: Pt[]): [number, number, number][] {
  const n = points.length;
  if (n < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const d = Math.max(maxX - minX, maxY - minY) * 20 + 1, mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  const pts: Pt[] = [...points, [mx - d, my - d], [mx, my + d], [mx + d, my - d]];
  type Tri = { a: number; b: number; c: number; cx: number; cy: number; r2: number };
  const circum = (a: number, b: number, c: number): Tri => {
    const [ax, ay] = pts[a]!, [bx, by] = pts[b]!, [cx, cy] = pts[c]!;
    const dd = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by)) || 1e-12;
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / dd;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / dd;
    return { a, b, c, cx: ux, cy: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
  };
  let tris: Tri[] = [circum(n, n + 1, n + 2)];
  for (let i = 0; i < n; i++) {
    const [px, py] = pts[i]!;
    const bad = tris.filter((t) => (px - t.cx) ** 2 + (py - t.cy) ** 2 < t.r2 * (1 + 1e-12));
    const edges = new Map<string, [number, number]>();
    for (const t of bad) for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as [number, number][]) {
      const k = u < v ? `${u},${v}` : `${v},${u}`;
      if (edges.has(k)) edges.delete(k); else edges.set(k, [u, v]);
    }
    tris = tris.filter((t) => !bad.includes(t));
    for (const [u, v] of edges.values()) tris.push(circum(u, v, i));
  }
  return tris.filter((t) => t.a < n && t.b < n && t.c < n).map((t) => [t.a, t.b, t.c]);
}

/** Inserts points along edges longer than maxEdge (closed polygon). */
export function densify(poly: Pt[], maxEdge: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!, n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxEdge));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/**
 * Triangulates a simple polygon (counter-clockwise in y-down space or not) with extra interior points: Delaunay,
 * splitting boundary edges the triangulation misses until every one is present (conforming), then keeping the
 * triangles inside. The first `hull` points are the outline in order. Null when it does not tile the polygon.
 */
export function meshPolygon(outline: Pt[], interior: Pt[], maxEdge: number): { points: Pt[]; triangles: [number, number, number][]; hull: number } | null {
  let boundary = densify(outline, maxEdge);
  // Splitting missing edges converges in a round or two on a simple polygon; a self-crossing outline never does and
  // doubles the boundary every round (Delaunay is quadratic here): give up early and let the caller ear-clip.
  const maxBoundary = Math.max(4 * boundary.length, 64);
  for (let round = 0; round < 8; round++) {
    if (boundary.length > maxBoundary) return null;
    const minGap = maxEdge * 0.35;
    const inner = interior.filter((q) => pointInPolygon(q, boundary) && distanceToPolygon(q, boundary) > minGap);
    const points = [...boundary, ...inner];
    const all = delaunay(points);
    const edges = new Set<string>();
    for (const [a, b, c] of all) for (const [u, v] of [[a, b], [b, c], [c, a]]) edges.add(u! < v! ? `${u},${v}` : `${v},${u}`);
    const n = boundary.length, next: Pt[] = [];
    let missing = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      next.push(boundary[i]!);
      if (!edges.has(i < j ? `${i},${j}` : `${j},${i}`)) {
        missing++;
        next.push([(boundary[i]![0] + boundary[j]![0]) / 2, (boundary[i]![1] + boundary[j]![1]) / 2]);
      }
    }
    if (missing) { boundary = next; continue; }
    const triangles = all.filter(([a, b, c]) => {
      const A = points[a]!, B = points[b]!, C = points[c]!;
      const area = (B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1]);
      return Math.abs(area) > 1e-3 && pointInPolygon([(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3], boundary);
    });
    const covered = triangles.reduce((s, [a, b, c]) => { const A = points[a]!, B = points[b]!, C = points[c]!; return s + Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1])) / 2; }, 0);
    if (Math.abs(covered - Math.abs(signedArea(boundary))) > 1e-3 * Math.abs(signedArea(boundary)) + 1e-6) return null;
    return { points, triangles, hull: n };
  }
  return null;
}

/** Moves each vertex of a positive-area polygon outward by `pad` (miter, capped at 2x), clamped to [0,w]x[0,h]. */
export function offsetPolygon(poly: Pt[], pad: number, w: number, h: number): Pt[] {
  const n = poly.length;
  const normal = (a: Pt, b: Pt): Pt => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dy / l, -dx / l]; };
  return poly.map((p, i) => {
    const n0 = normal(poly[(i - 1 + n) % n]!, p), n1 = normal(p, poly[(i + 1) % n]!);
    let mx = n0[0] + n1[0], my = n0[1] + n1[1];
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml; my /= ml;
    const k = Math.min(2, 1 / Math.max(0.5, mx * n1[0] + my * n1[1]));
    return [Math.min(w, Math.max(0, p[0] + mx * pad * k)), Math.min(h, Math.max(0, p[1] + my * pad * k))];
  });
}
