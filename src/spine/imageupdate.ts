import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readPsd } from "ag-psd";
import { PNG } from "pngjs";
import type { Config } from "../config.js";
import { collectParts, type Part } from "./autorig.js";
import type { SpineCli } from "./cli.js";
import { writePng } from "./layers.js";
import { artOutside, fitOf, imageMeshes, type FitNumbers } from "./meshfit.js";
import { loadProject, pruneDir, UserError } from "./project.js";
import { contactSheet, renderFrames } from "./render.js";
import { loadSkeletonData, spine } from "./runtime.js";
import type { SkeletonJson } from "./types.js";
import { addAnimationLocked } from "./write.js";
import { fileKeyOr } from "../platform.js";

export interface UpdateImagesOptions {
  project: string;
  psd: string;
  skeleton?: string;
  /** Only these layers / images (names or paths). */
  only?: string[];
  /** keep (default): each image stays aligned with its old art, so moves made in Spine survive; psd: art goes where the PSD puts it relative to the other layers. */
  placement?: "keep" | "psd";
  /**
   * Enlarge a region's image around its centre when the art no longer fits (default false: skipped). Data exports then
   * draw it at the new size, but Spine's own render of the project keeps the old size (verified), so check it in the editor.
   */
  grow?: boolean;
  /** The scale the images were exported at from the PSD (default 1). */
  scale?: number;
  /** Render the setup pose before and after (default true). */
  preview?: boolean;
  apply?: boolean;
  /** Put back the images of an earlier update (its backup id); dry-run unless apply. */
  restore?: string;
}

type Status = "updated" | "grown" | "unchanged" | "skipped";

export interface ImageChange {
  image: string;
  layer?: string;
  kind: "region" | "mesh";
  status: Status;
  /** Old and new size in pixels when they differ (regions grow around their centre; meshes never change size). */
  size?: { from: [number, number]; to: [number, number] };
  /** Pixels that change. */
  changedPixels?: number;
  /** The layer sits this far (PSD pixels) from where the project draws the image, relative to the other layers. */
  moved?: [number, number];
  /** How the image was placed: matched to its old art, or from the PSD's layout. */
  placedBy?: "old art" | "psd layout";
  /** Meshes: how the art sits in the mesh before and after (art cut off, transparent share). */
  fit?: { before: MeshFitBrief; after: MeshFitBrief };
  reason?: string;
}

type MeshFitBrief = Pick<FitNumbers, "outsidePx" | "farthestPx" | "emptyInsidePercent">;
const brief = (f: FitNumbers): MeshFitBrief => ({ outsidePx: f.outsidePx, farthestPx: f.farthestPx, emptyInsidePercent: f.emptyInsidePercent });

export interface UpdateImagesResult {
  mode: "dry-run" | "updated" | "restore-dry-run" | "restored";
  project: string;
  imagesDir: string;
  changes: ImageChange[];
  /** PSD layers no project image uses (new art: spine_import_layers or the editor), and images no layer matches. */
  newLayers: string[];
  unmatchedImages: string[];
  backup?: string;
  verified?: { regionsResized: number; meshesUntouched: boolean };
  notes: string[];
  png?: Buffer;
}

interface Frame { image: string; kind: "region" | "mesh"; /** top-left in skeleton space, size in skeleton units */ x: number; y: number; w: number; h: number; ok: boolean; why?: string }

