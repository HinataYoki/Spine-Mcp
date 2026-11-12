import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { initializeCanvas, readPsd, type Layer, type Psd } from "ag-psd";
import { PNG } from "pngjs";
import type { Config } from "../config.js";
import { cliFailed, type SpineCli } from "./cli.js";
import { loadParts, matchSource, partsToSkeleton, placedByCounts, rigParts, type SourceMatch } from "./parts.js";
import { loadProject, pruneDir, UserError } from "./project.js";
import { renderFrames } from "./render.js";
import type { SkeletonJson } from "./types.js";
import { compareFrames } from "./visual.js";
import { rigQa } from "./rigqa.js";
import { folderImages } from "./gaps.js";
import { prepareForImport } from "./intake.js";
import { validateSkeleton } from "./validate.js";
import { addAnimationLocked } from "./write.js";
import { removeQuiet } from "../platform.js";

// Pixel data only: ag-psd needs an ImageData factory, never a canvas, when reading with useImageData.
initializeCanvas(() => { throw new Error("canvas not available"); }, (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4), colorSpace: "srgb" }) as unknown as ImageData);

export interface ImportLayersOptions {
  /** Absolute path to a layered .psd. */
  psd?: string;
  /** Or: the skeleton JSON Esoteric's PhotoshopToSpine script wrote (its images folder next to it). */
  json?: string;
  /** Or: a folder of PNG parts placed by a layout JSON (See-through's layout.json, a cutting tool's parts.json or spine-mcp's own; see parts.ts). */
  parts?: string;
  /** The layout for parts (default: layout.json or parts.json in the parts folder or its parent). */
  layout?: string;
  /** New .spine project to create (never overwritten). Images go to an `images` folder next to it. */
  output: string;
  /** Skeleton name (default: the PSD file name; for parts, the output file name). */
  skeleton?: string;
  /**
   * Bones when the PSD has no [bone] tags: groups (default, one bone per group), root (everything on the root bone)
   * or layers (one bone per layer, e.g. for a flat PSD of separated parts). For parts, a group is the layout's bone name.
   */
  bones?: "groups" | "root" | "layers";
  /** Where the skeleton origin sits: bottom-center of the visible art (default), center, or the canvas' top-left. */
  origin?: "bottom-center" | "center" | "top-left";
  /** Image and position scale (default 1). */
  scale?: number;
  /** Keep hidden layers as attachments that start hidden (default false: skipped). */
  includeHidden?: boolean;
  apply?: boolean;
}

export interface PlannedSlot { slot: string; bone: string; attachments: string[]; setup: string | null; blend: string; alpha: number }

export interface ImportLayersResult {
  mode: "dry-run" | "created";
  psd?: { width: number; height: number; layers: number; groups: number };
  /** For a PhotoshopToSpine JSON: what it holds and the problems found before importing. */
  script?: { spine: string | null; images: string; bones: number; slots: number; attachments: number; missingImages: string[]; problems: string[] };
  /** For parts: the layout read, its kind, canvas size, parts placed and problems that block apply. */
  parts?: { layout: string; format: string; width: number | null; height: number | null; parts: number; problems: string[]; placedBy?: { cut: number; filled: number }; source?: SourceMatch };
  skeleton: string;
  bones: { name: string; parent: string | null; x: number; y: number }[];
  slots: PlannedSlot[];
  images: number;
  skipped: { layer: string; reason: string }[];
  project?: string;
  imagesDir?: string;
  verification?: { bones: number; slots: number; attachments: number; setupMatch: { iou: number; colorDiff: number; ok: boolean } | null };
  notes: string[];
  png?: Buffer;
}

type Tag = "ignore" | "bone" | "slot" | "merge";
export const TAG = /\[(ignore|bone|slot|merge)\]/gi;
export const tagsOf = (name: string) => new Set([...name.matchAll(TAG)].map((m) => m[1]!.toLowerCase() as Tag));
export const clean = (name: string) => name.replace(/\[[^\]]*\]/g, "").trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ") || "layer";

const BLEND: Record<string, string> = { multiply: "multiply", screen: "screen", "linear dodge": "additive", "color dodge": "additive", add: "additive" };

export interface Art { name: string; path: string; left: number; top: number; width: number; height: number; data: Uint8ClampedArray; opacity: number; blend: string; hidden: boolean }
export interface BoneDef { name: string; parent: string | null; members: Art[] }
export interface PlacedArt { art: Art; bone: string; slotGroup?: string }

/**
 * What Photoshop shows that a layer's own pixels do not: raster layer masks and clipping masks are baked into the
 * pixels, a group's opacity is passed down to its layers (Spine has no groups), and what cannot be baked is noted
 * (layer styles, vector masks, adjustment layers). Returns a new PSD; the input is not changed.
 */
