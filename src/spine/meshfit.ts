import type { Img, ImageLookup } from "./gaps.js";
import { loadSkeletonData, spine } from "./runtime.js";
import type { SkeletonJson } from "./types.js";

// Art at or above this alpha outside a mesh is cut off; at or under EMPTY inside it the mesh draws nothing (fill cost).
const OPAQUE = 32, EMPTY = 8;
// Art outside the mesh is reported from this distance (pixels) and count on: an anti-aliased rim a pixel off is noise.
// Calibrated on the official examples (npm run fixtures): four images there lose 3 to 6 px of an edge (looked at), the
// rest keep every pixel within 2 px.
export const OUTSIDE_PX = 3, OUTSIDE_MIN = 16;
// Groups of fewer opaque pixels outside the mesh are stray specks, left out.
const SPECK = 8;
// A mesh this empty (share of its area, and pixels) is reported as fill cost. On the official examples only alien's splat
// (77% of 723 x 339) and diamond's glow quad (69% of 237 x 168) pass; small parts (a 15 x 17 nose at 57%) and sequence
// frames sharing one mesh are left out.
export const EMPTY_SHARE = 60, EMPTY_MIN_PX = 10000;

export interface FitNumbers {
  /** Opaque pixels the mesh does not cover (they are not drawn). */
  outsidePx: number;
  outsidePercent: number;
  /** How far the farthest of them lies from the mesh, in image pixels. */
  farthestPx: number;
  /** Share of the mesh's area that is transparent (drawn for nothing). */
  emptyInsidePercent: number;
  emptyInsidePx: number;
  /** No opaque pixel at all (an empty sequence frame, a placeholder). */
  blank?: true;
}

export interface MeshFit extends FitNumbers {
  image: string;
  /** skin/slot/attachment of every mesh drawing this image with these UVs. */
  attachments: string[];
  size: [number, number];
  /** The image file is not the size the mesh was made for: the art is stretched to the mesh's UVs. */
  resized?: { mesh: [number, number]; image: [number, number] };
  /** A frame of an image sequence: one mesh covers every frame, so a frame's empty share says little. */
  sequence?: true;
}

/** Pixels whose centre lies in one of the mesh's triangles (UVs 0..1 over a w x h image). */
export function coverage(uvs: ArrayLike<number>, triangles: ArrayLike<number>, w: number, h: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const a = triangles[t]! * 2, b = triangles[t + 1]! * 2, c = triangles[t + 2]! * 2;
    const ax = uvs[a]! * w, ay = uvs[a + 1]! * h, bx = uvs[b]! * w, by = uvs[b + 1]! * h, cx = uvs[c]! * w, cy = uvs[c + 1]! * h;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-9) continue;
    const s = Math.sign(area), eps = 1e-7 * Math.abs(area);
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        // Inclusive edges, so neighbouring triangles leave no crack.
        if (s * ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) >= -eps && s * ((cx - bx) * (py - by) - (cy - by) * (px - bx)) >= -eps && s * ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) >= -eps) m[y * w + x] = 1;
      }
    }
  }
  return m;
}

/** Distance (pixels, 8-neighbour chamfer) from every pixel to the nearest covered one. */
function distanceTo(mask: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h).fill(Infinity), D = Math.SQRT2;
  for (let i = 0; i < mask.length; i++) if (mask[i]) d[i] = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x > 0) d[i] = Math.min(d[i]!, d[i - 1]! + 1);
    if (y > 0) { d[i] = Math.min(d[i]!, d[i - w]! + 1); if (x > 0) d[i] = Math.min(d[i]!, d[i - w - 1]! + D); if (x < w - 1) d[i] = Math.min(d[i]!, d[i - w + 1]! + D); }
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (x < w - 1) d[i] = Math.min(d[i]!, d[i + 1]! + 1);
    if (y < h - 1) { d[i] = Math.min(d[i]!, d[i + w]! + 1); if (x < w - 1) d[i] = Math.min(d[i]!, d[i + w + 1]! + D); if (x > 0) d[i] = Math.min(d[i]!, d[i + w - 1]! + D); }
  }
  return d;
}

export interface MeshUv { uvs: ArrayLike<number>; triangles: ArrayLike<number> }

/**
 * How an image's art sits in its meshes: art none of them covers (cut off), and their transparent share. Meshes drawing
 * the same image are joined: a second mesh showing only part of an image (goblins' thumb over the hand) is a technique.
 */