/** Where the setup pose draws each image: top-left and size in skeleton space, upright attachments only. */
export function imageFrames(doc: SkeletonJson): Map<string, Frame> {
  const data = loadSkeletonData(doc);
  const sk = new spine.Skeleton(data);
  sk.setupPose();
  sk.updateWorldTransform(spine.Physics.none);
  const frames = new Map<string, Frame>();
  for (const skin of data.skins) for (const e of skin.getAttachments()) {
    const att = e.attachment, slot = sk.slots[e.slotIndex]!;
    let f: Frame | null = null;
    if (att instanceof spine.RegionAttachment) {
      const image = att.path || att.name;
      if (isSequence(att)) { f = { image, kind: "region", x: 0, y: 0, w: 0, h: 0, ok: false, why: "image sequence" }; }
      else {
        const v = new Array<number>(8).fill(0);
        att.computeWorldVertices(slot, att.getOffsets(slot.pose), v, 0, 2);
        // Corners come bottom-left, top-left, top-right, bottom-right for an upright region.
        const upright = Math.abs(v[0]! - v[2]!) < 0.01 && Math.abs(v[3]! - v[5]!) < 0.01 && v[3]! > v[1]! && v[4]! > v[2]!;
        f = upright ? { image, kind: "region", x: v[2]!, y: v[3]!, w: v[4]! - v[2]!, h: v[3]! - v[1]!, ok: true } : { image, kind: "region", x: 0, y: 0, w: 0, h: 0, ok: false, why: "turned or flipped in the setup pose" };
      }
    } else if (att instanceof spine.MeshAttachment) {
      const image = att.path || att.name;
      if (isSequence(att)) f = { image, kind: "mesh", x: 0, y: 0, w: 0, h: 0, ok: false, why: "image sequence" };
      else {
        const n = att.worldVerticesLength, v = new Array<number>(n);
        att.computeWorldVertices(sk, slot, 0, n, v, 0, 2);
        const uv = att.regionUVs;
        // Least squares x = a*u + b*v + c, y = d*u + e*v + f: an upright image has b = d = 0, a > 0, e < 0.
        const fit = (k: 0 | 1) => {
          let suu = 0, suv = 0, svv = 0, su = 0, sv = 0, sx = 0, sux = 0, svx = 0;
          const m = n / 2;
          for (let i = 0; i < m; i++) { const u = uv[i * 2]!, w = uv[i * 2 + 1]!, x = v[i * 2 + k]!; suu += u * u; suv += u * w; svv += w * w; su += u; sv += w; sx += x; sux += u * x; svx += w * x; }
          const A = [[suu, suv, su], [suv, svv, sv], [su, sv, m]], B = [sux, svx, sx];
          return solve3(A, B);
        };
        const X = fit(0), Y = fit(1);
        const res = X && Y ? Math.max(...Array.from({ length: n / 2 }, (_, i) => Math.hypot(X[0] * uv[i * 2]! + X[1] * uv[i * 2 + 1]! + X[2] - v[i * 2]!, Y[0] * uv[i * 2]! + Y[1] * uv[i * 2 + 1]! + Y[2] - v[i * 2 + 1]!))) : Infinity;
        const upright = X && Y && res < 0.5 && Math.abs(X[1]) < 0.01 * Math.abs(X[0]) && Math.abs(Y[0]) < 0.01 * Math.abs(Y[1]) && X[0] > 0 && Y[1] < 0;
        f = upright ? { image, kind: "mesh", x: X![2], y: Y![2], w: X![0], h: -Y![1], ok: true } : { image, kind: "mesh", x: 0, y: 0, w: 0, h: 0, ok: false, why: "deformed, turned or flipped in the setup pose" };
      }
    }
    if (!f) continue;
    const prev = frames.get(f.image);
    // The same image under several attachments (skins): keep the first usable frame; a mesh use pins the size.
    if (!prev || (!prev.ok && f.ok)) frames.set(f.image, prev?.kind === "mesh" ? { ...f, kind: "mesh" } : f);
    else if (f.kind === "mesh" && prev.kind === "region") frames.set(f.image, { ...prev, kind: "mesh" });
  }
  return frames;
}

/** A real image sequence (frame images by suffix); 4.3 gives every attachment a one-region sequence. */
const isSequence = (att: { sequence?: { regions: unknown[]; pathSuffix: boolean } | null }) => !!att.sequence && (att.sequence.pathSuffix || att.sequence.regions.length > 1);

function solve3(A: number[][], B: number[]): [number, number, number] | null {
  const m = A.map((r, i) => [...r, B[i]!]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    if (Math.abs(m[p]![c]!) < 1e-12) return null;
    [m[c], m[p]] = [m[p]!, m[c]!];
    for (let r = 0; r < 3; r++) if (r !== c) { const k = m[r]![c]! / m[c]![c]!; for (let k2 = c; k2 < 4; k2++) m[r]![k2]! -= k * m[c]![k2]!; }
  }
  return [m[0]![3]! / m[0]![0]!, m[1]![3]! / m[1]![1]!, m[2]![3]! / m[2]![2]!];
}

interface Img { width: number; height: number; data: Uint8ClampedArray }