export function bakePsd(psd: Psd): { psd: Psd; notes: string[] } {
  const notes: string[] = [];
  type Px = { left: number; top: number; width: number; height: number; data: Uint8ClampedArray };
  const alphaAt = (r: Px, x: number, y: number) => { const lx = x - r.left, ly = y - r.top; return lx < 0 || ly < 0 || lx >= r.width || ly >= r.height ? 0 : r.data[(ly * r.width + lx) * 4 + 3]! / 255; };
  const withData = (l: Layer, data: Uint8ClampedArray): Layer => ({ ...l, imageData: { width: l.imageData!.width, height: l.imageData!.height, data } as unknown as ImageData });
  const walk = (list: Layer[], opacity: number): Layer[] => {
    let base: Px | null = null, baseHidden = false, baseName = "";
    return list.map((l0) => {
      let l: Layer = opacity !== 1 && !l0.children ? { ...l0, opacity: (l0.opacity ?? 1) * opacity } : l0;
      const name = l.name ?? "layer";
      if (l.children) {
        if (l.clipping) notes.push(`Group "${name}" is clipped to the layer below; clipping is baked only for single layers.`);
        base = null;
        // A merged group keeps its own opacity; otherwise it passes it down.
        const merge = tagsOf(name).has("merge");
        return merge ? { ...l, children: walk(l.children, 1) } : { ...l, opacity: 1, children: walk(l.children, opacity * (l.opacity ?? 1)) };
      }
      if (l.adjustment) notes.push(`Adjustment layer "${name}" changes the layers below it in Photoshop; Spine draws them unadjusted.`);
      if (l.effects && Object.keys(l.effects).length) notes.push(`Layer "${name}" has layer styles (shadow, stroke, glow...); only its pixels are used: rasterize the style in Photoshop to keep it.`);
      if (l.vectorMask) notes.push(`Layer "${name}" has a vector mask, which is not applied: rasterize it in Photoshop.`);
      if (l.placedLayer) notes.push(`Layer "${name}" is a smart object: its current pixels are used.`);
      const img = l.imageData;
      if (img && img.width && img.height) {
        const r: Px = { left: l.left ?? 0, top: l.top ?? 0, width: img.width, height: img.height, data: img.data as Uint8ClampedArray };
        const m = l.mask;
        if (m?.imageData && !m.disabled) {
          // Mask value (grey) per canvas pixel; outside its bounds, its default colour.
          const data = new Uint8ClampedArray(r.data), mw = m.imageData.width, ml = m.left ?? 0, mt = m.top ?? 0, def = (m.defaultColor ?? 0) / 255;
          for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
            const mx = r.left + x - ml, my = r.top + y - mt;
            const v = mx >= 0 && my >= 0 && mx < mw && my < m.imageData.height ? m.imageData.data[(my * mw + mx) * 4]! / 255 : def;
            data[(y * r.width + x) * 4 + 3] = Math.round(data[(y * r.width + x) * 4 + 3]! * v);
          }
          l = withData({ ...l, mask: undefined }, data);
          r.data = data;
          notes.push(`Layer mask on "${name}" baked into its pixels.`);
        }
        if (l.clipping) {
          if (!base) notes.push(`"${name}" is clipped to a layer that has no pixels; left unclipped.`);
          else {
            const b = base as Px, data = new Uint8ClampedArray(r.data);
            for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) data[(y * r.width + x) * 4 + 3] = Math.round(data[(y * r.width + x) * 4 + 3]! * alphaAt(b, r.left + x, r.top + y));
            l = withData({ ...l, clipping: false, ...(baseHidden ? { hidden: true } : {}) }, data);
            notes.push(`Clipping mask baked: "${name}" cut to "${baseName}".`);
          }
          return l;
        }
        base = r; baseHidden = !!l.hidden; baseName = name;
      } else if (!l.clipping) { base = null; }
      return l;
    });
  };
  return { psd: { ...psd, children: walk(psd.children ?? [], 1) }, notes };
}

/** A layer's pixels, or a group composited into one image ([merge]). */
export function rasterize(layer: Layer): { left: number; top: number; width: number; height: number; data: Uint8ClampedArray } | null {
  if (!layer.children) {
    const img = layer.imageData;
    if (!img || !img.width || !img.height) return null;
    return { left: layer.left ?? 0, top: layer.top ?? 0, width: img.width, height: img.height, data: img.data as Uint8ClampedArray };
  }
  const parts = layer.children.filter((c) => !c.hidden).map((c) => ({ c, r: rasterize(c) })).filter((x) => x.r);
  if (!parts.length) return null;
  const left = Math.min(...parts.map((p) => p.r!.left)), top = Math.min(...parts.map((p) => p.r!.top));
  const right = Math.max(...parts.map((p) => p.r!.left + p.r!.width)), bottom = Math.max(...parts.map((p) => p.r!.top + p.r!.height));
  const width = right - left, height = bottom - top, out = new Uint8ClampedArray(width * height * 4);
  // Source-over in order (children are bottom to top), straight alpha.
  for (const { c, r } of parts) {
    const op = c.opacity ?? 1;
    for (let y = 0; y < r!.height; y++) for (let x = 0; x < r!.width; x++) {
      const si = (y * r!.width + x) * 4, di = ((y + r!.top - top) * width + (x + r!.left - left)) * 4;
      const sa = (r!.data[si + 3]! / 255) * op;
      if (sa <= 0) continue;
      const da = out[di + 3]! / 255, oa = sa + da * (1 - sa);
      for (let ch = 0; ch < 3; ch++) out[di + ch] = Math.round((r!.data[si + ch]! * sa + out[di + ch]! * da * (1 - sa)) / oa);
      out[di + 3] = Math.round(oa * 255);
    }
  }
  return { left, top, width, height, data: out };
}

/** Trims fully transparent margins (PSD layer bounds can be larger than the art). */
export function trim(r: { left: number; top: number; width: number; height: number; data: Uint8ClampedArray }) {
  let x0 = r.width, y0 = r.height, x1 = -1, y1 = -1;
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) if (r.data[(y * r.width + x) * 4 + 3]! > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const width = x1 - x0 + 1, height = y1 - y0 + 1, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) data.set(r.data.subarray(((y + y0) * r.width + x0) * 4, ((y + y0) * r.width + x0 + width) * 4), y * width * 4);
  return { left: r.left + x0, top: r.top + y0, width, height, data };
}

