import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

export interface FrameCompare {
  /** Silhouette overlap (pixels that differ from the background): 1 = identical shape. */
  iou: number;
  /** Mean colour difference (0-1) over the figure (pixels that differ from the background in either). */
  colorDiff: number;
  size: { a: [number, number]; b: [number, number] };
}

interface Img { w: number; h: number; d: Uint8Array }

const load = (path: string): Img => {
  const p = PNG.sync.read(readFileSync(path));
  return { w: p.width, h: p.height, d: new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.length) };
};

/**
 * Compares two renders of the same pose on the same opaque background, framed on the same bounds (top-left aligned;
 * a pixel or two of size difference is cropped). Silhouette = pixels that differ from the background.
 */
export function compareFrames(pathA: string, pathB: string, background: [number, number, number]): FrameCompare & { diffPng: () => Buffer } {
  const A = load(pathA), B = load(pathB);
  const px = (img: Img, x: number, y: number, c: number) => img.d[(y * img.w + x) * 4 + c]!;
  const fig = (img: Img) => {
    const m = new Uint8Array(img.w * img.h);
    for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) m[y * img.w + x] = [0, 1, 2].some((c) => Math.abs(px(img, x, y, c) - background[c]!) > 24) ? 1 : 0;
    return m;
  };
  const fa = fig(A), fb = fig(B);
  // Centre of the figure (robust to small parts that differ, e.g. a physics-driven tip).
  const centroid = (m: Uint8Array, w: number, h: number): [number, number, number] => {
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) { sx += x; sy += y; n++; }
    return n ? [sx / n, sy / n, n] : [w / 2, h / 2, 0];
  };
  // Renderers frame the animation on slightly different bounds: align the figures (centroids, then the best offset
  // within a few pixels).
  const [ax, ay, an] = centroid(fa, A.w, A.h), [bx, by, bn] = centroid(fb, B.w, B.h);
  const score = (dx: number, dy: number) => {
    let i = 0, u = 0;
    for (let y = 0; y < A.h; y += 2) for (let x = 0; x < A.w; x += 2) {
      const xb = x + dx, yb = y + dy;
      const a = fa[y * A.w + x]!, b = xb >= 0 && yb >= 0 && xb < B.w && yb < B.h ? fb[yb * B.w + xb]! : 0;
      if (a || b) u++;
      if (a && b) i++;
    }
    return u ? i / u : 1;
  };
  let best = { dx: Math.round(bx - ax), dy: Math.round(by - ay), s: -1 };
  const c0 = { ...best };
  for (let oy = -4; oy <= 4; oy++) for (let ox = -4; ox <= 4; ox++) {
    const v = score(c0.dx + ox, c0.dy + oy);
    if (v > best.s) best = { dx: c0.dx + ox, dy: c0.dy + oy, s: v };
  }
  const bAt = (x: number, y: number, c: number) => {
    const xb = x + best.dx, yb = y + best.dy;
    return xb >= 0 && yb >= 0 && xb < B.w && yb < B.h ? px(B, xb, yb, c) : background[c]!;
  };
  const figB = (x: number, y: number) => { const xb = x + best.dx, yb = y + best.dy; return xb >= 0 && yb >= 0 && xb < B.w && yb < B.h ? fb[yb * B.w + xb]! : 0; };
  const w = A.w, h = A.h;
  let inter = 0, union = 0, color = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = fa[y * w + x]!, b = figB(x, y);
    if (a || b) union++;
    if (a && b) inter++;
    let m = 0;
    for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(px(A, x, y, c) - bAt(x, y, c)));
    if (a || b) color += m / 255;
  }
  // Frames with (almost) nothing drawn in both renders match, whatever a stray pixel says.
  const empty = an < 50 && bn < 50;
  const result = { iou: empty || !union ? 1 : inter / union, colorDiff: empty || !union ? 0 : color / union, size: { a: [A.w, A.h] as [number, number], b: [B.w, B.h] as [number, number] } };
  const diffPng = () => {
    const out = new PNG({ width: w * 3 + 16, height: h });
    out.data.fill(244);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * out.width + x) * 4, o2 = (y * out.width + w + 8 + x) * 4, o3 = (y * out.width + 2 * w + 16 + x) * 4;
      for (let c = 0; c < 3; c++) { out.data[o + c] = px(A, x, y, c); out.data[o2 + c] = bAt(x, y, c); }
      out.data[o + 3] = out.data[o2 + 3] = 255;
      const a = fa[y * w + x]!, b2 = figB(x, y);
      const m = Math.max(...[0, 1, 2].map((c) => Math.abs(px(A, x, y, c) - bAt(x, y, c))));
      const [r, g, b] = a !== b2 ? [230, 40, 40] : a ? [255 - m, 255 - m, 255 - m] : [244, 245, 255];
      out.data[o3] = r; out.data[o3 + 1] = g; out.data[o3 + 2] = b; out.data[o3 + 3] = 255;
    }
    return PNG.sync.write(out);
  };
  return { ...result, diffPng };
}

