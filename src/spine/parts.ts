import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PNG } from "pngjs";
import type { Part } from "./autorig.js";
import { clean, planSkeleton, scaled, trim, type Art, type BoneDef, type ImportLayersOptions, type PlacedArt } from "./layers.js";
import { UserError } from "./project.js";

/**
 * Folders of PNG parts placed by a layout JSON, the output of cut-out tools instead of a layered PSD. Three layouts:
 * - see-through: See-through's st_export.py `layout.json`, `{ width, height, layers: [{ order, name, file, x, y, w, h, … }] }`;
 * - cut-boxes: `parts.json`, `{ <name>: { x, y, w, h, draw_order, filled?: { x, y, w, h } } }`, images `<name>.png` in the
 *   folder given (`parts/` for the cut, `parts_filled/` for the filled cut: the box whose size matches the image places it);
 * - parts (spine-mcp's own): `{ width?, height?, bones?: [{ name, parent?, pivot? }], parts: [{ file | name, x, y | bbox | center,
 *   order?, bone?, slot?, pivot?, hidden?, opacity?, blend? }] }`, or the parts array alone.
 * Canvas pixels, x right, y down; x, y is the image's top-left corner; bbox [x0, y0, x1, y1]; order 0 is drawn first
 * (at the back; default: the array order).
 */

export type LayoutFormat = "see-through" | "cut-boxes" | "parts";
type Pt = [number, number];
interface Box { x: number; y: number; w: number; h: number; tolerance: number; kind?: "cut" | "filled" }

export interface LayoutPart {
  name: string;
  /** Absolute path of the PNG. */
  file: string;
  /** Top-left corner on the canvas. */
  at?: Pt;
  /** Boxes the image may fill (a cutting tool writes the cut and the filled one): it sits at the one its size matches. */
  boxes: Box[];
  center?: Pt;
  order: number;
  bone?: string;
  slot?: string;
  pivot?: Pt;
  hidden: boolean;
  opacity: number;
  blend: string;
}

export interface PartsLayout { format: LayoutFormat; file: string; width?: number; height?: number; parts: LayoutPart[]; bones: { name: string; parent?: string; pivot?: Pt }[]; source?: string; sourceOffset?: Pt; joints?: [string, string][] }

export interface LoadedPart { name: string; file: string; left: number; top: number; width: number; height: number; data: Uint8ClampedArray; order: number; bone?: string; slot?: string; pivot?: Pt; hidden: boolean; opacity: number; blend: string; placedBy?: "cut" | "filled" }

const BLENDS = new Set(["normal", "additive", "multiply", "screen"]);
/** The file name of a path with either separator (a layout written on Windows read on macOS). */
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const objects = (list: unknown[], file: string, what: string): Record<string, unknown>[] => list.map((v, i) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new UserError(`${file}: ${what} ${i} is not an object.`);
  return v as Record<string, unknown>;
});
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const pt = (v: unknown): Pt | undefined => (Array.isArray(v) && v.length === 2 && num(v[0]) && num(v[1]) ? [v[0], v[1]] : undefined);

/** layout.json or parts.json in the folder, then in its parent (cutting tools and See-through keep the images one level down). */
export function findLayout(folder: string): string | null {
  for (const dir of [folder, dirname(folder)]) for (const f of ["layout.json", "parts.json"]) if (existsSync(join(dir, f))) return join(dir, f);
  return null;
}