export function scaled(r: { width: number; height: number; data: Uint8ClampedArray }, s: number) {
  if (s === 1) return r;
  const width = Math.max(1, Math.round(r.width * s)), height = Math.max(1, Math.round(r.height * s)), data = new Uint8ClampedArray(width * height * 4);
  // Box filter over the source area of each target pixel, alpha-weighted colour.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx0 = Math.floor(x / s), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) / s)), sy0 = Math.floor(y / s), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) / s));
    let a = 0, rr = 0, g = 0, b = 0, n = 0;
    for (let yy = sy0; yy < Math.min(r.height, sy1); yy++) for (let xx = sx0; xx < Math.min(r.width, sx1); xx++) {
      const i = (yy * r.width + xx) * 4, al = r.data[i + 3]!;
      a += al; rr += r.data[i]! * al; g += r.data[i + 1]! * al; b += r.data[i + 2]! * al; n++;
    }
    const o = (y * width + x) * 4;
    if (a > 0) { data[o] = rr / a; data[o + 1] = g / a; data[o + 2] = b / a; data[o + 3] = a / n; }
  }
  return { width, height, data };
}

/**
 * Turns a layered PSD into a skeleton: one region attachment per layer at its canvas position, draw order from the
 * layer order, bones from groups ([bone] tags or the chosen mode), [slot] groups as one slot with several attachments,
 * [merge] groups flattened, [ignore] skipped. Pure: returns the skeleton and the images to write.
 */
export function layersToSkeleton(input: Psd, o: { skeleton: string; bones?: ImportLayersOptions["bones"]; origin?: ImportLayersOptions["origin"]; scale?: number; includeHidden?: boolean }) {
  const baked = bakePsd(input), psd = baked.psd;
  const s = o.scale ?? 1;
  const mode = o.bones ?? "groups";
  const usesTags = (function has(ls: Layer[]): boolean { return ls.some((l) => tagsOf(l.name ?? "").size > 0 || (l.children ? has(l.children) : false)); })(psd.children ?? []);
  const skipped: { layer: string; reason: string }[] = [];
  const notes: string[] = [...baked.notes];
  const arts: PlacedArt[] = [];
  const boneDefs: BoneDef[] = [{ name: "root", parent: null, members: [] }];
  // Bones and slots are separate name spaces in Spine (a "head" slot on a "head" bone is normal).
  const usedBones = new Set<string>(["root"]), usedSlots = new Set<string>();
  const uniqueIn = (set: Set<string>) => (base: string) => { let n = base, i = 2; while (set.has(n)) n = `${base}-${i++}`; set.add(n); return n; };
  const unique = uniqueIn(usedBones), uniqueSlot = uniqueIn(usedSlots);
  const usedPaths = new Set<string>();
  // Image paths unique ignoring case: they become files, and macOS and Windows file systems do not tell "Arm" from "arm".
  const uniquePath = (base: string) => { let n = base, i = 2; while (usedPaths.has(n.toLowerCase())) n = `${base}-${i++}`; usedPaths.add(n.toLowerCase()); return n; };
  let groups = 0, layers = 0;

  const visit = (list: Layer[], bone: string, folder: string, slotGroup: string | undefined) => {
    for (const l of list) {
      const raw = l.name ?? "layer", tags = tagsOf(raw), name = clean(raw);
      if (tags.has("ignore")) { skipped.push({ layer: raw, reason: "[ignore]" }); continue; }
      // Hidden layers inside a [slot] group are its other attachments (a closed eye, another hand): kept.
      if (l.hidden && !o.includeHidden && !slotGroup) { skipped.push({ layer: raw, reason: "hidden" }); continue; }
      if (l.children && !tags.has("merge")) {
        groups++;
        const isBone = usesTags ? tags.has("bone") : mode === "groups";
        let childBone = bone;
        if (isBone) { childBone = unique(name); boneDefs.push({ name: childBone, parent: bone, members: [] }); }
        const sg = tags.has("slot") ? uniqueSlot(name) : slotGroup;
        visit(l.children, childBone, `${folder}${name}/`, sg);
        continue;
      }
      layers++;
      const r0 = rasterize(l), r = r0 && trim(r0);
      if (!r) { skipped.push({ layer: raw, reason: l.children ? "empty group" : "no pixels (adjustment, empty or text without pixels)" }); continue; }
      const blendIn = (l.blendMode ?? "normal").toLowerCase();
      const blend = BLEND[blendIn] ?? "normal";
      if (blend === "normal" && blendIn !== "normal" && blendIn !== "pass through") notes.push(`Layer "${raw}" blend mode "${blendIn}" has no Spine equivalent; normal used.`);
      const art: Art = { name, path: uniquePath(`${folder}${name}`), left: r.left, top: r.top, width: r.width, height: r.height, data: r.data, opacity: l.opacity ?? 1, blend, hidden: !!l.hidden };
      let ownBone = bone;
      if (!usesTags && mode === "layers") { ownBone = unique(name); boneDefs.push({ name: ownBone, parent: bone, members: [] }); }
      boneDefs.find((b) => b.name === ownBone)!.members.push(art);
      arts.push({ art, bone: ownBone, slotGroup });
    }
  };
  visit(psd.children ?? [], "root", "", undefined);
  if (!arts.length) throw new UserError("No visible layers with pixels in the PSD.");
  if (usesTags) notes.push("PSD tags read: [bone] groups became bones, [slot] groups one slot with an attachment per layer, [merge] groups one image, [ignore] skipped.");
  return { ...planSkeleton(arts, boneDefs, { origin: o.origin, scale: s }, usedSlots), skipped, notes, counts: { groups, layers } };
}