const readImg = (file: string): Img => { const p = PNG.sync.read(readFileSync(file)); return { width: p.width, height: p.height, data: new Uint8ClampedArray(p.data) }; };

/**
 * Where the old image sits on the new layer: the offset (old image top-left in PSD pixels) that best overlaps their
 * alpha, searched around the alpha centroids, coarse then fine. Returns the overlap (IoU of alpha > 64) too.
 */
export function register(old: Img, part: Part): { x: number; y: number; iou: number } {
  const mask = (img: Img) => { const m = new Uint8Array(img.width * img.height); for (let i = 0; i < m.length; i++) m[i] = img.data[i * 4 + 3]! > 64 ? 1 : 0; return m; };
  const mo = mask(old), mp = mask(part);
  const centroid = (m: Uint8Array, w: number) => { let sx = 0, sy = 0, n = 0; for (let i = 0; i < m.length; i++) if (m[i]) { sx += i % w; sy += Math.floor(i / w); n++; } return n ? [sx / n, sy / n] : [w / 2, m.length / w / 2]; };
  const co = centroid(mo, old.width), cp = centroid(mp, part.width);
  const no = mo.reduce((s, v) => s + v, 0), np = mp.reduce((s, v) => s + v, 0);
  // Old image placed with its top-left at (ox, oy) in the part's own pixels.
  const score = (ox: number, oy: number, step: number) => {
    let inter = 0;
    for (let y = 0; y < old.height; y += step) {
      const py = y + oy;
      if (py < 0 || py >= part.height) continue;
      for (let x = 0; x < old.width; x += step) {
        const px = x + ox;
        if (px >= 0 && px < part.width && mo[y * old.width + x] && mp[py * part.width + px]) inter++;
      }
    }
    inter *= step * step;
    return inter / Math.max(1, no + np - inter);
  };
  let bx = Math.round(cp[0]! - co[0]!), by = Math.round(cp[1]! - co[1]!), best = 0;
  const R = Math.ceil(Math.max(8, 0.25 * Math.max(old.width, old.height)));
  // A pyramid: each level searches around the last best at a finer step, sampling the image at that step.
  const levels: number[] = [];
  for (let st = Math.max(1, Math.floor(Math.max(old.width, old.height) / 64)); ; st = Math.ceil(st / 4)) { levels.push(st); if (st === 1) break; }
  levels.forEach((step, i) => {
    const range = i === 0 ? R : 2 * levels[i - 1]!, cx = bx, cy = by;
    let top = score(cx, cy, step);
    for (let dy = -range; dy <= range; dy += step) for (let dx = -range; dx <= range; dx += step) {
      const s = score(cx + dx, cy + dy, step);
      if (s > top) { top = s; bx = cx + dx; by = cy + dy; }
    }
  });
  best = score(bx, by, 1);
  return { x: part.left + bx, y: part.top + by, iou: +best.toFixed(4) };
}

/** The new art cut to a frame (top-left in PSD pixels, size in image pixels): the new image file's pixels. */
function cut(part: Part, fx: number, fy: number, w: number, h: number): Img {
  const out = new Uint8ClampedArray(w * h * 4), ox = Math.round(part.left - fx), oy = Math.round(part.top - fy);
  for (let y = 0; y < part.height; y++) {
    const ty = y + oy;
    if (ty < 0 || ty >= h) continue;
    for (let x = 0; x < part.width; x++) {
      const tx = x + ox;
      if (tx < 0 || tx >= w) continue;
      out.set(part.data.subarray((y * part.width + x) * 4, (y * part.width + x) * 4 + 4), (ty * w + tx) * 4);
    }
  }
  return { width: w, height: h, data: out };
}

function changed(a: Img, b: Img): number {
  if (a.width !== b.width || a.height !== b.height) return a.width * a.height;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const aa = a.data[i + 3]!, ba = b.data[i + 3]!;
    if (Math.abs(aa - ba) > 8 || (aa > 8 && Math.max(Math.abs(a.data[i]! - b.data[i]!), Math.abs(a.data[i + 1]! - b.data[i + 1]!), Math.abs(a.data[i + 2]! - b.data[i + 2]!)) > 8)) n++;
  }
  return n;
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0; };