/** Reads one of the three layouts; image paths resolve against the layout's folder, then the parts folder. */
export function readLayout(file: string, folder: string): PartsLayout {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")); } catch (e) { throw new UserError(`Not valid JSON: ${file}: ${(e as Error).message}`); }
  const base = dirname(file);
  // The parts folder given wins (it may hold repainted images of the same names); then the layout's own paths. Layouts
  // written on Windows use backslashes: either separator works everywhere.
  const imageOf = (rel0: string | undefined, name: string) => {
    const rel = rel0?.replace(/\\/g, "/");
    const tries = rel ? (isAbsolute(rel) || /^[A-Za-z]:\//.test(rel) ? [rel] : [join(folder, fileName(rel)), resolve(folder, rel), resolve(base, rel)]) : [join(folder, `${name}.png`)];
    return tries.find((f) => existsSync(f)) ?? tries[0]!;
  };
  const o = raw as Record<string, unknown>;
  const size = (v: Record<string, unknown>) => ({ ...(num(v.width) ? { width: v.width } : {}), ...(num(v.height) ? { height: v.height } : {}) });
  const box = (v: Record<string, unknown> | undefined, tolerance = 0, kind?: Box["kind"]): Box[] => (v && num(v.x) && num(v.y) && num(v.w) && num(v.h) ? [{ x: v.x, y: v.y, w: v.w, h: v.h, tolerance, ...(kind ? { kind } : {}) }] : []);
  const sourceOf = (v: Record<string, unknown>) => {
    if (typeof v.source !== "string" || !v.source) return {};
    const rel = v.source.replace(/\\/g, "/");
    return { source: isAbsolute(rel) ? resolve(rel) : /^[A-Za-z]:\//.test(rel) ? rel : resolve(base, rel), ...(pt(v.sourceOffset) ? { sourceOffset: pt(v.sourceOffset)! } : {}) };
  };

  if (o && !Array.isArray(o) && Array.isArray(o.layers)) {
    const layers = objects(o.layers as unknown[], file, "layer");
    return {
      format: "see-through", file, ...size(o), ...sourceOf(o), bones: [],
      parts: layers.map((l, i) => {
        const name = String(l.name ?? l.tag ?? fileName(String(l.file ?? `layer-${i}`)).replace(/\.png$/i, ""));
        return { name, file: imageOf(typeof l.file === "string" ? l.file : undefined, name), boxes: box(l), ...(num(l.x) && num(l.y) ? { at: [l.x, l.y] as Pt } : {}), order: num(l.order) ? l.order : i, hidden: false, opacity: 1, blend: "normal" };
      }),
    };
  }
  if (Array.isArray(o) || (o && Array.isArray(o.parts))) {
    const list = objects((Array.isArray(o) ? o : o.parts) as unknown[], file, "part");
    const bones = (!Array.isArray(o) && Array.isArray(o.bones) ? (o.bones as Record<string, unknown>[]) : []).map((b) => {
      if (typeof b.name !== "string" || !b.name) throw new UserError(`${file}: every entry in bones needs a name.`);
      return { name: b.name, ...(typeof b.parent === "string" ? { parent: b.parent } : {}), ...(pt(b.pivot) ? { pivot: pt(b.pivot)! } : {}) };
    });
    const joints = (!Array.isArray(o) && Array.isArray(o.joints) ? (o.joints as unknown[]) : []).map((j, i) => {
      if (!Array.isArray(j) || j.length !== 2 || j.some((n) => typeof n !== "string" || !n)) throw new UserError(`${file}: joints[${i}] must be a pair of part names.`);
      return [j[0], j[1]] as [string, string];
    });
    return {
      format: "parts", file, ...(Array.isArray(o) ? {} : { ...size(o), ...sourceOf(o) }), bones, ...(joints.length ? { joints } : {}),
      parts: list.map((p, i) => {
        if (typeof p.file !== "string" && typeof p.name !== "string") throw new UserError(`${file}: part ${i} has neither file nor name.`);
        const name = typeof p.name === "string" ? p.name : fileName(p.file as string).replace(/\.png$/i, "");
        const bb = pt((p.bbox as unknown[] | undefined)?.slice(0, 2)), bb2 = pt((p.bbox as unknown[] | undefined)?.slice(2, 4));
        // A bbox's far corner may be inclusive or exclusive: one pixel of slack.
        const boxes = bb && bb2 ? [{ x: bb[0], y: bb[1], w: bb2[0] - bb[0], h: bb2[1] - bb[1], tolerance: 1 }] : box(p);
        const opacity = num(p.opacity) ? Math.min(1, Math.max(0, p.opacity)) : 1;
        return {
          name, file: imageOf(typeof p.file === "string" ? p.file : undefined, name), boxes,
          ...(num(p.x) && num(p.y) ? { at: [p.x, p.y] as Pt } : {}), ...(pt(p.center) ? { center: pt(p.center)! } : {}),
          order: num(p.order) ? p.order : i, hidden: p.hidden === true, opacity, blend: typeof p.blend === "string" ? p.blend.toLowerCase() : "normal",
          ...(typeof (p.bone ?? p.group) === "string" ? { bone: String(p.bone ?? p.group) } : {}), ...(typeof p.slot === "string" ? { slot: p.slot } : {}), ...(pt(p.pivot) ? { pivot: pt(p.pivot)! } : {}),
        };
      }),
    };
  }
  // cut-boxes: one entry per part name; keys starting with "_" are metadata.
  const entries = o && typeof o === "object" ? Object.entries(o).filter(([k, v]) => !k.startsWith("_") && v && typeof v === "object" && num((v as Record<string, unknown>).x) && num((v as Record<string, unknown>).w)) : [];
  if (!entries.length) throw new UserError(`${file}: not a parts layout (expected See-through's layout.json with layers, a cutting tool's parts.json, or { parts: [...] }).`);
  return {
    format: "cut-boxes", file, bones: [],
    parts: entries.map(([name, v0], i) => {
      const v = v0 as Record<string, unknown>;
      return { name, file: imageOf(undefined, name), boxes: [...box(v, 0, "cut"), ...box(v.filled as Record<string, unknown> | undefined, 0, "filled")], order: num(v.draw_order) ? v.draw_order : i, hidden: false, opacity: 1, blend: "normal" };
    }),
  };
}

/**
 * The layout and its images: each PNG read, placed (box matching its size, else top-left, else centre), trimmed of
 * transparent margins and sorted into draw order. Problems (missing images, sizes the layout does not match, no
 * position) are collected, not thrown, so a dry-run can list them all; names are cleaned and made unique.
 */
export function loadParts(o: { parts: string; layout?: string }): { layout: PartsLayout; parts: LoadedPart[]; problems: string[]; skipped: { layer: string; reason: string }[]; notes: string[] } {
  if (!isAbsolute(o.parts) || !existsSync(o.parts) || !statSync(o.parts).isDirectory()) throw new UserError(`parts must be an absolute path to a folder of PNG parts: ${o.parts}`);
  if (o.layout && (!isAbsolute(o.layout) || !existsSync(o.layout) || !statSync(o.layout).isFile())) throw new UserError(`layout must be an absolute path to an existing .json file: ${o.layout}`);
  const file = o.layout ?? findLayout(o.parts);
  if (!file) throw new UserError(`No layout.json or parts.json in ${o.parts} or its parent folder; pass layout.`);
  const layout = readLayout(file, o.parts);
  const problems: string[] = [], skipped: { layer: string; reason: string }[] = [], notes: string[] = [];
  const used = new Set<string>(), parts: LoadedPart[] = [];
  const sorted = layout.parts.map((p, i) => ({ p, i })).sort((a, b) => a.p.order - b.p.order || a.i - b.i).map((x) => x.p);
  for (const p of sorted) {
    if (!existsSync(p.file)) { problems.push(`${p.name}: image not found (${p.file})`); continue; }
    let png: PNG;
    try { png = PNG.sync.read(readFileSync(p.file)); } catch (e) { problems.push(`${p.name}: not a readable PNG (${(e as Error).message.split("\n")[0]})`); continue; }
    let left: number, top: number;
    const fit = p.boxes.find((b) => Math.abs(b.w - png.width) <= b.tolerance && Math.abs(b.h - png.height) <= b.tolerance);
    if (fit) { left = fit.x; top = fit.y; }
    else if (p.boxes.length) { problems.push(`${p.name}: image is ${png.width}x${png.height}, the layout says ${p.boxes.map((b) => `${b.w}x${b.h}`).join(" or ")}`); continue; }
    else if (p.at) [left, top] = p.at;
    else if (p.center) { left = p.center[0] - png.width / 2; top = p.center[1] - png.height / 2; }
    else { problems.push(`${p.name}: no position (x, y, bbox or center)`); continue; }
    const r = trim({ left, top, width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) });
    if (!r) { skipped.push({ layer: p.name, reason: "no pixels" }); continue; }
    if (!BLENDS.has(p.blend)) notes.push(`Part "${p.name}" blend "${p.blend}" is not a Spine blend mode; normal used.`);
    // Unique ignoring case: the images are files, and macOS and Windows file systems do not tell "Arm" from "arm".
    const base = clean(p.name);
    let name = base, i = 2;
    while (used.has(name.toLowerCase())) name = `${base}-${i++}`;
    used.add(name.toLowerCase());
    parts.push({ ...r, name, file: p.file, order: p.order, hidden: p.hidden, opacity: p.opacity, blend: BLENDS.has(p.blend) ? p.blend : "normal", ...(p.bone ? { bone: p.bone } : {}), ...(p.slot ? { slot: p.slot } : {}), ...(p.pivot ? { pivot: p.pivot } : {}), ...(fit?.kind ? { placedBy: fit.kind } : {}) });
  }
  if (!parts.length && layout.parts.length && layout.parts.every((p) => !existsSync(p.file))) problems.unshift(`None of the images were found; pass the folder that holds them as parts (for cut boxes: the parts or parts_filled folder).`);
  return { layout, parts, problems, skipped, notes };
}

/**
 * Loaded parts → skeleton, the same plan a PSD gives: one slot per part in draw order (parts sharing a slot name become
 * one slot with an attachment each), bones from the layout's bone names (groups), one per part (layers) or none (root),
 * bones at their pivot when the layout gives one, else at the centre of their art.
 */
export function partsToSkeleton(loaded: ReturnType<typeof loadParts>, o: { bones?: ImportLayersOptions["bones"]; origin?: ImportLayersOptions["origin"]; scale?: number; includeHidden?: boolean }) {
  const mode = o.bones ?? "groups";
  const skipped = [...loaded.skipped], notes = [...loaded.notes];
  const boneDefs: BoneDef[] = [{ name: "root", parent: null, members: [] }];
  const pivots = new Map<string, Pt>();
  const declared = new Map(loaded.layout.bones.map((b) => [b.name, b]));
  // Parents first; a bone the layout names but does not declare hangs from root.
  const ensure = (name: string, depth = 0): string => {
    if (name === "root" || boneDefs.some((b) => b.name === name)) return name;
    if (depth > declared.size) throw new UserError(`Bone parents loop at "${name}" in the layout.`);
    const d = declared.get(name);
    const parent = d?.parent ? ensure(d.parent, depth + 1) : "root";
    boneDefs.push({ name, parent, members: [] });
    if (d?.pivot) pivots.set(name, d.pivot);
    return name;
  };
  if (mode === "root") { if (declared.size || loaded.parts.some((p) => p.bone || p.pivot)) notes.push("bones: root puts every part on the root bone; the layout's bones and pivots are not used."); }
  else for (const b of loaded.layout.bones) ensure(b.name);
  const arts: PlacedArt[] = [];
  for (const p of loaded.parts) {
    if (p.hidden && !o.includeHidden && !p.slot) { skipped.push({ layer: p.name, reason: "hidden" }); continue; }
    const art: Art = { name: p.name, path: p.name, left: p.left, top: p.top, width: p.width, height: p.height, data: p.data, opacity: p.opacity, blend: p.blend, hidden: p.hidden };
    let bone = mode !== "root" && p.bone ? ensure(p.bone) : "root";
    if (mode === "layers") {
      let own = p.name, i = 2;
      while (boneDefs.some((b) => b.name === own)) own = `${p.name}-${i++}`;
      boneDefs.push({ name: own, parent: bone, members: [] });
      bone = own;
    }
    if (mode !== "root" && p.pivot && bone !== "root") {
      const had = pivots.get(bone);
      if (!had) pivots.set(bone, p.pivot);
      else if (had[0] !== p.pivot[0] || had[1] !== p.pivot[1]) notes.push(`Bone "${bone}": parts give different pivots; [${had.join(", ")}] used, "${p.name}" gives [${p.pivot.join(", ")}].`);
    }
    boneDefs.find((b) => b.name === bone)!.members.push(art);
    arts.push({ art, bone, ...(p.slot ? { slotGroup: p.slot } : {}) });
  }
  // A shared slot sits on one bone and at one place in the draw order: say so when its parts asked for more.
  const groups = new Map<string, { bones: Set<string>; at: number[] }>();
  arts.forEach((a, i) => { if (a.slotGroup) { const g = groups.get(a.slotGroup) ?? { bones: new Set(), at: [] }; g.bones.add(a.bone); g.at.push(i); groups.set(a.slotGroup, g); } });
  for (const [slot, g] of groups) {
    if (g.bones.size > 1) notes.push(`Slot "${slot}": its parts name different bones (${[...g.bones].join(", ")}); a slot has one bone, the one of the part it shows at setup, and the others are placed relative to it.`);
    if (g.at.some((v, k) => k > 0 && v !== g.at[k - 1]! + 1)) notes.push(`Slot "${slot}": its parts are not next to each other in the draw order; the slot is drawn where the part it shows at setup is.`);
  }
  if (!arts.some((a) => !a.art.hidden)) throw new UserError(loaded.problems.length ? `No part could be placed: ${loaded.problems.slice(0, 5).join("; ")}` : "No visible parts with pixels in the layout.");
  if (mode === "groups" && loaded.parts.some((p) => p.pivot && !p.bone)) notes.push("Pivots of parts without a bone are not used (they sit on root); give them a bone, or use bones: layers.");
  return { ...planSkeleton(arts, boneDefs, { origin: o.origin, scale: o.scale, pivots }), skipped, notes, counts: { groups: boneDefs.length - 1, layers: arts.length } };
}

/** The visible parts as auto rig / art QA parts, scaled, in draw order (of a slot's parts, only the first visible one). */
const SHUT_LID = /(^|[^a-z])(eye)?lids?($|[^a-z])/i;

export function rigParts(parts: LoadedPart[], scale: number): Part[] {
  const slots = new Set<string>();
  return parts.filter((p) => {
    if (p.hidden && !SHUT_LID.test(p.name.replace(/([a-z])([A-Z])/g, "$1 $2"))) return false;
    if (!p.slot || p.hidden) return true;
    if (slots.has(p.slot)) return false;
    slots.add(p.slot);
    return true;
  }).map((p) => {
    const img = scaled(p, scale);
    return { name: p.name, path: p.name, left: p.left * scale, top: p.top * scale, width: img.width, height: img.height, data: img.data, opacity: p.opacity, ...(p.bone ? { group: p.bone } : {}), ...(p.hidden ? { shut: true } : {}) };
  });
}

export interface SourceMatch { file: string; iou: number; colorDiff: number; ok: boolean; problem?: string }

export function matchSource(loaded: ReturnType<typeof loadParts>): SourceMatch | null {
  const { source, sourceOffset } = loaded.layout;
  if (!source) return null;
  if (!existsSync(source)) return { file: source, iou: 0, colorDiff: 1, ok: false, problem: "the layout's source image was not found" };
  let png: PNG;
  try { png = PNG.sync.read(readFileSync(source)); } catch (e) { return { file: source, iou: 0, colorDiff: 1, ok: false, problem: `not a readable PNG (${(e as Error).message.split("\n")[0]})` }; }
  const shown = rigParts(loaded.parts, 1).filter((p) => !p.shut);
  if (!shown.length) return { file: source, iou: 0, colorDiff: 1, ok: false, problem: "no visible parts" };
  const [ox, oy] = sourceOffset ?? [0, 0];
  const minX = Math.min(ox, ...shown.map((p) => Math.floor(p.left))), minY = Math.min(oy, ...shown.map((p) => Math.floor(p.top)));
  const maxX = Math.max(ox + png.width, ...shown.map((p) => Math.ceil(p.left + p.width))), maxY = Math.max(oy + png.height, ...shown.map((p) => Math.ceil(p.top + p.height)));
  const w = maxX - minX, h = maxY - minY;
  const comp = new Float32Array(w * h * 4);
  for (const p of shown) for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
    const tx = Math.round(p.left - minX) + x, ty = Math.round(p.top - minY) + y;
    if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
    const si = (y * p.width + x) * 4, di = (ty * w + tx) * 4, sa = (p.data[si + 3]! / 255) * p.opacity;
    if (sa <= 0) continue;
    for (let c = 0; c < 3; c++) comp[di + c] = (p.data[si + c]! / 255) * sa + comp[di + c]! * (1 - sa);
    comp[di + 3] = sa + comp[di + 3]! * (1 - sa);
  }
  let inter = 0, union = 0, diff = 0, inside = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const di = (y * w + x) * 4, sx = x + minX - ox, sy = y + minY - oy;
    const si = sx >= 0 && sy >= 0 && sx < png.width && sy < png.height ? (sy * png.width + sx) * 4 : -1;
    const sa = si >= 0 ? png.data[si + 3]! / 255 : 0, ca = comp[di + 3]!;
    if (sa > 0.5 && ca > 0.5) inter++;
    if (sa > 0.5 || ca > 0.5) union++;
    if (sa > 0.5) {
      inside++;
      let m = 0;
      for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(comp[di + c]! - (png.data[si + c]! / 255) * sa));
      diff += m;
    }
  }
  const iou = union ? inter / union : 0, colorDiff = inside ? diff / inside : 1;
  return { file: source, iou: +iou.toFixed(4), colorDiff: +colorDiff.toFixed(4), ok: iou >= 0.97 && colorDiff <= 0.05 };
}

export function placedByCounts(parts: LoadedPart[]): { placedBy?: { cut: number; filled: number } } {
  const cut = parts.filter((p) => p.placedBy === "cut").length, filled = parts.filter((p) => p.placedBy === "filled").length;
  return cut + filled ? { placedBy: { cut, filled } } : {};
}

export function sourceImage(loaded: ReturnType<typeof loadParts>): { left: number; top: number; width: number; height: number; data: Uint8ClampedArray } | null {
  const { source, sourceOffset } = loaded.layout;
  if (!source || !existsSync(source)) return null;
  try {
    const png = PNG.sync.read(readFileSync(source));
    return { left: sourceOffset?.[0] ?? 0, top: sourceOffset?.[1] ?? 0, width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
  } catch { return null; }
}