/**
 * Placed art (in draw order, canvas pixels, y down) → skeleton JSON: the origin, bones at the centre of the art under
 * them (or at a given pivot), one slot per art or per slot group, region attachments, images scaled. Shared by PSD
 * layers and folders of parts.
 */
export function planSkeleton(arts: PlacedArt[], boneDefs: BoneDef[], o: { origin?: ImportLayersOptions["origin"]; scale?: number; pivots?: Map<string, [number, number]> }, usedSlots = new Set(arts.flatMap((a) => (a.slotGroup ? [a.slotGroup] : [])))) {
  const s = o.scale ?? 1;
  const uniqueSlot = (base: string) => { let n = base, i = 2; while (usedSlots.has(n)) n = `${base}-${i++}`; usedSlots.add(n); return n; };

  // Origin in PSD pixels (y down).
  const vis = arts.filter((a) => !a.art.hidden).map((a) => a.art);
  const minX = Math.min(...vis.map((a) => a.left)), maxX = Math.max(...vis.map((a) => a.left + a.width));
  const minY = Math.min(...vis.map((a) => a.top)), maxY = Math.max(...vis.map((a) => a.top + a.height));
  const ox = o.origin === "top-left" ? 0 : (minX + maxX) / 2;
  const oy = o.origin === "top-left" ? 0 : o.origin === "center" ? (minY + maxY) / 2 : maxY;
  const toSpine = (x: number, y: number) => ({ x: +((x - ox) * s).toFixed(2), y: +((oy - y) * s).toFixed(2) });

  // Bone positions: the given pivot, else the centre of the art under them (children included), relative to the parent bone.
  const world = new Map<string, { x: number; y: number }>([["root", { x: 0, y: 0 }]]);
  const under = (bone: string): Art[] => [...boneDefs.find((b) => b.name === bone)!.members, ...boneDefs.filter((b) => b.parent === bone).flatMap((b) => under(b.name))];
  for (const b of boneDefs.slice(1)) {
    const pivot = o.pivots?.get(b.name);
    if (pivot) { world.set(b.name, toSpine(pivot[0], pivot[1])); continue; }
    const a = under(b.name);
    const cx = a.length ? (Math.min(...a.map((x) => x.left)) + Math.max(...a.map((x) => x.left + x.width))) / 2 : ox;
    const cy = a.length ? (Math.min(...a.map((x) => x.top)) + Math.max(...a.map((x) => x.top + x.height))) / 2 : oy;
    world.set(b.name, toSpine(cx, cy));
  }
  const bones = boneDefs.map((b) => {
    const w = world.get(b.name)!, p = b.parent ? world.get(b.parent)! : { x: 0, y: 0 };
    return { name: b.name, parent: b.parent, x: +(w.x - p.x).toFixed(2), y: +(w.y - p.y).toFixed(2) };
  });

  // Slots in draw order (PSD children run bottom to top, like Spine's draw order).
  const slotsOut: { name: string; bone: string; attachment?: string; color?: string; blend?: string }[] = [];
  const skin: Record<string, Record<string, Record<string, unknown>>> = {};
  const planned: PlannedSlot[] = [];
  const images: { path: string; width: number; height: number; data: Uint8ClampedArray }[] = [];
  // A shared slot takes its bone, place in draw order, opacity and blend from the part it shows at setup (its first
  // visible member, else its first): members of a parts layout need not be next to each other or on one bone.
  const lead = new Map<string, PlacedArt>();
  for (const a of arts) if (a.slotGroup && (!lead.has(a.slotGroup) || (lead.get(a.slotGroup)!.art.hidden && !a.art.hidden))) lead.set(a.slotGroup, a);
  const alphaHex = (opacity: number) => `ffffff${Math.round(opacity * 255).toString(16).padStart(2, "0")}`;
  // Slots in draw order: one per ungrouped part, one per group where its lead is.
  const slotOf = new Map<PlacedArt, string>();
  for (const a of arts) {
    if (a.slotGroup && lead.get(a.slotGroup) !== a) continue;
    const slot = a.slotGroup ?? uniqueSlot(a.art.name);
    slotOf.set(a, slot);
    slotsOut.push({ name: slot, bone: a.bone, ...(a.art.opacity < 1 ? { color: alphaHex(a.art.opacity) } : {}), ...(a.art.blend !== "normal" ? { blend: a.art.blend } : {}) });
    planned.push({ slot, bone: a.bone, attachments: [], setup: null, blend: a.art.blend, alpha: a.art.opacity });
  }
  for (const a of arts) {
    const { art, slotGroup } = a;
    const slot = slotGroup ? slotOf.get(lead.get(slotGroup)!)! : slotOf.get(a)!;
    const so = slotsOut.find((x) => x.name === slot)!, pl = planned.find((x) => x.slot === slot)!;
    const img = scaled(art, s);
    images.push({ path: art.path, width: img.width, height: img.height, data: img.data });
    // Relative to the slot's bone: parts sharing a slot may name different bones (a parts layout, bones: layers).
    const centre = toSpine(art.left + art.width / 2, art.top + art.height / 2), bw = world.get(so.bone)!;
    const attName = slotGroup ? art.name : art.path.split("/").pop()!;
    (skin[slot] ??= {})[attName] = { ...(attName !== art.path ? { path: art.path } : {}), x: +(centre.x - bw.x).toFixed(2), y: +(centre.y - bw.y).toFixed(2), width: img.width, height: img.height };
    pl.attachments.push(attName);
    // The first visible attachment of a slot is its setup attachment (a [slot] group shows one at a time).
    if (!art.hidden && !so.attachment) { so.attachment = attName; pl.setup = attName; }
  }
  const doc: SkeletonJson = {
    skeleton: { spine: "4.3.26", x: +((minX - ox) * s).toFixed(2), y: +((oy - maxY) * s).toFixed(2), width: +((maxX - minX) * s).toFixed(2), height: +((maxY - minY) * s).toFixed(2), images: "./images/" },
    bones: bones.map((b) => ({ name: b.name, ...(b.parent ? { parent: b.parent } : {}), ...(b.x ? { x: b.x } : {}), ...(b.y ? { y: b.y } : {}) })),
    slots: slotsOut as SkeletonJson["slots"],
    skins: [{ name: "default", attachments: skin as never }],
    animations: {},
  };
  return { doc, images, bones, planned };
}