/** How far an image is from a reference of the same size: what a lossy step (texture compression) changed. */
export interface LossDiff {
  /** Pixels compared: the drawn ones (alpha in either, or off the background in either). */
  pixels: number;
  /** Peak signal-to-noise ratio over them in dB (null: identical). */
  psnr: number | null;
  /** Share of them, in percent, where a channel moved by VISIBLE or more. */
  visiblePercent: number;
  /** Largest channel difference (0-255). */
  maxDelta: number;
  mse: number;
}

// A channel step of 8 of 255 shows on flat colour.
export const VISIBLE = 8;

/**
 * Compares an image with its reference pixel by pixel (same framing). With a background colour (renders) the drawn
 * pixels are those off it in either image and the colour channels count; without (texture pages) those with alpha in
 * either and all four channels (premultiplied pages carry the colour in alpha too).
 */
export function lossDiff(referencePath: string, path: string, background?: [number, number, number]): LossDiff & { diffPng: () => Buffer } {
  const A = load(referencePath), B = load(path);
  const w = Math.min(A.w, B.w), h = Math.min(A.h, B.h), channels = background ? 3 : 4;
  const drawn = (img: Img, o: number) => background ? [0, 1, 2].some((c) => Math.abs(img.d[o + c]! - background[c]!) > 2) : img.d[o + 3]! > 0;
  let pixels = 0, sum = 0, visible = 0, maxDelta = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const oa = (y * A.w + x) * 4, ob = (y * B.w + x) * 4;
    if (!drawn(A, oa) && !drawn(B, ob)) continue;
    pixels++;
    let m = 0;
    for (let c = 0; c < channels; c++) { const d = Math.abs(A.d[oa + c]! - B.d[ob + c]!); sum += d * d; m = Math.max(m, d); }
    if (m >= VISIBLE) visible++;
    maxDelta = Math.max(maxDelta, m);
  }
  const mse = pixels ? sum / (pixels * channels) : 0;
  const diffPng = () => {
    // Reference, image, and their difference four times brighter (on black), side by side.
    const out = new PNG({ width: w * 3 + 16, height: h });
    out.data.fill(244);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const oa = (y * A.w + x) * 4, ob = (y * B.w + x) * 4, o = (y * out.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        out.data[o + c] = A.d[oa + c]!;
        out.data[o + (w + 8) * 4 + c] = B.d[ob + c]!;
        out.data[o + (2 * w + 16) * 4 + c] = Math.min(255, 4 * Math.abs(A.d[oa + c]! - B.d[ob + c]!));
      }
      out.data[o + 3] = out.data[o + (w + 8) * 4 + 3] = out.data[o + (2 * w + 16) * 4 + 3] = 255;
    }
    return PNG.sync.write(out);
  };
  return { pixels, psnr: mse ? +(10 * Math.log10((255 * 255) / mse)).toFixed(2) : null, visiblePercent: pixels ? +(100 * visible / pixels).toFixed(2) : 0, maxDelta, mse, diffPng };
}