/**
 * New art from a PSD into an existing project's images, without touching the .spine: each layer matched to its image
 * by path or name, cut to the frame the project draws that image in (so attachments, meshes, weights and animations
 * stay valid), regions grown around their centre when the art got bigger, meshes never resized. Dry-run by default
 * with a before/after render of the setup pose; apply backs up the old files, writes, and re-exports to confirm.
 */
export async function updateImages(config: Config, cli: SpineCli, o: UpdateImagesOptions): Promise<UpdateImagesResult> {
  if (!isAbsolute(o.project) || extname(o.project).toLowerCase() !== ".spine" || !existsSync(o.project)) throw new UserError(`project must be an absolute path to an existing .spine: ${o.project}`);
  if (o.restore) return restoreImages(config, o);
  if (!isAbsolute(o.psd) || !existsSync(o.psd) || extname(o.psd).toLowerCase() !== ".psd") throw new UserError(`psd must be an absolute path to an existing .psd: ${o.psd}`);
  const loaded = await loadProject(config, cli, o.project);
  const sk = o.skeleton ? loaded.skeletons.find((s) => s.name === o.skeleton) : loaded.skeletons[0];
  if (!sk) throw new UserError(`Skeleton "${o.skeleton}" not found. Skeletons: ${loaded.skeletons.map((s) => s.name).join(", ")}`);
  const doc = sk.doc;
  const imagesDir = resolve(dirname(o.project), doc.skeleton.images ?? "./images/");
  if (!existsSync(imagesDir)) throw new UserError(`Images folder not found: ${imagesDir}`);
  const scale = o.scale ?? 1;
  const { parts, notes: psdNotes } = collectParts(readPsd(readFileSync(o.psd), { useImageData: true }), scale);
  const frames = imageFrames(doc);
  const meshes = imageMeshes(doc);
  const wanted = (s: string) => !o.only?.length || o.only.some((n) => n === s || basename(n) === basename(s));
  // Layer -> image: the full path first, then the bare name when only one image has it.
  const byName = new Map<string, string[]>();
  for (const img of frames.keys()) byName.set(basename(img), [...(byName.get(basename(img)) ?? []), img]);
  const pairs: { part: Part; image: string }[] = [];
  const used = new Set<string>();
  for (const part of parts) {
    const image = frames.has(part.path) ? part.path : byName.get(part.name)?.length === 1 ? byName.get(part.name)![0]! : undefined;
    if (image && !used.has(image) && (wanted(image) || wanted(part.name))) { pairs.push({ part, image }); used.add(image); }
  }
  const newLayers = parts.filter((p) => !pairs.some((x) => x.part === p) && !used.has(p.path)).map((p) => p.path);
  const unmatchedImages = [...frames.keys()].filter((i) => !used.has(i) && wanted(i));
  const notes: string[] = [...psdNotes];
  // Register every pair, then the PSD -> skeleton translation from the good matches: skeleton = (x * s + tx, -y * s + ty).
  const reg = pairs.map(({ part, image }) => {
    const file = join(imagesDir, `${image}.png`), f = frames.get(image)!;
    if (!f.ok && f.why === "image sequence") return { part, image, f, skip: f.why };
    if (!existsSync(file)) return { part, image, f, skip: "image file missing" };
    const old = readImg(file);
    // Turned in the setup pose: the file and the layer are both in image space, so matching the old art still places
    // it; only the PSD layout (a translation) cannot be used for it.
    if (!f.ok) return { part, image, f, old, s: null, turned: true, at: register(old, part) };
    const s = f.w / old.width;
    if (Math.abs(f.h / old.height - s) > 0.01 * s) return { part, image, f, skip: "scaled unevenly in the setup pose" };
    return { part, image, f, old, s, turned: false, at: register(old, part) };
  });
  const good = reg.filter((r) => r.at && r.at.iou >= 0.6 && !r.turned);
  const sAll = median(good.map((r) => r.s!));
  const tx = median(good.map((r) => r.f.x - r.at!.x * sAll)), ty = median(good.map((r) => r.f.y + r.at!.y * sAll));
  if (!good.length && reg.some((r) => r.old)) notes.push("No layer matched its old image closely (overlap under 0.6): placing by the PSD's layout is impossible to anchor, so every image is placed on its old art's best match.");
  const changes: ImageChange[] = [];
  const writes: { file: string; img: Img }[] = [];
  for (const r of reg) {
    if (!r.old) { changes.push({ image: r.image, layer: r.part.path, kind: r.f.kind, status: "skipped", reason: r.skip }); continue; }
    const old = r.old, s = r.s ?? sAll;
    if (r.turned && r.at!.iou < 0.6) { changes.push({ image: r.image, layer: r.part.path, kind: r.f.kind, status: "skipped", reason: `turned in the setup pose and the layer does not match the old image well enough (overlap ${r.at!.iou}) to place it; is the art turned in the PSD too?` }); continue; }
    if (!r.turned && good.length && Math.abs(s - sAll) > 0.01 * sAll) { changes.push({ image: r.image, layer: r.part.path, kind: r.f.kind, status: "skipped", reason: `drawn at scale ${s.toFixed(3)}, the others at ${sAll.toFixed(3)}` }); continue; }
    // Where the project draws the image, in PSD pixels (from the shared layout), and where its old art matches the layer.
    const psdAt: [number, number] | null = good.length && !r.turned ? [(r.f.x - tx) / sAll, (ty - r.f.y) / sAll] : null;
    const moved: [number, number] | undefined = psdAt && r.at.iou >= 0.6 && Math.hypot(r.at.x - psdAt[0], r.at.y - psdAt[1]) > 1 ? [+(psdAt[0] - r.at.x).toFixed(1), +(psdAt[1] - r.at.y).toFixed(1)] : undefined;
    const usePsd = !!psdAt && (o.placement === "psd" || r.at.iou < 0.6);
    let [fx, fy] = usePsd ? psdAt! : [r.at.x, r.at.y];
    let w = old.width, h = old.height;
    // The art's opaque bounds against the frame.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = 0; y < r.part.height; y++) for (let x = 0; x < r.part.width; x++) if (r.part.data[(y * r.part.width + x) * 4 + 3]! > 0) { x0 = Math.min(x0, r.part.left + x); x1 = Math.max(x1, r.part.left + x + 1); y0 = Math.min(y0, r.part.top + y); y1 = Math.max(y1, r.part.top + y + 1); }
    const over = { l: Math.max(0, Math.ceil(fx - x0 - 0.01)), r: Math.max(0, Math.ceil(x1 - (fx + w) - 0.01)), t: Math.max(0, Math.ceil(fy - y0 - 0.01)), b: Math.max(0, Math.ceil(y1 - (fy + h) - 0.01)) };
    const base = { image: r.image, layer: r.part.path, kind: r.f.kind, placedBy: usePsd ? "psd layout" as const : "old art" as const, ...(moved ? { moved } : {}) };
    if (over.l || over.r || over.t || over.b) {
      if (r.f.kind === "mesh") { changes.push({ ...base, status: "skipped", reason: `the art is ${Math.max(over.l, over.r, over.t, over.b)} px outside the mesh's image; a mesh keeps its UVs, so a bigger image would squeeze the art. Re-mesh in Spine, or trim the layer` }); continue; }
      const by = Math.max(over.l, over.r, over.t, over.b);
      if (!o.grow) { changes.push({ ...base, status: "skipped", reason: `the art is ${by} px outside its image; grow: true enlarges the image around its centre (exports follow; Spine's own render keeps the old size until checked in the editor), or trim the layer` }); continue; }
      // A region is drawn around its centre at its image's size: grow evenly so the centre stays put.
      const gx = Math.max(over.l, over.r), gy = Math.max(over.t, over.b);
      fx -= gx; fy -= gy; w += 2 * gx; h += 2 * gy;
    }
    const img = cut(r.part, fx, fy, w, h);
    const diff = changed(old, img);
    const uv = r.f.kind === "mesh" ? meshes.get(r.image)?.meshes : undefined;
    const fit = uv && diff ? { fit: { before: brief(fitOf(old, uv)), after: brief(fitOf(img, uv)) } } : {};
    if (!diff) { changes.push({ ...base, status: "unchanged" }); continue; }
    const grown = w !== old.width || h !== old.height;
    changes.push({ ...base, status: grown ? "grown" : "updated", changedPixels: diff, ...(grown ? { size: { from: [old.width, old.height], to: [w, h] } } : {}), ...fit });
    writes.push({ file: join(imagesDir, `${r.image}.png`), img });
  }
  const result: UpdateImagesResult = { mode: "dry-run", project: o.project, imagesDir, changes, newLayers, unmatchedImages, notes };
  const moves = changes.filter((c) => c.moved);
  if (moves.length) notes.push(`${moves.map((c) => `${c.image} (${c.moved!.join(", ")} px)`).join(", ")}: the layer is not where the project draws it, relative to the other layers (moved in the PSD or in Spine). ${o.placement === "psd" ? "Placed by the PSD (the move shows in Spine)." : "Kept on the old art (a Spine move survives); placement: \"psd\" takes the PSD's position."}`);
  const cutOff = changes.filter((c) => c.fit && artOutside(c.fit.after) && c.fit.after.outsidePx > c.fit.before.outsidePx + 16);
  if (cutOff.length) notes.push(`New art the mesh cuts off (outside its hull, never drawn): ${cutOff.map((c) => `${c.image} (${c.fit!.after.outsidePx} px, up to ${c.fit!.after.farthestPx} px out; before ${c.fit!.before.outsidePx})`).join(", ")}. Widen the hull in Spine (Edit Mesh) or trim the layer; the image is still written.`);
  if (changes.some((c) => c.status === "grown")) notes.push("Grown images: Spine's data export (JSON, binary, atlas) draws them at their new size around the same centre, so games show the new art; Spine's own PNG render of the project (and the preview here) still uses the old size, so the art looks squeezed there. Open the project in Spine to check how the editor shows it.");
  if (newLayers.length) notes.push(`Layers with no image in the project (new art): ${newLayers.slice(0, 20).join(", ")}. Add them in Spine or start a new project with spine_import_layers.`);
  if (o.preview !== false && writes.length) {
    try { result.png = await previewImages(config, cli, o.project, doc, imagesDir, writes, sk.name); }
    catch (e) { notes.push(`Before/after render skipped: ${(e as Error).message.split("\n")[0]}`); }
  }
  if (!o.apply) {
    notes.push(writes.length ? `apply: true writes ${writes.length} image(s) into ${imagesDir} after backing up the old ones; the .spine is not touched.` : "Nothing to write.");
    return result;
  }
  if (!writes.length) { result.mode = "updated"; return result; }
  // Back up the files about to change, then write.
  const id = `${basename(o.project, ".spine")}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const backupRoot = join(config.workDir, "image-backups");
  pruneDir(backupRoot, 30);
  const dir = join(backupRoot, id);
  for (const w of writes) { const rel = relative(imagesDir, w.file), to = join(dir, "files", rel); mkdirSync(dirname(to), { recursive: true }); copyFileSync(w.file, to); }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ project: o.project, imagesDir, files: writes.map((w) => relative(imagesDir, w.file)), at: new Date().toISOString() }, null, 2));
  for (const w of writes) writePng(w.file, w.img);
  result.mode = "updated";
  result.backup = id;
  // Spine reads image sizes when it loads the project: re-export and check regions follow their new images and meshes kept their UVs.
  const after = (await loadProject(config, cli, o.project, { refresh: true })).skeletons.find((s) => s.name === sk.name)!.doc;
  const sizeOf = (d: SkeletonJson) => { const m = new Map<string, { w: number; h: number; uvs?: number[] }>(); for (const skin of d.skins ?? []) for (const slot of Object.values(skin.attachments ?? {})) for (const [k, a] of Object.entries(slot as Record<string, { path?: string; name?: string; width?: number; height?: number; type?: string; uvs?: number[] }>)) m.set(a.path ?? a.name ?? k, { w: a.width ?? 0, h: a.height ?? 0, uvs: a.uvs }); return m; };
  const before = sizeOf(doc), now = sizeOf(after);
  const grown = changes.filter((c) => c.status === "grown" && c.kind === "region");
  const resized = grown.filter((c) => now.get(c.image)?.w === c.size!.to[0] && now.get(c.image)?.h === c.size!.to[1]).length;
  const meshesUntouched = changes.filter((c) => c.kind === "mesh" && c.status === "updated").every((c) => JSON.stringify(now.get(c.image)?.uvs) === JSON.stringify(before.get(c.image)?.uvs));
  result.verified = { regionsResized: resized, meshesUntouched };
  if (resized !== grown.length) notes.push(`Only ${resized} of ${grown.length} grown regions report their new size after re-export; check them in Spine.`);
  notes.push(`Wrote ${writes.length} image(s); backup ${id} (spine_update_images with restore: "${id}" puts them back). The .spine itself was not changed. If the project is open in Spine it should pick the new files up; if it does not, reopen the project (not verified: spine-mcp cannot watch the editor).`);
  return result;
}

/** Spine's setup pose with the current images, then with the planned ones, side by side (a private copy of the project). */
async function previewImages(config: Config, cli: SpineCli, project: string, doc: SkeletonJson, imagesDir: string, writes: { file: string; img: Img }[], skeleton: string): Promise<Buffer> {
  const rel = relative(dirname(project), imagesDir);
  const ups = rel.split(sep).filter((p) => p === "..").length;
  if (isAbsolute(rel) || ups > 3) throw new UserError("the images folder is too far from the project to copy");
  const root = join(config.workDir, "image-preview", `${basename(project, ".spine")}-${Date.now()}`);
  pruneDir(join(config.workDir, "image-preview"), 6);
  try {
    const projDir = join(root, "a", "b", "c");
    mkdirSync(projDir, { recursive: true });
    const copy = join(projDir, basename(project));
    copyFileSync(project, copy);
    const imgCopy = resolve(projDir, rel);
    cpSync(imagesDir, imgCopy, { recursive: true });
    const anim = Object.keys(doc.animations ?? {}).includes("spine-mcp-setup") ? "spine-mcp-setup-2" : "spine-mcp-setup";
    const bone = doc.bones[0]!.name;
    await addAnimationLocked(config, cli, { project: copy, name: anim, animation: { bones: { [bone]: { rotate: [{ value: 0 }, { time: 0.1, value: 0 }] } } }, apply: true, editor: "inPlace", allowUpgrade: true });
    const before = await renderFrames(config, cli, copy, { skeleton, animation: anim, fps: 10, scale: 100, background: "7f7f7fff" });
    for (const w of writes) writePng(join(imgCopy, relative(imagesDir, w.file)), w.img);
    const after = await renderFrames(config, cli, copy, { skeleton, animation: anim, fps: 10, scale: 100, background: "7f7f7fff" });
    return contactSheet([before.frames[0]!, after.frames[0]!], { columns: 2, maxFrames: 2, cell: 420, background: [127, 127, 127] }).png;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function restoreImages(config: Config, o: UpdateImagesOptions): UpdateImagesResult {
  const id = o.restore!;
  if (!/^[\w.-]+$/.test(id)) throw new UserError(`Invalid backup id: ${id}`);
  const dir = join(config.workDir, "image-backups", id);
  if (!existsSync(join(dir, "manifest.json"))) {
    const have = existsSync(join(config.workDir, "image-backups")) ? readdirSync(join(config.workDir, "image-backups")).filter((d) => d.startsWith(basename(o.project, ".spine"))) : [];
    throw new UserError(`Backup "${id}" not found. Backups for this project: ${have.join(", ") || "none"}`);
  }
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { project: string; imagesDir: string; files: string[] };
  if (fileKeyOr(resolve(m.project)) !== fileKeyOr(resolve(o.project))) throw new UserError(`Backup ${id} belongs to ${m.project}, not ${o.project}.`);
  const changes: ImageChange[] = m.files.map((f) => ({ image: f.replace(/\.png$/i, ""), kind: "region", status: "updated" }));
  if (!o.apply) return { mode: "restore-dry-run", project: o.project, imagesDir: m.imagesDir, changes, newLayers: [], unmatchedImages: [], backup: id, notes: [`apply: true copies ${m.files.length} backed-up image(s) back into ${m.imagesDir}.`] };
  for (const f of m.files) { const from = join(dir, "files", f); if (existsSync(from) && statSync(from).isFile()) copyFileSync(from, join(m.imagesDir, f)); }
  return { mode: "restored", project: o.project, imagesDir: m.imagesDir, changes, newLayers: [], unmatchedImages: [], backup: id, notes: [`Restored ${m.files.length} image(s).`] };
}