export const writePng = (file: string, img: { width: number; height: number; data: Uint8ClampedArray }) => {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, PNG.sync.write(png));
};

/**
 * PSD (or PNG parts with a layout) → new Spine project through the CLI's JSON import: images written next to the
 * project, one slot per layer, bones from groups, then verified by re-exporting and by Spine rendering the setup pose
 * against the PSD's own composite (or the parts composed at their layout positions). Places the art; rigging (meshes,
 * weights, pivots, constraints) stays with the animator.
 */
export async function importLayers(config: Config, cli: SpineCli, o: ImportLayersOptions): Promise<ImportLayersResult> {
  if ([o.psd, o.json, o.parts].filter(Boolean).length !== 1) throw new UserError("Pass one of psd (a layered .psd), json (PhotoshopToSpine's output) or parts (a folder of PNG parts with a layout JSON).");
  if (o.json) return importScriptJson(config, cli, o as ImportLayersOptions & { json: string });
  if (o.psd && (!isAbsolute(o.psd) || !existsSync(o.psd) || extname(o.psd).toLowerCase() !== ".psd")) throw new UserError(`psd must be an absolute path to an existing .psd: ${o.psd}`);
  if (!isAbsolute(o.output) || extname(o.output).toLowerCase() !== ".spine") throw new UserError(`output must be an absolute path ending in .spine: ${o.output}`);
  if (existsSync(o.output)) throw new UserError(`${o.output} already exists; spine_import_layers only creates new projects.`);
  if (!existsSync(dirname(o.output))) throw new UserError(`Folder does not exist: ${dirname(o.output)}`);
  const imagesDir = join(dirname(o.output), "images");
  if (existsSync(imagesDir) && readdirSync(imagesDir).length) throw new UserError(`${imagesDir} already has files; choose an empty folder for the new project.`);
  const scale = o.scale ?? 1;
  if (!(scale > 0 && scale <= 4)) throw new UserError("scale must be between 0 and 4");
  let name: string, plan: ReturnType<typeof layersToSkeleton>, result: ImportLayersResult, reference: () => { width: number; height: number; data: Uint8ClampedArray }, source: string;
  if (o.parts) {
    const loaded = loadParts({ parts: o.parts, layout: o.layout });
    name = (o.skeleton ?? basename(o.output, extname(o.output))).replace(/[^\w.-]+/g, "_");
    plan = partsToSkeleton(loaded, { bones: o.bones, origin: o.origin, scale, includeHidden: o.includeHidden });
    const { layout } = loaded;
    const sourceMatch = loaded.problems.length ? null : matchSource(loaded);
    result = {
      mode: "dry-run", parts: { layout: layout.file, format: layout.format, width: layout.width ?? null, height: layout.height ?? null, parts: loaded.parts.length, problems: loaded.problems.slice(0, 20), ...placedByCounts(loaded.parts), ...(sourceMatch ? { source: sourceMatch } : {}) }, skeleton: name,
      bones: plan.bones, slots: plan.planned.slice(0, 200), images: plan.images.length, skipped: plan.skipped.slice(0, 60), notes: plan.notes.slice(0, 20),
    };
    // The reference is drawn from the layout's own positions, not from the planned skeleton, so placement errors show.
    reference = () => compositeParts(rigParts(loaded.parts, scale).filter((p) => !p.shut));
    source = "the parts composed at their layout positions";
    if (sourceMatch && !sourceMatch.ok) result.notes.push(sourceMatch.problem ? `Source ${sourceMatch.file}: ${sourceMatch.problem}.` : `The parts at rest differ from the layout's source painting (IoU ${sourceMatch.iou}, colour ${sourceMatch.colorDiff}): a part is missing, moved, or repainted where it shows.`);
    if (loaded.parts.some((p) => p.placedBy === "cut") && loaded.parts.some((p) => p.placedBy === "filled")) result.notes.push("Some parts are the cut and some the filled cut (by image size): pass one folder of the same kind for all of them.");
    if (loaded.problems.length) {
      result.notes.push("Fix the layout problems before importing (apply is refused while they remain).");
      if (o.apply) throw new UserError(`Not importing: ${loaded.problems.slice(0, 5).join("; ")}`);
      return result;
    }
  } else {
    const psd = readPsd(readFileSync(o.psd!), { useImageData: true });
    name = (o.skeleton ?? basename(o.psd!, extname(o.psd!))).replace(/[^\w.-]+/g, "_");
    const p = plan = layersToSkeleton(psd, { skeleton: name, bones: o.bones, origin: o.origin, scale, includeHidden: o.includeHidden });
    result = {
      mode: "dry-run", psd: { width: psd.width, height: psd.height, layers: plan.counts.layers, groups: plan.counts.groups }, skeleton: name,
      bones: plan.bones, slots: plan.planned.slice(0, 200), images: plan.images.length, skipped: plan.skipped.slice(0, 60), notes: plan.notes.slice(0, 20),
    };
    reference = () => compositeVisible(p);
    source = "the PSD composite";
  }
  if (!o.apply) {
    result.notes.push(`apply: true writes ${plan.images.length} image(s) to ${imagesDir}, creates ${o.output} through the Spine CLI and verifies it against ${source}.`);
    return result;
  }

  // Write: images, the skeleton JSON (in the work folder), then the CLI import creates the project.
  const work = join(config.workDir, "layers", `${name}-${Date.now()}`);
  pruneDir(join(config.workDir, "layers"), 10);
  mkdirSync(work, { recursive: true });
  let created = false;
  try {
    for (const img of plan.images) writePng(join(imagesDir, `${img.path}.png`), img);
    // The skeleton takes the JSON file's name; its images path is relative to the JSON, so the JSON sits in a hidden
    // folder next to the project and points one level up.
    const tmp = join(dirname(o.output), `.spine-mcp-import-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    const jsonFile = join(tmp, `${name}.json`);
    writeFileSync(jsonFile, JSON.stringify({ ...plan.doc, skeleton: { ...plan.doc.skeleton, images: "../images/" } }));
    let run: Awaited<ReturnType<SpineCli["run"]>>;
    try { run = await cli.run(["-i", jsonFile, "-o", o.output, "-r"]); } finally { removeQuiet(tmp); }
    if (cliFailed(run) || run.warnings.length || !existsSync(o.output)) throw new UserError(`Spine import failed: ${[...run.errors, ...run.warnings, ...run.lines.slice(-3)].slice(0, 5).join(" | ")}`);
    created = true;
    result.mode = "created";
    result.project = o.output;
    result.imagesDir = imagesDir;

    // Verify: the project re-exports with the same skeleton.
    const loaded = await loadProject(config, cli, o.output, { refresh: true });
    const doc = loaded.skeletons[0]!.doc;
    const attachments = (doc.skins ?? []).reduce((n, sk) => n + Object.values(sk.attachments ?? {}).reduce((m, a) => m + Object.keys(a).length, 0), 0);
    const want = plan.doc.skins![0]!.attachments!;
    const wantAttachments = Object.values(want).reduce((m, a) => m + Object.keys(a).length, 0);
    const differences: string[] = [];
    if (doc.bones.length !== plan.doc.bones.length) differences.push(`bones ${doc.bones.length} vs ${plan.doc.bones.length}`);
    if ((doc.slots ?? []).length !== (plan.doc.slots ?? []).length) differences.push(`slots ${(doc.slots ?? []).length} vs ${(plan.doc.slots ?? []).length}`);
    if (attachments !== wantAttachments) differences.push(`attachments ${attachments} vs ${wantAttachments}`);
    if ((doc.slots ?? []).map((x) => x.name).join("|") !== (plan.doc.slots ?? []).map((x) => x.name).join("|")) differences.push("draw order differs");
    if (differences.length) throw new UserError(`The created project does not match the plan: ${differences.join("; ")}.`);

    // Spine draws the setup pose (a temporary copy gets a one-frame animation) and it is compared with the PSD composite.
    let setupMatch: NonNullable<ImportLayersResult["verification"]>["setupMatch"] = null;
    try {
      const copy = join(work, `${name}.spine`);
      writeFileSync(copy, readFileSync(o.output));
      mkdirSync(join(work, "images"), { recursive: true });
      for (const img of plan.images) { const f = join(imagesDir, `${img.path}.png`), t = join(work, "images", `${img.path}.png`); mkdirSync(dirname(t), { recursive: true }); writeFileSync(t, readFileSync(f)); }
      await addAnimationLocked(config, cli, { project: copy, name: "spine-mcp-setup", animation: { bones: { root: { rotate: [{ value: 0 }, { time: 0.1, value: 0 }] } } }, apply: true, editor: "inPlace" });
      const r = await renderFrames(config, cli, copy, { skeleton: name, animation: "spine-mcp-setup", fps: 10, scale: 100, background: "7f7f7fff" });
      const ref = join(work, "psd.png");
      writePng(ref, reference());
      const grey = join(work, "psd-grey.png");
      flattenOnGrey(ref, grey);
      const c = compareFrames(grey, r.frames[0]!, [127, 127, 127]);
      setupMatch = { iou: +c.iou.toFixed(4), colorDiff: +c.colorDiff.toFixed(4), ok: c.iou >= 0.97 && c.colorDiff <= 0.05 };
      result.png = c.diffPng();
    } catch (e) {
      result.notes.push(`Setup pose render check skipped: ${(e as Error).message.split("\n")[0]}`);
    }
    result.verification = { bones: doc.bones.length, slots: (doc.slots ?? []).length, attachments, setupMatch };
    result.notes.push(
      `Created ${o.output} with ${plan.images.length} image(s) in ${imagesDir}. Bones sit at the centre of the art under them: move pivots to the joints in Spine before animating.`,
      "Only the art is placed: meshes, weights, pivots, IK and physics are the animator's work. Check names and grouping with spine_rig_qa.",
    );
    return result;
  } catch (e) {
    // Nothing half-made stays behind.
    if (!created) { rmSync(o.output, { force: true }); for (const img of plan.images) rmSync(join(imagesDir, `${img.path}.png`), { force: true }); }
    throw e;
  } finally {
    removeQuiet(work);
  }
}

/** The visible layers composited as placed (the reference for the setup-pose check), scaled and cropped to the art. */
function compositeVisible(plan: ReturnType<typeof layersToSkeleton>) {
  const vis = plan.doc.slots!.filter((x) => x.attachment);
  const sk = plan.doc;
  const w = Math.ceil(sk.skeleton.width as number), h = Math.ceil(sk.skeleton.height as number);
  const out = new Uint8ClampedArray(w * h * 4);
  const boneWorld = new Map<string, { x: number; y: number }>();
  for (const b of sk.bones) { const p = b.parent ? boneWorld.get(b.parent)! : { x: 0, y: 0 }; boneWorld.set(b.name, { x: p.x + (b.x ?? 0), y: p.y + (b.y ?? 0) }); }
  for (const slot of vis) {
    const att = (sk.skins![0]!.attachments as Record<string, Record<string, { path?: string; x: number; y: number; width: number; height: number }>>)[slot.name]![slot.attachment!]!;
    const img = plan.images.find((i) => i.path === (att.path ?? slot.attachment))!;
    const bw = boneWorld.get(slot.bone)!;
    const left = Math.round(bw.x + att.x - att.width / 2 - (sk.skeleton.x as number)), top = Math.round(h - (bw.y + att.y + att.height / 2 - (sk.skeleton.y as number)));
    const alpha = slot.color ? parseInt(slot.color.slice(6, 8), 16) / 255 : 1;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const tx = x + left, ty = y + top;
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
      const si = (y * img.width + x) * 4, di = (ty * w + tx) * 4, sa = (img.data[si + 3]! / 255) * alpha;
      if (sa <= 0) continue;
      const da = out[di + 3]! / 255, oa = sa + da * (1 - sa);
      for (let ch = 0; ch < 3; ch++) out[di + ch] = Math.round((img.data[si + ch]! * sa + out[di + ch]! * da * (1 - sa)) / oa);
      out[di + 3] = Math.round(oa * 255);
    }
  }
  return { width: w, height: h, data: out };
}

/** Parts composited at their places in draw order, cropped to the art (the reference for render checks). */
export function compositeParts(parts: { left: number; top: number; width: number; height: number; data: Uint8ClampedArray; opacity: number }[]) {
  const minX = Math.floor(Math.min(...parts.map((p) => p.left))), minY = Math.floor(Math.min(...parts.map((p) => p.top)));
  const w = Math.ceil(Math.max(...parts.map((p) => p.left + p.width)) - minX), h = Math.ceil(Math.max(...parts.map((p) => p.top + p.height)) - minY);
  const out = new Uint8ClampedArray(w * h * 4);
  for (const p of parts) for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
    const tx = Math.round(p.left - minX) + x, ty = Math.round(p.top - minY) + y;
    if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
    const si = (y * p.width + x) * 4, di = (ty * w + tx) * 4, sa = (p.data[si + 3]! / 255) * p.opacity;
    if (sa <= 0) continue;
    const da = out[di + 3]! / 255, oa = sa + da * (1 - sa);
    for (let c = 0; c < 3; c++) out[di + c] = Math.round((p.data[si + c]! * sa + out[di + c]! * da * (1 - sa)) / oa);
    out[di + 3] = Math.round(oa * 255);
  }
  return { width: w, height: h, data: out };
}

export function flattenOnGrey(src: string, dst: string) {
  const p = PNG.sync.read(readFileSync(src));
  for (let i = 0; i < p.data.length; i += 4) {
    const a = p.data[i + 3]! / 255;
    for (let c = 0; c < 3; c++) p.data[i + c] = Math.round(p.data[i + c]! * a + 127 * (1 - a));
    p.data[i + 3] = 255;
  }
  writeFileSync(dst, PNG.sync.write(p));
}

/**
 * PhotoshopToSpine's output (a skeleton JSON and its images) into a new project through the CLI, the same way the
 * editor's Import Data does: checked first (validator, images the JSON names, Spine version), then imported (any
 * warning fails), re-exported and drawn by Spine. The images stay where the script wrote them.
 */
async function importScriptJson(config: Config, cli: SpineCli, o: ImportLayersOptions & { json: string }): Promise<ImportLayersResult> {
  if (!isAbsolute(o.json) || !existsSync(o.json) || extname(o.json).toLowerCase() !== ".json") throw new UserError(`json must be an absolute path to an existing .json: ${o.json}`);
  if (!isAbsolute(o.output) || extname(o.output).toLowerCase() !== ".spine") throw new UserError(`output must be an absolute path ending in .spine: ${o.output}`);
  if (existsSync(o.output)) throw new UserError(`${o.output} already exists; spine_import_layers only creates new projects.`);
  if (!existsSync(dirname(o.output))) throw new UserError(`Folder does not exist: ${dirname(o.output)}`);
  let doc: SkeletonJson;
  try { doc = JSON.parse(readFileSync(o.json, "utf8")) as SkeletonJson; } catch (e) { throw new UserError(`Not valid JSON: ${(e as Error).message}`); }
  if (!doc.skeleton || !Array.isArray(doc.bones)) throw new UserError("This JSON is not a Spine skeleton (no skeleton or bones).");
  const name = (o.skeleton ?? basename(o.json, ".json")).replace(/[^\w.-]+/g, "_");
  const imagesDir = resolve(dirname(o.json), doc.skeleton.images ?? "./images/");
  const intake = prepareForImport(doc, folderImages(imagesDir));
  const qa = rigQa(doc, { baseDir: dirname(o.json) });
  const missingImages = qa.findings.filter((f) => f.code === "image-missing").flatMap((f) => f.items ?? []);
  const problems = validateSkeleton(doc).filter((i) => i.severity === "error").map((i) => `${i.code}: ${i.message}`.slice(0, 160));
  const attachments = (doc.skins ?? []).reduce((n, sk) => n + Object.values(sk.attachments ?? {}).reduce((m, a) => m + Object.keys(a).length, 0), 0);
  const version = typeof doc.skeleton.spine === "string" ? doc.skeleton.spine : null;
  const result: ImportLayersResult = {
    mode: "dry-run", skeleton: name, bones: doc.bones.map((b) => ({ name: b.name, parent: b.parent ?? null, x: b.x ?? 0, y: b.y ?? 0 })).slice(0, 200), slots: [], images: 0, skipped: [],
    script: { spine: version, images: imagesDir, bones: doc.bones.length, slots: (doc.slots ?? []).length, attachments, missingImages: missingImages.slice(0, 40), problems: problems.slice(0, 20) },
    notes: [],
  };
  result.notes.push(...intake);
  if (!existsSync(imagesDir)) result.notes.push(`Images folder not found: ${imagesDir}. The script writes it next to the JSON; keep them together.`);
  // The script writes bones, slots and region attachments only, which read the same in every 4.x format: such data is
  // tagged with the pinned version so Spine does not warn. Anything else from another version is refused.
  const simple = !doc.animations || !Object.keys(doc.animations).length ? !(doc.constraints?.length || (doc as { ik?: unknown[] }).ik?.length || (doc as { transform?: unknown[] }).transform?.length || (doc as { path?: unknown[] }).path?.length || (doc as { physics?: unknown[] }).physics?.length)
    && (doc.skins ?? []).every((sk) => Object.values(sk.attachments ?? {}).every((a) => Object.values(a as Record<string, { type?: string }>).every((x) => !x.type || x.type === "region"))) : false;
  const retag = !!version && !version.startsWith(config.spineVersion.split(".").slice(0, 2).join("."));
  if (retag && simple) result.notes.push(`Written as Spine ${version} data; it holds only bones, slots and regions (the same in every 4.x format), so it is imported as ${config.spineVersion}.`);
  else if (retag) problems.push(`Spine ${version} data with meshes, constraints or animations: import it with Spine ${version} first, or re-export it from the script for ${config.spineVersion}.`);
  result.script!.problems = problems.slice(0, 20);
  if (missingImages.length || problems.length || !existsSync(imagesDir)) {
    result.notes.push("Fix the missing images / problems before importing (apply is refused while they remain).");
    if (o.apply) throw new UserError(`Not importing: ${[...missingImages.slice(0, 5).map((m) => `missing image ${m}`), ...problems.slice(0, 5)].join("; ") || "images folder missing"}`);
    return result;
  }
  if (!o.apply) { result.notes.push(`apply: true creates ${o.output} through the Spine CLI (images stay in ${imagesDir}).`); return result; }
  const tmp = join(dirname(o.output), `.spine-mcp-import-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const rel = relative(tmp, imagesDir).split(sep).join("/");
  writeFileSync(join(tmp, `${name}.json`), JSON.stringify({ ...doc, skeleton: { ...doc.skeleton, images: `${rel}/`, ...(retag ? { spine: config.spineVersion } : {}) } }));
  let run: Awaited<ReturnType<SpineCli["run"]>>;
  try { run = await cli.run(["-i", join(tmp, `${name}.json`), "-o", o.output, "-r"]); } finally { removeQuiet(tmp); }
  if (cliFailed(run) || run.warnings.length || !existsSync(o.output)) { rmSync(o.output, { force: true }); throw new UserError(`Spine import failed: ${[...run.errors, ...run.warnings, ...run.lines.slice(-3)].slice(0, 5).join(" | ")}`); }
  result.mode = "created";
  result.project = o.output;
  result.imagesDir = imagesDir;
  const after = (await loadProject(config, cli, o.output, { refresh: true })).skeletons[0]!.doc;
  const got = (after.skins ?? []).reduce((n, sk) => n + Object.values(sk.attachments ?? {}).reduce((m, a) => m + Object.keys(a).length, 0), 0);
  result.verification = { bones: after.bones.length, slots: (after.slots ?? []).length, attachments: got, setupMatch: null };
  if (after.bones.length !== doc.bones.length || got !== attachments) result.notes.push(`The project holds ${after.bones.length} bones / ${got} attachments; the JSON had ${doc.bones.length} / ${attachments}.`);
  // Spine's own drawing of the setup pose, on a private copy.
  const work = join(config.workDir, "layers", `${name}-${Date.now()}`);
  try {
    const projDir = join(work, "p");
    mkdirSync(projDir, { recursive: true });
    const copy = join(projDir, basename(o.output));
    writeFileSync(copy, readFileSync(o.output));
    const imgRel = relative(dirname(o.output), imagesDir);
    if (!isAbsolute(imgRel) && !imgRel.startsWith("..")) cpSync(imagesDir, join(projDir, imgRel), { recursive: true });
    else throw new UserError("images live outside the project folder");
    await addAnimationLocked(config, cli, { project: copy, name: "spine-mcp-setup", animation: { bones: { [after.bones[0]!.name]: { rotate: [{ value: 0 }, { time: 0.1, value: 0 }] } } }, apply: true, editor: "inPlace", allowUpgrade: true });
    const r = await renderFrames(config, cli, copy, { skeleton: name, animation: "spine-mcp-setup", fps: 10, scale: 100, background: "7f7f7fff" });
    result.png = readFileSync(r.frames[0]!);
  } catch (e) {
    result.notes.push(`Setup pose render skipped: ${(e as Error).message.split("\n")[0]}`);
  } finally {
    removeQuiet(work);
  }
  result.notes.push(`Created ${o.output} from the PhotoshopToSpine output; images stay in ${imagesDir}. Check names and grouping with spine_rig_qa.`);
  return result;
}