export function fitOf(img: Img, meshes: MeshUv[]): FitNumbers {
  const { width: w, height: h, data } = img, cov = new Uint8Array(w * h);
  for (const m of meshes) { const c = coverage(m.uvs, m.triangles, w, h); for (let i = 0; i < c.length; i++) cov[i] ||= c[i]!; }
  let opaque = 0, inside = 0, empty = 0;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < cov.length; i++) {
    const a = data[i * 4 + 3]!;
    if (a >= OPAQUE) { opaque++; if (!cov[i]) out[i] = 1; }
    if (cov[i]) { inside++; if (a <= EMPTY) empty++; }
  }
  // Specks (a few stray pixels the painter left) are not art the mesh cuts off.
  const stack: number[] = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== 1) continue;
    const comp: number[] = [];
    out[i] = 2; stack.push(i);
    while (stack.length) {
      const j = stack.pop()!, x = j % w, y = (j - x) / w;
      comp.push(j);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, k = ny * w + nx;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && out[k] === 1) { out[k] = 2; stack.push(k); }
      }
    }
    if (comp.length < SPECK) for (const j of comp) out[j] = 0;
  }
  let outside = 0, farthest = 0;
  for (let i = 0; i < out.length; i++) if (out[i]) outside++;
  if (outside) {
    const d = distanceTo(cov, w, h);
    for (let i = 0; i < out.length; i++) if (out[i]) farthest = Math.max(farthest, d[i]!);
  }
  return {
    outsidePx: outside, outsidePercent: opaque ? +(100 * outside / opaque).toFixed(2) : 0,
    farthestPx: Number.isFinite(farthest) ? +farthest.toFixed(1) : Math.max(w, h), emptyInsidePercent: inside ? +(100 * empty / inside).toFixed(1) : 0, emptyInsidePx: empty,
    ...(opaque ? {} : { blank: true as const }),
  };
}

/** Art the mesh cuts off, far and much enough to see. */
export const artOutside = (f: Pick<FitNumbers, "farthestPx" | "outsidePx">) => f.farthestPx >= OUTSIDE_PX && f.outsidePx >= OUTSIDE_MIN;
/** A mesh drawing mostly transparent pixels over a large area (fill cost, overdraw). */
export const mostlyEmpty = (f: FitNumbers & { sequence?: true }) => !f.blank && !f.sequence && f.emptyInsidePercent >= EMPTY_SHARE && f.emptyInsidePx >= EMPTY_MIN_PX;

interface ImageMeshes { attachments: string[]; meshes: MeshUv[]; size?: [number, number]; sequence?: true }

/** Every image a mesh draws (linked meshes and sequence frames too) with the meshes drawing it. */
export function imageMeshes(doc: SkeletonJson): Map<string, ImageMeshes> {
  const data = loadSkeletonData(doc);
  const byImage = new Map<string, ImageMeshes>();
  for (const skin of data.skins) for (const e of skin.getAttachments()) {
    const att = e.attachment;
    if (!(att instanceof spine.MeshAttachment)) continue;
    const where = `${skin.name}/${data.slots[e.slotIndex]!.name}/${e.placeholder}`;
    const base = att.path || att.name, seq = att.sequence;
    for (const image of seq.pathSuffix ? Array.from({ length: seq.regions.length }, (_, i) => seq.getPath(base, i)) : [base]) {
      const g = byImage.get(image) ?? byImage.set(image, { attachments: [], meshes: [] }).get(image)!;
      g.attachments.push(where);
      if (seq.pathSuffix) g.sequence = true;
      // Linked meshes share their source's UV array: one coverage each.
      if (!g.meshes.some((m) => m.uvs === att.regionUVs)) g.meshes.push({ uvs: att.regionUVs, triangles: att.triangles });
      if (att.width > 0 && att.height > 0) g.size ??= [Math.round(att.width), Math.round(att.height)];
    }
  }
  return byImage;
}

/** Every image a mesh draws against the file on disk, its meshes joined. */
export function meshFits(doc: SkeletonJson, images: ImageLookup): { fits: MeshFit[]; missing: string[] } {
  const fits: MeshFit[] = [], missing: string[] = [];
  for (const [image, g] of imageMeshes(doc)) {
    const img = images(image);
    if (!img) { missing.push(image); continue; }
    const fit: MeshFit = { image, attachments: g.attachments, size: [img.width, img.height], ...fitOf(img, g.meshes) };
    if (g.sequence) fit.sequence = true;
    if (g.size && (g.size[0] !== img.width || g.size[1] !== img.height)) fit.resized = { mesh: g.size, image: [img.width, img.height] };
    fits.push(fit);
  }
  return { fits, missing };
}
