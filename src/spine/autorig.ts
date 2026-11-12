import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { readPsd, type Layer, type Psd } from "ag-psd";
import { PNG } from "pngjs";
import type { Config } from "../config.js";
import { cliFailed, type SpineCli } from "./cli.js";
import { alphaContour, meshPolygon, offsetPolygon, signedArea, simplify, type Pt } from "./geometry.js";
import { bakePsd, clean, compositeParts as composite, flattenOnGrey, rasterize, scaled, tagsOf, trim, writePng } from "./layers.js";
import { loadParts, rigParts, sourceImage } from "./parts.js";
import type { SourceImage } from "./cutqa.js";
import { assertInputPath, loadProject, pickSkeleton, pruneDir, UserError } from "./project.js";
import { contactSheet, renderFrames } from "./render.js";
import { rigQa } from "./rigqa.js";
import { loadSkeletonData, spine } from "./runtime.js";
import { roundValue } from "./tidy.js";
import type { SkeletonJson } from "./types.js";
import { validateSkeleton } from "./validate.js";
import { compareFrames } from "./visual.js";
import { addAnimationLocked } from "./write.js";
import { removeQuiet } from "../platform.js";

export interface RigBoneSpec {
  name: string;
  /** Parent bone (default root). */
  parent?: string;
  /** Pivot in PSD pixels (x right, y down): the joint the bone turns around. */
  joint: [number, number];
  /** Far end in PSD pixels: sets the bone's direction and length (default: no length, pointing right). */
  tip?: [number, number];
  /** Layers this bone carries (default: the layer with the bone's name). */
  layers?: string[];
}

export interface RigIkSpec {
  /** Parent and child bone of a two-bone chain (e.g. ["thigh", "shin"]). */
  bones: [string, string];
  /** Name of the target bone created at the child's tip (default `<child>-target`). */
  target?: string;
  /** Bend direction (default: from the drawn pose). */
  bendPositive?: boolean;
}

export interface AutoRigOptions {
  psd?: string;
  /** Or: a folder of PNG parts placed by a layout JSON (as spine_import_layers reads it). */
  parts?: string;
  layout?: string;
  output: string;
  skeleton?: string;
  /** The joints. Without them the result suggests a set from the art (overlaps between parts) and writes nothing. */
  bones?: RigBoneSpec[];
  ik?: RigIkSpec[];
  /** auto (default): a mesh per layer traced from its alpha; none: region attachments. */
  mesh?: "auto" | "none" | "sparse";
  /** smooth (default): vertices near a joint are shared with the neighbouring bone; rigid: one bone per layer. */
  weights?: "smooth" | "rigid" | "joint";
  /** Spacing of interior mesh points in PSD pixels (default: a quarter of the part's smaller side, 10-40). */
  density?: number;
  /** Radius around a joint where weights blend, in PSD pixels (default: 30% of the part's smaller side). */
  blend?: number;
  origin?: "bottom-center" | "center" | "top-left";
  scale?: number;
  apply?: boolean;
  /** Suggestions: a smaller character drawn on a bigger one rides on its nearest body bone. */
  riders?: boolean;
  /** Suggestions: the joints of an approved .spine or .json, matched to the parts by slot name. */
  rigFrom?: string;
}

export interface Part { name: string; path: string; left: number; top: number; width: number; height: number; data: Uint8ClampedArray; opacity: number; group?: string; shut?: boolean }

export const LID_OPEN_SCALE = 0.02;
export const isLidName = (name: string) => /(^|[^a-z])(eye)?lids?($|[^a-z])/i.test(name.replace(/([a-z])([A-Z])/g, "$1 $2"));

export interface RigCheck {
  /** Largest distance between a vertex's weighted setup position and where the art puts it (skeleton units). */
  setupError: number;
  /** Triangles that flip when each bone turns 30 degrees either way (per bone with any). */
  folds: { bone: string; triangles: number }[];
  maxInfluences: number;
  validateWarnings: string[];
  rigQaWarnings: string[];
  setupMatch: { iou: number; colorDiff: number; ok: boolean } | null;
}

export interface AutoRigResult {
  mode: "suggestions" | "dry-run" | "created";
  skeleton: string;
  /** Joints found from the art (pass them back as bones, edited as needed). */
  suggestions?: { bones: RigBoneSpec[]; ik: RigIkSpec[]; notes: string[] };
  bones?: { name: string; parent: string | null; x: number; y: number; rotation: number; length: number }[];
  /** fallback: the traced mesh could not be built (ear clipping of the outline only, or a region attachment). */
  slots?: { slot: string; bone: string; mesh: { vertices: number; triangles: number; hull: number } | null; weightedTo: string[]; fallback?: "ear-clipping" | "region" }[];
  /** straight: the limb is drawn straight, so the bend direction is a guess (flip bendPositive if it bends the wrong way). */
  ik?: { name: string; bones: string[]; target: string; bendPositive: boolean; straight?: boolean }[];
  project?: string;
  check?: RigCheck;
  notes: string[];
  png?: Buffer;
  /** Setup pose, then the two test poses, as Spine draws them. */
  posePng?: Buffer;
}

export function collectParts(input: Psd, scale: number): { parts: Part[]; skipped: string[]; notes: string[] } {
  const { psd, notes } = bakePsd(input);
  const parts: Part[] = [], skipped: string[] = [], used = new Set<string>();
  const visit = (list: Layer[], folder: string) => {
    for (const l of list) {
      const raw = l.name ?? "layer", tags = tagsOf(raw), name = clean(raw);
      if (tags.has("ignore") || (l.hidden && (l.children || !isLidName(name)))) { skipped.push(raw); continue; }
      if (l.children && !tags.has("merge")) { visit(l.children, `${folder}${name}/`); continue; }
      const r0 = rasterize(l), r = r0 && trim(r0);
      if (!r) { skipped.push(raw); continue; }
      let n = name, i = 2;
      while (used.has(n)) n = `${name}-${i++}`;
      used.add(n);
      const img = scaled(r, scale);
      parts.push({ name: n, path: `${folder}${n}`, left: r.left * scale, top: r.top * scale, width: img.width, height: img.height, data: img.data, opacity: l.opacity ?? 1, ...(l.hidden ? { shut: true } : {}) });
    }
  };
  visit(psd.children ?? [], "");
  return { parts, skipped, notes };
}

/** Parts from a folder and its layout, like collectParts gives them from a PSD; layout problems are refused. */
export function partsFromLayout(folder: string, layout: string | undefined, scale: number): { parts: Part[]; skipped: string[]; notes: string[]; joints?: [string, string][]; source?: SourceImage } {
  const l = loadParts({ parts: folder, layout });
  if (l.problems.length) throw new UserError(`Layout problems: ${l.problems.slice(0, 5).join("; ")}`);
  const parts = rigParts(l.parts, scale), kept = new Set(parts.map((p) => p.name));
  const hidden = l.parts.filter((p) => p.hidden && !kept.has(p.name)).map((p) => p.name);
  // A slot rigs its part shown at setup; the slot's other drawings are swaps, not parts of the body.
  const swaps = l.parts.filter((p) => !p.hidden && !kept.has(p.name)).map((p) => `${p.name} (another drawing of slot ${p.slot})`);
  const notes = [...l.notes];
  if (l.layout.bones.length || l.parts.some((p) => p.bone || p.pivot)) notes.push("Auto rig suggests its own joints: the layout's bones and pivots are not used (spine_import_layers with parts keeps them).");
  return { parts, skipped: [...l.skipped.map((s) => s.layer), ...hidden, ...swaps], notes, ...(l.layout.joints ? { joints: l.layout.joints } : {}), ...(scale === 1 && sourceImage(l) ? { source: sourceImage(l)! } : {}) };
}

const alphaAt = (p: Part, x: number, y: number) => p.data[(y * p.width + x) * 4 + 3]!;
const outsideMasks = new WeakMap<Part, Uint8Array>();
function outsideOf(p: Part): Uint8Array {
  const had = outsideMasks.get(p);
  if (had) return had;
  const w = p.width, h = p.height, out = new Uint8Array(w * h), stack: number[] = [];
  const seed = (x: number, y: number) => { const i = y * w + x; if (!out[i] && alphaAt(p, x, y) <= 64) { out[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
  while (stack.length) {
    const i = stack.pop()!, x = i % w, y = (i - x) / w;
    if (x > 0) seed(x - 1, y);
    if (x < w - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < h - 1) seed(x, y + 1);
  }
  outsideMasks.set(p, out);
  return out;
}
const silhouetteAt = (p: Part, x: number, y: number) => !outsideOf(p)[y * p.width + x];
const faceDetail = (name: string) => /(^|[^a-z])(eyes?|whites?|pupils?|iris|lids?|lash(es)?|brows?|mouth|tongue|jaw|teeth|tooth|nose|cheeks?|whiskers?)($|[^a-z])/i.test(name.replace(/([a-z])([A-Z])/g, "$1 $2"));

function grownContour(p: Part, r: number): Pt[] {
  const w = p.width, h = p.height, rows = new Uint8Array(w * h), grown = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r) && m <= 64; k++) m = Math.max(m, alphaAt(p, k, y));
    rows[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r) && m <= 64; k++) m = Math.max(m, rows[k * w + x]!);
    grown[y * w + x] = m;
  }
  return alphaContour(w, h, (x, y) => grown[y * w + x]!);
}

/** Side of a part from its name (left/right/back/front tokens), so a shin hangs from the thigh on its own side. */
function sideOf(name: string): string {
  const tokens = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
  const map: Record<string, string> = { l: "l", left: "l", r: "r", right: "r", back: "b", front: "f", bk: "b", fr: "f" };
  return tokens.map((t) => map[t]).filter(Boolean).sort().join("");
}

/** Arm or leg from the name's words, so a hand resting on a thigh is never its parent. */
function limbOf(name: string): string {
  const tokens = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/);
  const arm = ["arm", "forearm", "hand", "elbow", "wrist", "finger", "fingers", "fist", "palm", "shoulder", "sleeve"];
  const leg = ["leg", "thigh", "shin", "calf", "foot", "feet", "knee", "ankle", "toe", "toes", "boot", "shoe"];
  if (tokens.some((t) => arm.includes(t))) return "arm";
  if (tokens.some((t) => leg.includes(t))) return "leg";
  return "";
}

interface Shape { mean: Pt; u: Pt; v: Pt; tmin: number; tmax: number; width: number; elongated: boolean; samples: Pt[] }

/** Principal axis of a part's opaque pixels: direction, extent along it and thickness across it. */
function shapeOf(p: Part, step: number): Shape {
  const samples: Pt[] = [];
  for (let y = 0; y < p.height; y += step) for (let x = 0; x < p.width; x += step) if (alphaAt(p, x, y) > 64) samples.push([p.left + x, p.top + y]);
  if (!samples.length) samples.push([p.left + p.width / 2, p.top + p.height / 2]);
  const n = samples.length, mx = samples.reduce((s, q) => s + q[0], 0) / n, my = samples.reduce((s, q) => s + q[1], 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of samples) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const u: Pt = [Math.cos(angle), Math.sin(angle)], v: Pt = [-u[1], u[0]];
  let tmin = Infinity, tmax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (const [x, y] of samples) {
    const t = (x - mx) * u[0] + (y - my) * u[1], s = (x - mx) * v[0] + (y - my) * v[1];
    tmin = Math.min(tmin, t); tmax = Math.max(tmax, t); vmin = Math.min(vmin, s); vmax = Math.max(vmax, s);
  }
  const width = vmax - vmin + step;
  // Thickness as the median slice across the axis, so a foot or a hand does not make a limb look stubby.
  const slices = new Map<number, [number, number]>();
  for (const [x, y] of samples) {
    const k = Math.round(((x - mx) * u[0] + (y - my) * u[1]) / (2 * step)), s = (x - mx) * v[0] + (y - my) * v[1], r = slices.get(k);
    slices.set(k, r ? [Math.min(r[0], s), Math.max(r[1], s)] : [s, s]);
  }
  const widths = [...slices.values()].map(([a, b]) => b - a + step).sort((a, b) => a - b);
  const thickness = widths[widths.length >> 1] ?? width;
  return { mean: [mx, my], u, v, tmin, tmax, width, elongated: tmax - tmin > 1.5 * thickness, samples };
}

/** Last opaque sample from the part's centre along a direction (where the art ends that way). */
function exitPoint(s: Shape, dir: Pt, step: number): Pt {
  let best = 0;
  for (const [x, y] of s.samples) {
    const dx = x - s.mean[0], dy = y - s.mean[1], along = dx * dir[0] + dy * dir[1], across = Math.abs(dx * dir[1] - dy * dir[0]);
    if (across <= step * 1.5 && along > best) best = along;
  }
  return [s.mean[0] + dir[0] * best, s.mean[1] + dir[1] * best];
}

/**
 * A starting skeleton from the art: parts that overlap or nearly touch are linked, the most connected part is the
 * body, limbs become chains (a part hanging off the far end of a sibling is its child), joints sit at the end of a
 * part's long axis (inset by half its thickness) or, for round parts, where the art ends towards the parent.
 */
export function suggestRig(parts: Part[], scale = 1, o: { riders?: boolean } = {}): { bones: RigBoneSpec[]; ik: RigIkSpec[]; notes: string[] } {
  const S = 2; // sampling step in pixels
  const shapes = parts.map((p) => shapeOf(p, S));
  const touch = 10 * scale;
  const key = ([x, y]: Pt) => `${Math.round(x / S)},${Math.round(y / S)}`;
  const link = new Map<string, { at: Pt; strength: number }>();
  const lk = (i: number, j: number) => (i < j ? `${i}:${j}` : `${j}:${i}`);
  // A ground shadow stays on the root even where the feet touch it.
  const grounded = parts.map((p) => /(^|[^a-z])shadows?($|[^a-z])/i.test(p.name.replace(/([a-z])([A-Z])/g, "$1 $2")));
  const group = parts.map((p) => p.group ?? "");
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    const A = parts[i]!, B = parts[j]!;
    if (grounded[i] || grounded[j] || group[i] !== group[j]) continue;
    if (A.left > B.left + B.width + touch || B.left > A.left + A.width + touch || A.top > B.top + B.height + touch || B.top > A.top + A.height + touch) continue;
    const set = new Set(shapes[j]!.samples.map(key));
    const overlap = shapes[i]!.samples.filter((q) => set.has(key(q)));
    if (overlap.length) {
      link.set(lk(i, j), { at: [overlap.reduce((s, q) => s + q[0], 0) / overlap.length, overlap.reduce((s, q) => s + q[1], 0) / overlap.length], strength: overlap.length });
      continue;
    }
    // Nearly touching (a neck gap): the midpoint of the closest pair.
    let best = Infinity, at: Pt = [0, 0];
    for (const p of shapes[i]!.samples) for (const q of shapes[j]!.samples) {
      const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
      if (d < best) { best = d; at = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; }
    }
    if (Math.sqrt(best) <= touch) link.set(lk(i, j), { at, strength: 0.5 });
  }
  const area = parts.map((_, i) => shapes[i]!.samples.length);
  const cells = shapes.map((sh) => new Set(sh.samples.map(key)));
  const filled = shapes.map((_, i) => {
    const own = cells[i]!, xs = shapes[i]!.samples.map((q) => Math.round(q[0] / S)), ys = shapes[i]!.samples.map((q) => Math.round(q[1] / S));
    const lo = (v: number[]) => v.reduce((a, b) => (b < a ? b : a), Infinity), hi = (v: number[]) => v.reduce((a, b) => (b > a ? b : a), -Infinity);
    const x0 = lo(xs) - 1, x1 = hi(xs) + 1, y0 = lo(ys) - 1, y1 = hi(ys) + 1;
    const out = new Set<string>(), stack: [number, number][] = [[x0, y0]];
    out.add(`${x0},${y0}`);
    while (stack.length) {
      const [x, y] = stack.pop()!;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as [number, number][]) {
        const k = `${nx},${ny}`;
        if (nx < x0 || ny < y0 || nx > x1 || ny > y1 || out.has(k) || own.has(k)) continue;
        out.add(k); stack.push([nx, ny]);
      }
    }
    return { has: (k: string) => { const [x, y] = k.split(",").map(Number) as [number, number]; return own.has(k) || (x > x0 && y > y0 && x < x1 && y < y1 && !out.has(k)); } };
  });
  const groups = [...new Set(group)];
  const biggest = new Map(groups.map((g) => [g, Math.max(...parts.map((_, i) => (group[i] === g ? area[i]! : 0)))]));
  const container = parts.map((_, i) => {
    const share = area[i]! / biggest.get(group[i]!)!;
    if (grounded[i] || share >= (faceDetail(parts[i]!.name) ? 0.3 : 0.08)) return -1;
    let best = -1, bestCover = 0.7;
    parts.forEach((_, j) => {
      if (j === i || group[j] !== group[i] || area[j]! <= area[i]!) return;
      let inside = 0;
      for (const q of shapes[i]!.samples) if (filled[j]!.has(key(q))) inside++;
      const cover = inside / shapes[i]!.samples.length;
      if (cover > bestCover) { bestCover = cover; best = j; }
    });
    return best;
  });
  const detail = container.map((c) => c >= 0);
  const linksOf = (i: number) => parts.map((_, j) => j).filter((j) => j !== i && !detail[j] && link.has(lk(i, j)));
  const torso = (name: string) => /(^|[^a-z])(body|torso|chest|trunk|hips?|pelvis|spine)($|[^a-z])/i.test(name.replace(/([a-z])([A-Z])/g, "$1 $2"));
  const bodies = groups.map((g) => {
    const members = parts.map((_, i) => i).filter((i) => group[i] === g && !detail[i] && !grounded[i]);
    const named = members.filter((i) => torso(parts[i]!.name));
    const pool = named.length ? named : members;
    let b = pool[0] ?? 0;
    for (const i of pool) { const d = linksOf(i).length, e = linksOf(b).length; if (named.length ? area[i]! > area[b]! : d > e || (d === e && area[i]! > area[b]!)) b = i; }
    return b;
  });
  const bodyOf = (i: number) => bodies[groups.indexOf(group[i]!)]!;
  const isBody = (i: number) => bodies.includes(i);
  const body = bodies[0]!;
  const side = parts.map((p) => sideOf(p.name)), limb = parts.map((p) => limbOf(p.name));
  // Same side (or no side) and not arm-with-leg by name.
  const compatible = (i: number, j: number) => (!side[i] || !side[j] || side[i] === side[j]) && (!limb[i] || !limb[j] || limb[i] === limb[j]);
  // How close a link sits to an end of the part's long axis (1 = at an end, 0 = mid-side); round parts count as ends.
  const endness = (j: number, at: Pt) => {
    const sh = shapes[j]!;
    if (!sh.elongated) return 1;
    const t = (at[0] - sh.mean[0]) * sh.u[0] + (at[1] - sh.mean[1]) * sh.u[1], half = (sh.tmax - sh.tmin) / 2 || 1;
    return Math.min(1, Math.abs(t - (sh.tmin + sh.tmax) / 2) / half);
  };
  // Limbs grow outward: parts are placed nearest the body first, each on a linked part already placed. A link at the
  // part's end beats one along its side (a hand lying against a thigh is not its parent), then the body, then overlap.
  const reach = parts.map((_, i) => Math.hypot(shapes[i]!.mean[0] - shapes[bodyOf(i)]!.mean[0], shapes[i]!.mean[1] - shapes[bodyOf(i)]!.mean[1]));
  const parent = new Map<number, number>();
  const placed = new Set(bodies);
  for (const j of parts.map((_, i) => i).filter((i) => !isBody(i) && !detail[i]).sort((a, b) => reach[a]! - reach[b]!)) {
    const options = linksOf(j).filter((k) => placed.has(k) && (isBody(k) || compatible(k, j)));
    if (!options.length) continue;
    const key = (k: number) => { const l = link.get(lk(k, j))!; return [Number(endness(j, l.at) >= 0.5), Number(isBody(k)), Number(side[k] === side[j]), l.strength]; };
    options.sort((x, y) => { const kx = key(x), ky = key(y); for (let n = 0; n < kx.length; n++) if (kx[n] !== ky[n]) return ky[n]! - kx[n]!; return 0; });
    parent.set(j, options[0]!);
    placed.add(j);
  }
  // Parts linked only through parts placed after them: a second pass.
  for (let pass = 0; pass < 3; pass++) for (const j of parts.map((_, i) => i)) {
    if (isBody(j) || detail[j] || placed.has(j)) continue;
    const k = linksOf(j).filter((x) => placed.has(x)).sort((x, y) => link.get(lk(y, j))!.strength - link.get(lk(x, j))!.strength)[0];
    if (k !== undefined) { parent.set(j, k); placed.add(j); }
  }
  // Chains: when a part's end overlaps the far end of a sibling (away from where that sibling meets the parent), it hangs from it.
  const isAncestor = (a: number, b: number) => { for (let k: number | undefined = b; k !== undefined; k = parent.get(k)) if (k === a) return true; return false; };
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    const order = [...parent.keys()].sort((a, b) => link.get(lk(a, parent.get(a)!))!.strength - link.get(lk(b, parent.get(b)!))!.strength);
    for (const j of order) {
      const p = parent.get(j)!;
      for (const s of linksOf(j)) {
        if (s === p || parent.get(s) !== p || isAncestor(j, s) || !compatible(s, j) || reach[s]! > reach[j]!) continue;
        const sh = shapes[s]!, base = link.get(lk(s, p))!.at, at = link.get(lk(j, s))!.at;
        if (!sh.elongated || endness(j, at) < 0.5) continue;
        const ta = (at[0] - base[0]) * sh.u[0] + (at[1] - base[1]) * sh.u[1];
        if (Math.abs(ta) > 0.4 * (sh.tmax - sh.tmin) && link.get(lk(j, s))!.strength >= 0.5) { parent.set(j, s); changed = true; break; }
      }
    }
    if (!changed) break;
  }
  const r1 = (v: number) => +v.toFixed(1);
  const joints = new Map<number, Pt>();
  const axisEnd = (sh: Shape, towards: Pt, near: boolean): Pt => {
    const t = (towards[0] - sh.mean[0]) * sh.u[0] + (towards[1] - sh.mean[1]) * sh.u[1];
    const atMin = (t < (sh.tmin + sh.tmax) / 2) === near, len = sh.tmax - sh.tmin, end = atMin ? sh.tmin : sh.tmax;
    // Inset by half the thickness at that end (a foot or hand does not widen the knee or wrist).
    let vmin = Infinity, vmax = -Infinity;
    for (const [x, y] of sh.samples) {
      const tt = (x - sh.mean[0]) * sh.u[0] + (y - sh.mean[1]) * sh.u[1];
      if (Math.abs(tt - end) > 0.2 * len) continue;
      const vv = (x - sh.mean[0]) * sh.v[0] + (y - sh.mean[1]) * sh.v[1];
      vmin = Math.min(vmin, vv); vmax = Math.max(vmax, vv);
    }
    const inset = Math.min((vmax - vmin + S) / 2, len / 4);
    const tt = atMin ? sh.tmin + inset : sh.tmax - inset;
    return [sh.mean[0] + sh.u[0] * tt, sh.mean[1] + sh.u[1] * tt];
  };
  const onAxis = (sh: Shape, q: Pt): Pt => { const t = (q[0] - sh.mean[0]) * sh.u[0] + (q[1] - sh.mean[1]) * sh.u[1]; return [sh.mean[0] + sh.u[0] * t, sh.mean[1] + sh.u[1] * t]; };
  const round = (i: number) => !shapes[i]!.elongated || (!limb[i] && /(^|[^a-z])(head|face|skull)($|[^a-z])/i.test(parts[i]!.name.replace(/([a-z])([A-Z])/g, "$1 $2")));
  const unit = (a: Pt, b: Pt): Pt => { const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / d, (b[1] - a[1]) / d]; };
  for (const [j, p] of parent) {
    const sh = shapes[j]!, at = link.get(lk(j, p))!.at;
    const child = [...parent].find(([, q]) => q === j)?.[0];
    if (round(j)) {
      const dir = unit(sh.mean, shapes[p]!.mean), e = exitPoint(sh, dir, S), inset = 0.1 * Math.min(parts[j]!.width, parts[j]!.height);
      joints.set(j, [e[0] - dir[0] * inset, e[1] - dir[1] * inset]);
    }
    else if (sh.elongated && !isBody(p) && shapes[p]!.elongated) joints.set(j, onAxis(sh, at)); // knee, elbow: where the two segments overlap
    else if (sh.elongated) {
      const end = child !== undefined ? axisEnd(sh, link.get(lk(j, child))!.at, false) : axisEnd(sh, at, true);
      const near = 0.15 * (sh.tmax - sh.tmin), offs = [-near, 0, near];
      const onParent = offs.some((dx) => offs.some((dy) => filled[p]!.has(key([end[0] + dx, end[1] + dy]))));
      joints.set(j, onParent || area[j]! < 0.4 * area[p]! ? end : at);
    }
    else {
      const dir = unit(sh.mean, shapes[p]!.mean), e = exitPoint(sh, dir, S), inset = 0.1 * Math.min(parts[j]!.width, parts[j]!.height);
      joints.set(j, [e[0] - dir[0] * inset, e[1] - dir[1] * inset]);
    }
  }
  for (let i = 0; i < parts.length; i++) {
    if (!detail[i]) continue;
    let c = container[i]!;
    while (detail[c]) c = container[c]!;
    parent.set(i, c);
  }
  const kids = (i: number) => [...parent].filter(([, p]) => p === i).map(([c]) => c);
  const bones: RigBoneSpec[] = parts.map((p, i) => {
    const sh = shapes[i]!;
    const joint = joints.get(i) ?? sh.mean;
    let tip: Pt | undefined;
    const children = kids(i);
    if (parent.has(i) && !detail[i] && !faceDetail(p.name)) {
      const only = children.length === 1 ? joints.get(children[0]!) : undefined;
      if (only) tip = only;
      else if (sh.elongated && !round(i)) tip = axisEnd(sh, joint, false);
      else { const dir = unit(shapes[parent.get(i)!]!.mean, sh.mean); tip = exitPoint(sh, dir, S); }
    }
    const par = parent.get(i);
    return { name: p.name, ...(par !== undefined ? { parent: parts[par]!.name } : {}), joint: [r1(joint[0]), r1(joint[1])], ...(tip ? { tip: [r1(tip[0]), r1(tip[1])] as [number, number] } : {}), layers: [p.name] };
  });
  const inner: RigBoneSpec[] = [], innerNotes: string[] = [];
  for (const b of bodies) {
    const under = (i: number) => { for (let k = parent.get(i); k !== undefined; k = parent.get(k)) { if (k === b) return true; if (!faceDetail(parts[k]!.name)) return false; } return false; };
    const face = parts.map((_, i) => i).filter((i) => under(i) && faceDetail(parts[i]!.name));
    if (face.length < 3) continue;
    const fc: Pt = [face.reduce((s, i) => s + shapes[i]!.mean[0], 0) / face.length, face.reduce((s, i) => s + shapes[i]!.mean[1], 0) / face.length];
    const up = unit(shapes[b]!.mean, fc);
    const lowest = Math.max(0, ...face.flatMap((i) => shapes[i]!.samples.map((q) => (q[0] - fc[0]) * -up[0] + (q[1] - fc[1]) * -up[1])));
    const bottomAt = exitPoint(shapes[b]!, [-up[0], -up[1]], S), reachDown = (bottomAt[0] - fc[0]) * -up[0] + (bottomAt[1] - fc[1]) * -up[1];
    const down = Math.min(lowest + 0.12 * Math.max(0, reachDown - lowest), reachDown * 0.8);
    const head: Pt = [fc[0] - up[0] * down, fc[1] - up[1] * down];
    const bottom = exitPoint(shapes[b]!, [-up[0], -up[1]], S), top = exitPoint(shapes[b]!, up, S);
    const span = Math.hypot(head[0] - bottom[0], head[1] - bottom[1]);
    const hip: Pt = [bottom[0] + up[0] * 0.03 * span, bottom[1] + up[1] * 0.03 * span];
    const rise = Math.hypot(head[0] - hip[0], head[1] - hip[1]);
    const spine: Pt = [hip[0] + up[0] * 0.4 * rise, hip[1] + up[1] * 0.4 * rise];
    const name = parts[b]!.name, along = (q: Pt) => (q[0] - hip[0]) * up[0] + (q[1] - hip[1]) * up[1];
    Object.assign(bones[b]!, { joint: [r1(hip[0]), r1(hip[1])], tip: [r1(spine[0]), r1(spine[1])] });
    inner.push({ name: `${name}-spine`, parent: name, joint: [r1(spine[0]), r1(spine[1])], tip: [r1(head[0]), r1(head[1])], layers: [] });
    inner.push({ name: `${name}-head`, parent: `${name}-spine`, joint: [r1(head[0]), r1(head[1])], tip: [r1(top[0]), r1(top[1])], layers: [] });
    for (const i of face) if (parent.get(i) === b) bones[i]!.parent = `${name}-head`;
    for (const k of kids(b).filter((i) => !detail[i])) {
      const at = bones[k]!.joint;
      if (along(at) >= along(head) + 0.25 * rise || faceDetail(parts[k]!.name)) bones[k]!.parent = `${name}-head`;
      else if (along(at) >= along(spine)) bones[k]!.parent = `${name}-spine`;
    }
    innerNotes.push(`"${name}" carries the face (${face.length} details inside it): bones ${name}-spine and ${name}-head inside it, hip at its far end; the face details hang from ${name}-head, parts attached above the spine joint from the spine. Weight the body mesh along that chain (weights: "joint").`);
  }
  bones.push(...inner);
  const named = (re: RegExp) => (n: string) => re.test(n.replace(/([a-z])([A-Z])/g, "$1 $2"));
  const isBrow = named(/(^|[^a-z])(eye)?brows?($|[^a-z])/i), isLid = named(/(^|[^a-z])(eye)?lids?($|[^a-z])/i);
  const isLash = named(/(^|[^a-z])(eye)?lash(es)?($|[^a-z])/i), isEye = named(/(^|[^a-z])(eyes?|whites?|pupils?|iris)($|[^a-z])/i);
  const centreOf = (ids: number[]): Pt => [ids.reduce((s, j) => s + shapes[j]!.mean[0], 0) / ids.length, ids.reduce((s, j) => s + shapes[j]!.mean[1], 0) / ids.length];
  const faceBuilt: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!, sh = shapes[i]!, mates = parts.map((_, j) => j).filter((j) => j !== i && group[j] === group[i]);
    if (isBrow(p.name) && sh.elongated) {
      const brows = mates.filter((j) => isBrow(parts[j]!.name)), eyes = mates.filter((j) => isEye(parts[j]!.name));
      const pool = brows.length ? [...brows, i] : eyes.length ? eyes : mates.filter((j) => faceDetail(parts[j]!.name) && !isBrow(parts[j]!.name));
      if (!pool.length) continue;
      const centre = centreOf(pool), inner = axisEnd(sh, centre, true), outer = axisEnd(sh, centre, false);
      const mid: Pt = [(inner[0] + outer[0]) / 2, (inner[1] + outer[1]) / 2];
      Object.assign(bones[i]!, { joint: [r1(inner[0]), r1(inner[1])], tip: [r1(mid[0]), r1(mid[1])] });
      bones.push({ name: `${p.name}-outer`, parent: p.name, joint: [r1(mid[0]), r1(mid[1])], tip: [r1(outer[0]), r1(outer[1])], layers: [] });
      faceBuilt.push(`${p.name} (inner end + ${p.name}-outer)`);
    } else if (isLid(p.name)) {
      const up = unit(shapes[bodyOf(i)]!.mean, sh.mean);
      const along = sh.elongated ? (sh.u[0] * up[0] + sh.u[1] * up[1] >= 0 ? sh.u : [-sh.u[0], -sh.u[1]] as Pt) : up;
      const top = exitPoint(sh, along, S), bottom = exitPoint(sh, [-along[0], -along[1]], S);
      Object.assign(bones[i]!, { joint: [r1(top[0]), r1(top[1])], tip: [r1(bottom[0]), r1(bottom[1])] });
      faceBuilt.push(`${p.name} (pivot at the top end of its axis)`);
    }
  }
  for (let i = 0; i < parts.length; i++) {
    if (!isLash(parts[i]!.name)) continue;
    const lids = parts.map((_, j) => j).filter((j) => group[j] === group[i] && isLid(parts[j]!.name));
    const lidFor = lids.find((j) => sideOf(parts[j]!.name) === sideOf(parts[i]!.name)) ?? (lids.length === 1 ? lids[0] : undefined);
    if (lidFor === undefined) continue;
    if (parts[lidFor]!.shut) {
      bones[i]!.parent = bones[lidFor]!.parent;
      faceBuilt.push(`${parts[i]!.name} on ${bones[lidFor]!.parent ?? "the root"} (its lid ${parts[lidFor]!.name} is drawn shut and hidden, so its bone is set up collapsed)`);
    } else { bones[i]!.parent = parts[lidFor]!.name; faceBuilt.push(`${parts[i]!.name} on ${parts[lidFor]!.name}`); }
  }
  const shutLids = parts.filter((p) => p.shut).map((p) => p.name);
  const byName = new Map(bones.map((b) => [b.name, b]));
  const partGroup = new Map(parts.map((p, i) => [p.name, group[i]!]));
  const groupOfBone = (b: RigBoneSpec | undefined): string | undefined => {
    for (let cur = b, guard = 0; cur && guard < 64; cur = cur.parent ? byName.get(cur.parent) : undefined, guard++) {
      const owned = (cur.layers ?? []).find((l) => partGroup.has(l));
      if (owned) return partGroup.get(owned);
      const inner = /^(.*)-(spine|head)$/.exec(cur.name);
      if (inner && partGroup.has(inner[1]!)) return partGroup.get(inner[1]!);
    }
    return undefined;
  };
  const segDistance = (q: Pt, a: Pt, b: Pt) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
    const k = len ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / len)) : 0;
    return Math.hypot(q[0] - (a[0] + k * dx), q[1] - (a[1] + k * dy));
  };
  const riderNotes: string[] = [];
  if (groups.length > 1) for (const b of bodies) {
    const others = bodies.filter((c) => c !== b && area[c]! > area[b]!);
    const over = others.map((c) => { let n = 0; for (const q of shapes[b]!.samples) if (cells[c]!.has(key(q))) n++; return { c, n }; }).sort((x, y) => y.n - x.n)[0];
    if (!over || over.n <= 0.05 * area[b]!) continue;
    if (!o.riders) { riderNotes.push(`"${group[b]}" overlaps "${parts[over.c]!.name}": if it rides on it, pass riders: true (or parent "${parts[b]!.name}" to that character's bone yourself; auto rig keeps characters apart).`); continue; }
    const rider = group[b], carrier = group[over.c], seat = bones[b]!.joint;
    const targets = bones.filter((x) => groupOfBone(x) === carrier && !faceDetail(x.name) && !x.name.endsWith("-outer"));
    const target = targets.sort((x, y) => segDistance(seat, x.joint, x.tip ?? x.joint) - segDistance(seat, y.joint, y.tip ?? y.joint))[0];
    if (!target) continue;
    const roots = bones.filter((x) => !x.parent && groupOfBone(x) === rider);
    for (const r of roots) r.parent = target.name;
    riderNotes.push(`"${rider}" rides on "${carrier}": ${roots.map((r) => r.name).join(", ")} parented to ${target.name}, the nearest body bone to where it sits (riders).`);
  }
  // Two-bone limbs hanging from the body and ending in a leaf (arms, legs) are IK candidates.
  const ik: RigIkSpec[] = [];
  const limbPair = (a: number, b: number) => (!limb[a] && !limb[b]) || (!!limb[a] && limb[a] === limb[b]);
  for (const up of bodies.flatMap((b) => kids(b)).filter((i) => !detail[i])) {
    const lows = kids(up).filter((i) => !detail[i]);
    if (lows.length === 1 && !kids(lows[0]!).filter((i) => !detail[i]).length && shapes[up]!.elongated && shapes[lows[0]!]!.elongated && limbPair(up, lows[0]!)) ik.push({ bones: [parts[up]!.name, parts[lows[0]!]!.name] });
  }
  const loose = parts.filter((_, i) => !isBody(i) && !parent.has(i)).map((p) => p.name);
  return {
    bones, ik,
    notes: [
      groups.length > 1 || groups[0] ? `Bodies, one per character group (linked only by riders: true): ${bodies.map((b) => `"${parts[b]!.name}" (${group[b]})`).join(", ")}. Limbs are chains of parts that overlap; joints sit at the end of each part's long axis, or where round parts meet their parent.` : `Body: "${parts[body]!.name}" (most connections). Limbs are chains of parts that overlap; joints sit at the end of each part's long axis, or where round parts meet their parent.`,
      ...(detail.some(Boolean) ? [`Details on the part they lie on (small and at least 70 % inside it, never chained to each other): ${parts.filter((_, i) => detail[i]).map((p) => p.name).join(", ")}.`] : []),
      ...riderNotes,
      ...(shutLids.length ? [`Lids drawn shut and hidden in the art are rigged with their bone collapsed along the eye (scaleX ${LID_OPEN_SCALE}), so the setup pose matches the art: blink them with a scale of ${1 / LID_OPEN_SCALE} along the bone (${shutLids.join(", ")}).`] : []),
      ...innerNotes,
      ...(faceBuilt.length ? [`Face parts built to be touched later with bone keys: ${faceBuilt.join(", ")}. A brow raises, tilts (inner bone) and arches (outer bone); a lid bone points down its eye from the top end, so scaling it along its length closes the lid from the top; set lash bones to inherit noScale so the lid's scale does not squash them.`] : []),
      ...(loose.length ? [`On the root (not connected, or a shadow): ${loose.join(", ")}.`] : []),
      "These are suggestions: check the joints (shoulders, hips, neck) and the IK chains, edit them, and pass them back as bones / ik.",
    ],
  };
}

interface BoneT { name: string; parent: string | null; wx: number; wy: number; wr: number; length: number }

/** Bones hanging from a lid drawn shut and hidden move to the lid's parent: the lid's bone is set up collapsed and would draw them off their place. Pure. */
export function liftFromShutLids(bones: RigBoneSpec[], parts: Part[]): { bones: RigBoneSpec[]; moved: string[] } {
  const shut = new Set(parts.filter((p) => p.shut).map((p) => p.name));
  const lids = new Map(bones.filter((b) => (b.layers ?? [b.name]).some((l) => shut.has(l))).map((b) => [b.name, b]));
  const moved: string[] = [];
  const out = bones.map((b) => {
    const lid = b.parent ? lids.get(b.parent) : undefined;
    if (!lid) return b;
    moved.push(b.name);
    const { parent: _, ...rest } = b;
    return lid.parent ? { ...rest, parent: lid.parent } : rest;
  });
  return { bones: out, moved };
}

/** The bones of an approved skeleton as suggestions in the parts' pixels: slots matched to parts by name, the offset between the two canvases from those matches. Pure. */
export function bonesFromSkeleton(doc: SkeletonJson, parts: Part[], scale = 1): { bones: RigBoneSpec[]; notes: string[] } {
  const sk = new spine.Skeleton(loadSkeletonData(doc));
  sk.setupPose();
  sk.updateWorldTransform(spine.Physics.none);
  const owners = new Map<string, string[]>(), dxs: number[] = [], dys: number[] = [], matched = new Set<string>();
  const pairs: { part: Part; cx: number; cy: number }[] = [];
  const slotBone = new Map<string, spine.Bone>(), weightsOf = new Map<string, Set<string>>();
  for (const slot of sk.slots) {
    const att = slot.pose.getAttachment();
    let v: number[] = [];
    if (att instanceof spine.RegionAttachment) { v = new Array(8).fill(0); att.computeWorldVertices(slot, att.getOffsets(slot.pose), v, 0, 2); }
    else if (att instanceof spine.MeshAttachment) { v = new Array(att.worldVerticesLength).fill(0); att.computeWorldVertices(sk, slot, 0, att.worldVerticesLength, v, 0, 2); }
    if (!v.length) continue;
    const part = parts.find((p) => p.name === slot.data.name) ?? parts.find((p) => p.name === att!.name);
    if (!part || matched.has(part.name)) continue;
    const xs = v.filter((_, i) => i % 2 === 0), ys = v.filter((_, i) => i % 2 === 1);
    const cx = ((Math.min(...xs) + Math.max(...xs)) / 2) * scale, cy = ((Math.min(...ys) + Math.max(...ys)) / 2) * scale;
    matched.add(part.name);
    pairs.push({ part, cx, cy });
    slotBone.set(part.name, slot.bone);
    const used = new Set<string>([slot.bone.data.name]);
    if (att instanceof spine.MeshAttachment && att.bones) for (let i = 0; i < att.bones.length; i += att.bones[i]! + 1) for (let k = 1; k <= att.bones[i]!; k++) used.add(sk.bones[att.bones[i + k]!]!.data.name);
    weightsOf.set(part.name, used);
    if (!part.shut) { dxs.push(part.left + part.width / 2 - cx); dys.push(part.top + part.height / 2 + cy); }
  }
  if (!dxs.length) throw new UserError("rigFrom: no slot of that skeleton has the name of a part (slots are matched to parts by name).");
  const carriers = new Set([...slotBone.values()].map((b) => b.data.name));
  const carriesBelow = (b: spine.Bone, skip: spine.Bone): boolean => b !== skip && (carriers.has(b.data.name) || b.children.some((c) => carriesBelow(c, skip)));
  const climbed: string[] = [];
  for (const [part, start] of slotBone) {
    let owner = start;
    for (let up = owner.parent; up?.parent && weightsOf.get(part)!.has(up.data.name) && !up.children.some((c) => carriesBelow(c, owner)) && !carriers.has(up.data.name); up = up.parent) owner = up;
    if (owner !== start) climbed.push(`${part} (${start.data.name} -> ${owner.data.name})`);
    owners.set(owner.data.name, [...(owners.get(owner.data.name) ?? []), part]);
  }
  const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]!; };
  const ox = median(dxs), oy = median(dys);
  const off = pairs.filter((q) => !q.part.shut).map((q) => ({ name: q.part.name, d: Math.hypot(q.part.left + q.part.width / 2 - q.cx - ox, q.part.top + q.part.height / 2 + q.cy - oy) })).filter((q) => q.d > 4);
  const r1 = (n: number) => +n.toFixed(1);
  const bones: RigBoneSpec[] = [];
  for (const b of sk.bones) {
    if (!b.parent) continue;
    const ap = b.appliedPose, len = b.data.length * scale, n = Math.hypot(ap.a, ap.c) || 1;
    const wx = ap.worldX * scale, wy = ap.worldY * scale;
    const joint: Pt = [r1(wx + ox), r1(oy - wy)];
    const tip: Pt | undefined = len > 0 ? [r1(wx + (ap.a / n) * len + ox), r1(oy - (wy + (ap.c / n) * len))] : undefined;
    const parent = b.parent.parent ? b.parent.data.name : undefined;
    bones.push({ name: b.data.name, ...(parent ? { parent } : {}), joint, ...(tip ? { tip } : {}), layers: owners.get(b.data.name) ?? [] });
  }
  const left = parts.filter((p) => !matched.has(p.name)).map((p) => p.name);
  return {
    bones,
    notes: [
      `Joints from the approved skeleton: ${bones.length} bones; ${matched.size} of ${parts.length} parts matched to a slot by name; its canvas sits at (${r1(ox)}, ${r1(oy)}) px from the parts' origin.`,
      ...(climbed.length ? [`Owned by the top bone of the chain their mesh is weighted along, so it bends along it: ${climbed.join(", ")}.`] : []),
      ...(off.length ? [`Placed differently from the approved skeleton by more than 4 px: ${off.map((q) => `${q.name} (${r1(q.d)})`).join(", ")}.`] : []),
      ...(left.length ? [`Not in that skeleton (they stay on the root unless you add bones): ${left.join(", ")}.`] : []),
      "Bone scales, constraints and weights are not carried over: only joints, tips and parents.",
    ],
  };
}

const rot = (x: number, y: number, deg: number): Pt => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return [x * c - y * s, x * s + y * c]; };

/** The skeleton: bones from the joints, a mesh (or region) per part with weights, IK chains. Pure. */
export function buildRig(parts: Part[], o: { bones: RigBoneSpec[]; ik?: RigIkSpec[]; mesh?: "auto" | "none" | "sparse"; weights?: "smooth" | "rigid" | "joint"; density?: number; blend?: number; origin?: AutoRigOptions["origin"]; scale: number }) {
  const s = o.scale;
  const minX = Math.min(...parts.map((p) => p.left)), maxX = Math.max(...parts.map((p) => p.left + p.width));
  const minY = Math.min(...parts.map((p) => p.top)), maxY = Math.max(...parts.map((p) => p.top + p.height));
  const ox = o.origin === "top-left" ? 0 : (minX + maxX) / 2, oy = o.origin === "top-left" ? 0 : o.origin === "center" ? (minY + maxY) / 2 : maxY;
  // PSD pixels (already scaled for parts) -> skeleton space (y up).
  const sk = (x: number, y: number): Pt => [x - ox, oy - y];
  const names = new Set(o.bones.map((b) => b.name));
  if (names.has("root")) throw new UserError('"root" is created automatically; give your top bone another name.');
  for (const b of o.bones) if (b.parent && !names.has(b.parent)) throw new UserError(`Bone "${b.name}": parent "${b.parent}" is not in bones.`);
  // Parents first.
  const ordered: RigBoneSpec[] = [];
  const add = (b: RigBoneSpec, depth = 0) => {
    if (ordered.includes(b)) return;
    if (depth > o.bones.length) throw new UserError(`Bone parents loop at "${b.name}".`);
    if (b.parent) add(o.bones.find((x) => x.name === b.parent)!, depth + 1);
    ordered.push(b);
  };
  o.bones.forEach((b) => add(b));
  const bonesT: BoneT[] = [{ name: "root", parent: null, wx: 0, wy: 0, wr: 0, length: 0 }];
  for (const b of ordered) {
    const [jx, jy] = sk(b.joint[0] * s, b.joint[1] * s);
    let wr = 0, length = 0;
    if (b.tip) { const [tx, ty] = sk(b.tip[0] * s, b.tip[1] * s); wr = (Math.atan2(ty - jy, tx - jx) * 180) / Math.PI; length = Math.hypot(tx - jx, ty - jy); }
    const p = bonesT.find((x) => x.name === (b.parent ?? "root"))!;
    const local = rot(jx - p.wx, jy - p.wy, -p.wr).map((v) => roundValue("translate", v)) as Pt;
    let lr = roundValue("angle", wr - p.wr);
    const chain = o.ik?.find((k) => k.bones[1] === b.name && k.bones[0] === b.parent && k.bendPositive === undefined);
    const upper = chain && b.tip ? o.bones.find((x) => x.name === b.parent) : undefined;
    if (upper && b.tip) {
      const [ux, uy] = sk(upper.joint[0] * s, upper.joint[1] * s), [tx, ty] = sk(b.tip[0] * s, b.tip[1] * s);
      const cross = (jx - ux) * (ty - uy) - (jy - uy) * (tx - ux);
      if (Math.abs(cross) < 0.03 * Math.hypot(jx - ux, jy - uy) * Math.hypot(tx - ux, ty - uy)) { local[1] = 0; lr = 0; }
    }
    const [lx, ly] = local, [ox2, oy2] = rot(lx, ly, p.wr);
    bonesT.push({ name: b.name, parent: b.parent ?? "root", wx: p.wx + ox2, wy: p.wy + oy2, wr: p.wr + lr, length: length ? Math.max(0.5, roundValue("translate", length)) : 0 });
  }
  const T = (n: string) => bonesT.find((b) => b.name === n)!;
  const toLocal = (bone: string, x: number, y: number): Pt => { const b = T(bone); return rot(x - b.wx, y - b.wy, -b.wr); };
  const bonesJson = bonesT.map((b) => {
    if (!b.parent) return { name: "root" };
    const p = T(b.parent);
    const [lx, ly] = rot(b.wx - p.wx, b.wy - p.wy, -p.wr);
    return { name: b.name, parent: b.parent, ...(Math.abs(lx) > 1e-4 ? { x: +lx.toFixed(3) } : {}), ...(Math.abs(ly) > 1e-4 ? { y: +ly.toFixed(3) } : {}), ...(Math.abs(b.wr - p.wr) > 1e-4 ? { rotation: +(b.wr - p.wr).toFixed(3) } : {}), ...(b.length ? { length: +b.length.toFixed(3) } : {}) };
  });
  // Which bone carries each part.
  const owner = new Map<string, string>();
  for (const b of o.bones) for (const l of b.layers ?? [b.name]) {
    if (!parts.some((p) => p.name === l)) throw new UserError(`Bone "${b.name}": layer "${l}" not found. Layers: ${parts.map((p) => p.name).slice(0, 30).join(", ")}`);
    owner.set(l, b.name);
  }
  for (const p of parts) if (p.shut) {
    const name = owner.get(p.name) ?? "root";
    const others = o.bones.find((x) => x.name === name)?.layers?.filter((l) => l !== p.name && !parts.some((q) => q.name === l && q.shut)) ?? [];
    if (name === "root" || others.length) throw new UserError(`Shut lid "${p.name}" needs a bone of its own, because that bone is set up collapsed; it is on "${name}"${others.length ? ` with ${others.slice(0, 3).join(", ")}` : ""}.`);
    Object.assign(bonesJson.find((x) => x.name === name)!, { scaleX: LID_OPEN_SCALE });
  }
  const children = (bone: string) => bonesT.filter((b) => b.parent === bone);
  const slots: { name: string; bone: string; attachment: string; color?: string }[] = [];
  const skin: Record<string, Record<string, unknown>> = {};
  const report: NonNullable<AutoRigResult["slots"]> = [];
  const expected: { slot: string; points: Pt[] }[] = []; // skeleton-space vertex positions, for the check
  const boneIndex = (n: string) => bonesT.findIndex((b) => b.name === n);
  const carries = new Set(owner.values());
  const facesOnly = (bone: string) => [...owner].every(([part, b]) => b !== bone || faceDetail(part));
  const shutBones = new Set(parts.filter((q) => q.shut).map((q) => owner.get(q.name)).filter((b): b is string => !!b));
  const groupOfPart = new Map(parts.map((q) => [q.name, q.group]));
  const otherCharacter = (c: string, p: Part): boolean => {
    if (!p.group) return false;
    const found: string[] = [];
    const walk = (b: string) => { const own = [...owner].filter(([, bn]) => bn === b).map(([part]) => part); if (own.length) found.push(...own); else for (const k of bonesT.filter((x) => x.parent === b)) walk(k.name); };
    walk(c);
    return found.length > 0 && found.every((part) => groupOfPart.get(part) && groupOfPart.get(part) !== p.group);
  };
  const toPx = (p: Part, q: Pt): Pt => [q[0] + ox - p.left, oy - q[1] - p.top];
  const inside = (p: Part, q: Pt) => {
    const [x, y] = toPx(p, q), r = Math.max(2, Math.round(0.06 * Math.min(p.width, p.height)));
    if (x < 0 || y < 0 || x >= p.width || y >= p.height) return false;
    for (let dy = -r; dy <= r; dy += Math.max(1, r >> 2)) for (let dx = -r; dx <= r; dx += Math.max(1, r >> 2)) {
      const px = Math.floor(x + dx), py = Math.floor(y + dy);
      if (px >= 0 && py >= 0 && px < p.width && py < p.height && silhouetteAt(p, px, py)) return true;
    }
    return false;
  };
  const across = (p: Part, q: Pt, dir: Pt) => {
    const [x0, y0] = toPx(p, q), nx = dir[1], ny = dir[0];
    let width = 0;
    for (const sgn of [1, -1]) for (let k = 1; k < 4 * Math.max(p.width, p.height); k++) {
      const x = Math.floor(x0 + sgn * nx * k), y = Math.floor(y0 + sgn * ny * k);
      if (x < 0 || y < 0 || x >= p.width || y >= p.height || !silhouetteAt(p, x, y)) { width += k; break; }
    }
    return width;
  };
  const dirOf = (b: BoneT, from: Pt): Pt => {
    if (b.length > 1e-3) return rot(1, 0, b.wr);
    const dx = b.wx - from[0], dy = b.wy - from[1], d = Math.hypot(dx, dy) || 1;
    return [dx / d, dy / d];
  };
  const limbName = (n: string) => limbOf(n);
  const transitions = (p: Part, bone: string) => {
    const out: { from: string; to: string; at: Pt; dir: Pt; half: number; thickness: number }[] = [];
    if (bone === "root") return out;
    const b = T(bone), centre = sk(p.left + p.width / 2, p.top + p.height / 2);
    const nearCentre = Math.hypot(b.wx - centre[0], b.wy - centre[1]) < 0.25 * Math.min(p.width, p.height);
    if (b.parent && b.parent !== "root" && !nearCentre && !faceDetail(p.name) && inside(p, [b.wx, b.wy])) {
      const pb = T(b.parent), dir = dirOf(b, [pb.wx, pb.wy]), th = across(p, [b.wx, b.wy], dir);
      out.push({ from: b.parent, to: bone, at: [b.wx, b.wy], dir, half: Math.min(0.5 * 0.45 * th, 0.3 * Math.max(b.length, Math.hypot(b.wx - pb.wx, b.wy - pb.wy))), thickness: th });
    }
    let cur = b;
    for (let guard = 0; guard < 8; guard++) {
      const reach = (c: BoneT) => Math.hypot(c.wx - cur.wx, c.wy - cur.wy);
      const options = children(cur.name).filter((c) => c.length > 1e-3 && (!carries.has(c.name) || (facesOnly(c.name) && !faceDetail(p.name) && c.length >= 0.5 * reach(c))) && !shutBones.has(c.name) && !otherCharacter(c.name, p) && inside(p, [c.wx, c.wy]));
      const ahead = cur.length > 1e-3 ? rot(1, 0, cur.wr) : null;
      const turn = (c: BoneT) => { const d = dirOf(c, [cur.wx, cur.wy]); return ahead ? Math.acos(Math.max(-1, Math.min(1, d[0] * ahead[0] + d[1] * ahead[1]))) : Math.PI; };
      const next = options.length === 1 ? options : options.filter((c) => turn(c) < Math.PI / 4).sort((x, y) => turn(x) - turn(y)).slice(0, 1);
      if (next.length !== 1) break;
      const c = next[0]!, dir = dirOf(c, [cur.wx, cur.wy]), th = across(p, [c.wx, c.wy], dir);
      out.push({ from: cur.name, to: c.name, at: [c.wx, c.wy], dir, half: Math.min(0.5 * 0.65 * th, 0.3 * Math.hypot(c.wx - cur.wx, c.wy - cur.wy)), thickness: th });
      cur = c;
    }
    for (const c of children(bone)) {
      const kid = [...owner].find(([, bn]) => bn === c.name)?.[0];
      if (!kid || !limbName(p.name) || limbName(kid) !== limbName(p.name) || !inside(p, [c.wx, c.wy])) continue;
      const dir = dirOf(c, [b.wx, b.wy]), th = across(p, [c.wx, c.wy], dir);
      out.push({ from: bone, to: c.name, at: [c.wx, c.wy], dir, half: 0.5 * 0.45 * th, thickness: th });
    }
    return out;
  };
  const ancestors = (bone: string) => { const out: string[] = []; for (let b = T(bone).parent; b; b = T(b).parent) out.push(b); return out; };
  const hostOf = (p: Part, bone: string) => {
    if (bone === "root") return null;
    const up = ancestors(bone), cx = p.left + p.width / 2, cy = p.top + p.height / 2;
    const hosts = parts.filter((h) => h !== p && h.width * h.height > p.width * p.height && cx >= h.left && cy >= h.top && cx < h.left + h.width && cy < h.top + h.height && up.includes(owner.get(h.name) ?? "root") && transitions(h, owner.get(h.name) ?? "root").length > 0);
    return hosts.sort((a, b2) => a.width * a.height - b2.width * b2.height)[0] ?? null;
  };
  const smooth = (e0: number, e1: number, x: number) => { const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1))); return k * k * (3 - 2 * k); };
  const jointWeights = (bone: string, steps: ReturnType<typeof transitions>, q: Pt) => {
    const first = steps[0]?.from === T(bone).parent ? steps[0]!.from : bone;
    const w = new Map<string, number>([[first, 1]]);
    for (const st of steps) {
      const have = w.get(st.from) ?? 0;
      if (!have) continue;
      const k = smooth(-st.half, st.half, (q[0] - st.at[0]) * st.dir[0] + (q[1] - st.at[1]) * st.dir[1]);
      w.set(st.from, have * (1 - k));
      w.set(st.to, (w.get(st.to) ?? 0) + have * k);
    }
    const list = [...w].map(([b2, v]) => ({ bone: b2, w: v })).filter((v) => v.w >= 0.01).sort((a, b2) => b2.w - a.w).slice(0, 3);
    const sum = list.reduce((acc, v) => acc + v.w, 0) || 1;
    return list.map((v) => ({ bone: v.bone, w: v.w / sum })).sort((a, b2) => boneIndex(a.bone) - boneIndex(b2.bone));
  };
  const buildMesh = (p: Part, steps: ReturnType<typeof transitions>, hostSteps: ReturnType<typeof transitions>) => {
    let mesh: { hull: Pt[]; points: Pt[]; tris: [number, number, number][] } | null = null;
    let fallback: "ear-clipping" | "region" | undefined;
    if (o.mesh !== "none") {
      const contour = alphaContour(p.width, p.height, (x, y) => alphaAt(p, x, y));
      if (contour.length >= 3) {
        const base = Math.max(1.5 * s, Math.hypot(p.width, p.height) / (o.mesh === "sparse" ? 45 : 70));
        let first: Pt[] | null = null;
        for (const [f, pushOut] of [[1, true], [2, true], [3.5, true], [2, false]] as [number, boolean][]) {
          const eps = base * f;
          let outline = simplify(pushOut ? contour : grownContour(p, Math.ceil(2 * eps) + 1), eps);
          if (outline.length < 3) break;
          if (signedArea(outline) < 0) outline = outline.reverse();
          // The trace runs through pixel centres and simplifying cuts corners: push the outline out so edges keep their antialiasing.
          if (pushOut) outline = offsetPolygon(outline, eps + 1, p.width, p.height);
          first ??= outline;
          const d = Math.max(6 * s, Math.min(40 * s, o.density ? o.density * s : Math.min(p.width, p.height) / 4));
          const inner: Pt[] = [];
          let edge = d * 1.5;
          if (o.mesh === "sparse") {
            for (const st of [...steps, ...hostSteps]) {
              const gap = Math.max(6 * s, st.thickness / 5), [cx, cy] = toPx(p, st.at), dx = st.dir[0], dy = -st.dir[1];
              for (const along of [-st.half, 0, st.half]) for (let k = -Math.ceil(st.thickness / gap); k <= Math.ceil(st.thickness / gap); k++) {
                const x = cx + dx * along - dy * k * gap, y = cy + dy * along + dx * k * gap;
                if (x >= 0 && y >= 0 && x < p.width && y < p.height && alphaAt(p, Math.floor(x), Math.floor(y)) > 64) inner.push([x, y]);
              }
            }
            const perimeter = outline.reduce((sum, q, i) => sum + Math.hypot(q[0] - outline[(i + 1) % outline.length]![0], q[1] - outline[(i + 1) % outline.length]![1]), 0);
            const gaps = [...steps, ...hostSteps].filter((st) => inside(p, st.at)).map((st) => Math.max(6 * s, st.thickness / 5));
            edge = Math.max(gaps.length ? Math.min(...gaps) * 1.5 : 0, o.density ? o.density * s : perimeter / (steps.length ? 28 : 10));
          } else for (let y = d / 2; y < p.height; y += d) for (let x = d / 2; x < p.width; x += d) inner.push([x, y]);
          const m = meshPolygon(outline, inner, edge);
          if (m) { mesh = { hull: m.points.slice(0, m.hull), points: m.points, tris: m.triangles }; break; }
        }
        if (!mesh && first) {
          // Ear clipping of the outline alone (no interior points).
          const flat = first.flatMap((q) => q);
          const tri = new spine.Triangulator().triangulate(flat);
          const tris: [number, number, number][] = [];
          for (let i = 0; i + 2 < tri.length; i += 3) tris.push([tri[i]!, tri[i + 1]!, tri[i + 2]!]);
          if (tris.length) { mesh = { hull: first, points: first, tris }; fallback = "ear-clipping"; }
        }
      }
    }
    return { mesh, fallback };
  };
  const hostFields = new Map<string, { world: Pt[]; tris: [number, number, number][]; ws: { bone: string; w: number }[][] }>();
  const hostField = (h: Part) => {
    const had = hostFields.get(h.name);
    if (had) return had;
    const hb = owner.get(h.name) ?? "root", hs = transitions(h, hb), built = buildMesh(h, hs, []).mesh;
    const world = built ? built.points.map(([x, y]) => sk(h.left + x, h.top + y)) : [];
    const field = { world, tris: built?.tris ?? [], ws: world.map((q) => jointWeights(hb, hs, q)) };
    hostFields.set(h.name, field);
    return field;
  };
  const sampleField = (f: ReturnType<typeof hostField>, q: Pt) => {
    let best: { tri: [number, number, number]; l: [number, number, number]; miss: number } | null = null;
    for (const tri of f.tris) {
      const [a, b2, c] = tri.map((i) => f.world[i]!) as [Pt, Pt, Pt];
      const d = (b2[1] - c[1]) * (a[0] - c[0]) + (c[0] - b2[0]) * (a[1] - c[1]);
      if (Math.abs(d) < 1e-9) continue;
      const l1 = ((b2[1] - c[1]) * (q[0] - c[0]) + (c[0] - b2[0]) * (q[1] - c[1])) / d, l2 = ((c[1] - a[1]) * (q[0] - c[0]) + (a[0] - c[0]) * (q[1] - c[1])) / d, l3 = 1 - l1 - l2;
      const miss = Math.max(0, -l1) + Math.max(0, -l2) + Math.max(0, -l3);
      if (!best || miss < best.miss) best = { tri, l: [l1, l2, l3], miss };
      if (miss === 0) break;
    }
    if (!best) return null;
    const clamp = best.l.map((v) => Math.max(0, v)), sum = clamp.reduce((s2, v) => s2 + v, 0) || 1;
    const merged = new Map<string, number>();
    best.tri.forEach((vi, k) => { for (const v of f.ws[vi]!) merged.set(v.bone, (merged.get(v.bone) ?? 0) + v.w * clamp[k]! / sum); });
    return [...merged].map(([bone, w]) => ({ bone, w }));
  };
  for (const p of parts) {
    const bone = owner.get(p.name) ?? "root";
    const slot = p.name, att = p.path.split("/").pop()!;
    slots.push({ name: slot, bone, attachment: att, ...(p.opacity < 1 ? { color: `ffffff${Math.round(p.opacity * 255).toString(16).padStart(2, "0")}` } : {}) });
    const centre = sk(p.left + p.width / 2, p.top + p.height / 2);
    let mesh: { hull: Pt[]; points: Pt[]; tris: [number, number, number][] } | null = null;
    let fallback: "ear-clipping" | "region" | undefined;
    const steps = o.weights === "joint" || o.mesh === "sparse" ? transitions(p, bone) : [];
    const host = o.weights === "joint" && T(bone).parent && !steps.some((st) => st.to === bone) && !(faceDetail(p.name) && steps.length) ? hostOf(p, bone) : null;
    const hostBone = host ? owner.get(host.name) ?? "root" : "root", hostSteps = host ? transitions(host, hostBone) : [];
    ({ mesh, fallback } = buildMesh(p, steps, hostSteps));
    if (!mesh) {
      const [lx, ly] = toLocal(bone, centre[0], centre[1]);
      const b = T(bone);
      skin[slot] = { [att]: { ...(att !== p.path ? { path: p.path } : {}), x: +lx.toFixed(2), y: +ly.toFixed(2), ...(Math.abs(b.wr) > 1e-4 ? { rotation: +(-b.wr).toFixed(3) } : {}), width: p.width, height: p.height } };
      report.push({ slot, bone, mesh: null, weightedTo: [bone], ...(o.mesh !== "none" ? { fallback: "region" as const } : {}) });
      if (!p.shut) expected.push({ slot, points: [sk(p.left, p.top), sk(p.left + p.width, p.top), sk(p.left + p.width, p.top + p.height), sk(p.left, p.top + p.height)] });
      continue;
    }
    const world = mesh.points.map(([x, y]) => sk(p.left + x, p.top + y));
    if (!p.shut) expected.push({ slot, points: world });
    const uvs = mesh.points.flatMap(([x, y]) => [+(x / p.width).toFixed(5), +(y / p.height).toFixed(5)]);
    // Weights: the owning bone, shared near each joint with the neighbouring bone (parent at this bone's joint, children at theirs).
    const r = Math.max(4 * s, o.blend ? o.blend * s : 0.3 * Math.min(p.width, p.height));
    const neighbours: { bone: string; at: Pt }[] = [];
    if (o.weights !== "rigid" && o.weights !== "joint" && bone !== "root") {
      const b = T(bone);
      if (b.parent && b.parent !== "root") neighbours.push({ bone: b.parent, at: [b.wx, b.wy] });
      // A limb segment bends with the next one at its tip (knee, elbow); a body with several limbs stays rigid.
      const kids = children(bone);
      if (kids.length === 1 && b.length > 1.2 * Math.min(p.width, p.height) && Math.hypot(kids[0]!.wx - (b.wx + rot(b.length, 0, b.wr)[0]), kids[0]!.wy - (b.wy + rot(b.length, 0, b.wr)[1])) < r) {
        neighbours.push({ bone: kids[0]!.name, at: [kids[0]!.wx, kids[0]!.wy] });
      }
    }
    const weightedTo = new Set<string>([bone]);
    const vertices: number[] = [];
    let weighted = false;
    for (const [x, y] of world) {
      let all: { bone: string; w: number }[];
      if (o.weights === "joint" && host) {
        const line = ancestors(bone);
        const hf = hostField(host!), sampled = sampleField(hf, [x, y]) ?? jointWeights(hostBone, hostSteps, [x, y]);
        const field = faceDetail(p.name) ? sampled : [(sampleField(hf, centre) ?? jointWeights(hostBone, hostSteps, centre)).sort((a, b2) => b2.w - a.w)[0]!].map((v) => ({ bone: v.bone, w: 1 }));
        const stand = [bone, ...line].find((a) => field.some((v) => v.bone === a));
        const kept = field.map((v) => (v.bone === stand ? { bone, w: v.w } : v)).filter((v) => v.w >= 0.01).sort((a, b2) => b2.w - a.w).slice(0, 3);
        const total = kept.reduce((s2, v) => s2 + v.w, 0) || 1;
        all = kept.map((v) => ({ bone: v.bone, w: v.w / total }));
        const merged = new Map<string, number>();
        for (const v of all) merged.set(v.bone, (merged.get(v.bone) ?? 0) + v.w);
        all = [...merged].map(([b2, w]) => ({ bone: b2, w })).sort((a, b2) => boneIndex(a.bone) - boneIndex(b2.bone));
      } else if (o.weights === "joint") all = jointWeights(bone, steps, [x, y]);
      else {
        const ws: { bone: string; w: number }[] = [];
        for (const nb of neighbours) {
          const dd = Math.hypot(x - nb.at[0], y - nb.at[1]);
          const w = 0.5 * Math.max(0, 1 - dd / r) ** 2;
          if (w > 0.01) ws.push({ bone: nb.bone, w });
        }
        ws.sort((a, b) => b.w - a.w).splice(3);
        const own = 1 - ws.reduce((sum, v) => sum + v.w, 0);
        all = [{ bone, w: own }, ...ws].sort((a, b2) => boneIndex(a.bone) - boneIndex(b2.bone));
      }
      if (all.length > 1 || all[0]!.bone !== bone) weighted = true;
      vertices.push(all.length);
      for (const v of all) {
        weightedTo.add(v.bone);
        const [lx, ly] = toLocal(v.bone, x, y);
        vertices.push(boneIndex(v.bone), +lx.toFixed(3), +ly.toFixed(3), +v.w.toFixed(4));
      }
    }
    // Unweighted meshes store bone-local positions directly.
    const verts = weighted ? vertices : world.flatMap(([x, y]) => { const [lx, ly] = toLocal(bone, x, y); return [+lx.toFixed(3), +ly.toFixed(3)]; });
    // Edges (nonessential data, vertex index * 2): the hull only, as Spine writes a traced mesh, so the editor re-triangulates freely.
    const edges = mesh.hull.flatMap((_, i) => [i * 2, ((i + 1) % mesh.hull.length) * 2]);
    skin[slot] = { [att]: { type: "mesh", ...(att !== p.path ? { path: p.path } : {}), uvs, triangles: mesh.tris.flat(), vertices: verts, hull: mesh.hull.length, edges, width: p.width, height: p.height } };
    report.push({ slot, bone, mesh: { vertices: mesh.points.length, triangles: mesh.tris.length, hull: mesh.hull.length }, weightedTo: [...weightedTo], ...(fallback ? { fallback } : {}) });
  }
  // IK: a target bone at the child's tip, under the root, so the setup pose does not move.
  const constraints: Record<string, unknown>[] = [];
  const ikOut: NonNullable<AutoRigResult["ik"]> = [];
  for (const k of o.ik ?? []) {
    const [up, low] = k.bones;
    const U = bonesT.find((b) => b.name === up), L = bonesT.find((b) => b.name === low);
    if (!U || !L) throw new UserError(`IK: bones ${up} / ${low} not found.`);
    if (L.parent !== up) throw new UserError(`IK: "${low}" must be a child of "${up}".`);
    if (!L.length) throw new UserError(`IK: "${low}" needs a tip (a length) to place its target.`);
    const target = k.target ?? `${low}-target`;
    // The tip as the written (rounded) bones place it: a target off by rounding would re-solve a straight limb visibly.
    const fk = (n: string): { x: number; y: number; r: number } => {
      const j = bonesJson.find((b) => b.name === n) as { parent?: string; x?: number; y?: number; rotation?: number };
      if (!j.parent) return { x: 0, y: 0, r: 0 };
      const p = fk(j.parent), [ox2, oy2] = rot(j.x ?? 0, j.y ?? 0, p.r);
      return { x: p.x + ox2, y: p.y + oy2, r: p.r + (j.rotation ?? 0) };
    };
    const lw = fk(low), len = (bonesJson.find((b) => b.name === low) as { length?: number }).length ?? 0;
    const [tx, ty] = [lw.x + rot(len, 0, lw.r)[0], lw.y + rot(len, 0, lw.r)[1]];
    bonesJson.push({ name: target, parent: "root", x: +tx.toFixed(4), y: +ty.toFixed(4) } as never);
    bonesT.push({ name: target, parent: "root", wx: tx, wy: ty, wr: 0, length: 0 });
    // Bend direction from the drawn pose: the side the joint lies on, seen from the chain's start to its end.
    const cross = (L.wx - U.wx) * (ty - U.wy) - (L.wy - U.wy) * (tx - U.wx);
    const straight = Math.abs(cross) < 0.03 * Math.hypot(L.wx - U.wx, L.wy - U.wy) * Math.hypot(tx - U.wx, ty - U.wy);
    const bendPositive = k.bendPositive ?? (straight ? true : cross > 0);
    constraints.push({ name: `${low}-ik`, type: "ik", bones: [up, low], target, bendPositive });
    ikOut.push({ name: `${low}-ik`, bones: [up, low], target, bendPositive, ...(straight && k.bendPositive === undefined ? { straight: true } : {}) });
  }
  const doc: SkeletonJson = {
    skeleton: { spine: "4.3.26", x: +(minX - ox).toFixed(2), y: +(oy - maxY).toFixed(2), width: +(maxX - minX).toFixed(2), height: +(maxY - minY).toFixed(2), images: "./images/" },
    bones: bonesJson as SkeletonJson["bones"],
    slots: slots as SkeletonJson["slots"],
    ...(constraints.length ? { constraints: constraints as SkeletonJson["constraints"] } : {}),
    skins: [{ name: "default", attachments: skin as never }],
    animations: {},
  };
  return {
    doc, expected, report, ik: ikOut,
    bones: bonesT.map((b) => ({ name: b.name, parent: b.parent, x: +b.wx.toFixed(2), y: +b.wy.toFixed(2), rotation: +b.wr.toFixed(2), length: +b.length.toFixed(2) })),
    images: parts.map((p) => ({ path: p.path, width: p.width, height: p.height, data: p.data })),
  };
}

/**
 * Two test poses: bones not driven by IK (and not hanging from the root) turned +-25 degrees, IK targets moved so the
 * limbs bend one way then the other (30% of the chain length sideways, 35% towards the chain's start).
 */
export function testPoses(doc: SkeletonJson): { rotate: Record<string, number>; move: Record<string, Pt> }[] {
  const ik = (doc.constraints ?? []).filter((c) => (c as { type?: string }).type === "ik") as unknown as { bones: string[]; target: string }[];
  const driven = new Set(ik.flatMap((c) => c.bones)), targets = new Set(ik.map((c) => c.target));
  const bones = doc.bones ?? [];
  const free = bones.filter((b) => b.parent && b.parent !== "root" && !driven.has(b.name) && !targets.has(b.name)).map((b) => b.name);
  const len = (n: string) => (bones.find((b) => b.name === n) as { length?: number } | undefined)?.length ?? 0;
  return [1, -1].map((sign) => ({
    rotate: Object.fromEntries(free.map((n) => [n, 25 * sign])),
    move: Object.fromEntries(ik.map((c) => { const L = c.bones.reduce((s, n) => s + len(n), 0); return [c.target, [0.3 * L * sign, 0.35 * L] as Pt]; })),
  }));
}

/** The test poses as an animation: setup at 0, pose A at 0.1, pose B at 0.2 (held to 0.3 so a 10 fps render draws it). */
function poseAnimation(poses: ReturnType<typeof testPoses>) {
  const bones: Record<string, { rotate?: unknown[]; translate?: unknown[] }> = {};
  for (const n of Object.keys(poses[0]!.rotate)) bones[n] = { rotate: [{ value: 0 }, { time: 0.1, value: poses[0]!.rotate[n] }, { time: 0.2, value: poses[1]!.rotate[n] }, { time: 0.3, value: poses[1]!.rotate[n] }] };
  for (const n of Object.keys(poses[0]!.move)) {
    const [a, b] = [poses[0]!.move[n]!, poses[1]!.move[n]!];
    bones[n] = { translate: [{ x: 0, y: 0 }, { time: 0.1, x: a[0], y: a[1] }, { time: 0.2, x: b[0], y: b[1] }, { time: 0.3, x: b[0], y: b[1] }] };
  }
  if (!Object.keys(bones).length) bones.root = { rotate: [{ value: 0 }, { time: 0.3, value: 0 }] };
  return { bones };
}

/** spine-core checks: weighted setup positions, triangle folds when bones turn, influences. */
export function checkRig(doc: SkeletonJson, expected: { slot: string; points: Pt[] }[]): Pick<RigCheck, "setupError" | "folds" | "maxInfluences"> {
  const data = loadSkeletonData(doc);
  const sk = new spine.Skeleton(data);
  sk.setupPose();
  sk.updateWorldTransform(spine.Physics.none);
  let setupError = 0, maxInfluences = 1;
  const meshes: { slot: spine.Slot; att: spine.MeshAttachment; setupSigns: number[] }[] = [];
  const world = (slot: spine.Slot, att: spine.MeshAttachment) => { const out = new Array<number>(att.worldVerticesLength); att.computeWorldVertices(sk, slot, 0, att.worldVerticesLength, out, 0, 2); return out; };
  // Orientation of each triangle; slivers (twice the area under 0.01) count as neither, so float noise is not a flip.
  const signs = (v: number[], tris: number[]) => { const out: number[] = []; for (let i = 0; i < tris.length; i += 3) { const a = tris[i]! * 2, b = tris[i + 1]! * 2, c = tris[i + 2]! * 2; const cr = (v[b]! - v[a]!) * (v[c + 1]! - v[a + 1]!) - (v[c]! - v[a]!) * (v[b + 1]! - v[a + 1]!); out.push(Math.abs(cr) < 0.01 ? 0 : Math.sign(cr)); } return out; };
  for (const e of expected) {
    const slot = sk.findSlot(e.slot)!;
    const att = slot.pose.getAttachment() as spine.MeshAttachment;
    if (att instanceof spine.RegionAttachment) {
      // A region: its four corners against the part's rectangle (in any order).
      const r = att as unknown as spine.RegionAttachment, v = new Array<number>(8).fill(0);
      r.computeWorldVertices(slot, r.getOffsets(slot.pose), v, 0, 2);
      for (const [x, y] of e.points) setupError = Math.max(setupError, Math.min(...[0, 2, 4, 6].map((i) => Math.hypot(v[i]! - x, v[i + 1]! - y))));
      continue;
    }
    if (!(att instanceof spine.MeshAttachment)) continue;
    const v = world(slot, att);
    e.points.forEach(([x, y], i) => { setupError = Math.max(setupError, Math.hypot(v[i * 2]! - x, v[i * 2 + 1]! - y)); });
    if (att.bones) for (let i = 0; i < att.bones.length; i += att.bones[i]! + 1) maxInfluences = Math.max(maxInfluences, att.bones[i]!);
    meshes.push({ slot, att, setupSigns: signs(v, att.triangles as unknown as number[]) });
  }
  const folds: RigCheck["folds"] = [];
  const poses = testPoses(doc);
  const count = (apply: () => void) => {
    sk.setupPose();
    apply();
    sk.updateWorldTransform(spine.Physics.none);
    let flipped = 0;
    for (const m of meshes) {
      const now = signs(world(m.slot, m.att), m.att.triangles as unknown as number[]);
      now.forEach((sg, i) => { if (sg !== 0 && m.setupSigns[i] !== 0 && sg !== m.setupSigns[i]) flipped++; });
    }
    return flipped;
  };
  // Each free bone turned 30 degrees both ways; each IK target moved both ways (the limb bends).
  for (const name of Object.keys(poses[0]!.rotate)) {
    const bone = sk.findBone(name)!;
    const flipped = count(() => { bone.pose.rotation += 30; }) + count(() => { bone.pose.rotation -= 30; });
    if (flipped) folds.push({ bone: name, triangles: flipped });
  }
  for (const name of Object.keys(poses[0]!.move)) {
    const bone = sk.findBone(name)!;
    const flipped = poses.reduce((sum, pose) => sum + count(() => { bone.pose.x += pose.move[name]![0]; bone.pose.y += pose.move[name]![1]; }), 0);
    if (flipped) folds.push({ bone: name, triangles: flipped });
  }
  return { setupError: +setupError.toFixed(4), folds, maxInfluences };
}

/**
 * A starting rig from a layered PSD, in a new project: bones at the joints (suggested from where parts overlap, or
 * given), a mesh traced from each part's alpha with interior points, smooth weights around the joints, two-bone IK
 * chains, imported through the CLI's JSON import, then checked (setup positions, folds when bones turn, validator,
 * rig QA, Spine's render against the PSD). Never touches an existing project: a full re-import would drop editor-only data.
 */
export async function autoRig(config: Config, cli: SpineCli, o: AutoRigOptions): Promise<AutoRigResult> {
  if (!!o.psd === !!o.parts) throw new UserError("Pass either psd (a layered .psd) or parts (a folder of PNG parts with a layout JSON).");
  if (o.psd && (!isAbsolute(o.psd) || !existsSync(o.psd) || extname(o.psd).toLowerCase() !== ".psd")) throw new UserError(`psd must be an absolute path to an existing .psd: ${o.psd}`);
  if (!isAbsolute(o.output) || extname(o.output).toLowerCase() !== ".spine") throw new UserError(`output must be an absolute path ending in .spine: ${o.output}`);
  if (existsSync(o.output)) throw new UserError(`${o.output} already exists; spine_auto_rig only creates new projects (a full re-import over an animated project would drop editor-only data).`);
  if (!existsSync(dirname(o.output))) throw new UserError(`Folder does not exist: ${dirname(o.output)}`);
  const imagesDir = join(dirname(o.output), "images");
  if (existsSync(imagesDir) && readdirSync(imagesDir).length) throw new UserError(`${imagesDir} already has files; choose an empty folder for the new project.`);
  const scale = o.scale ?? 1;
  const name = (o.skeleton ?? (o.psd ? basename(o.psd, extname(o.psd)) : basename(o.output, extname(o.output)))).replace(/[^\w.-]+/g, "_");
  const { parts, skipped, notes: psdNotes } = o.psd ? collectParts(readPsd(readFileSync(o.psd), { useImageData: true }), scale) : partsFromLayout(o.parts!, o.layout, scale);
  if (!parts.length) throw new UserError(`No visible ${o.psd ? "layers" : "parts"} with pixels in the ${o.psd ? "PSD" : "layout"}.`);
  const notes: string[] = [...psdNotes, ...(skipped.length ? [`Skipped (hidden, [ignore] or empty): ${skipped.slice(0, 20).join(", ")}.`] : [])];
  if (!o.bones?.length) {
    const sug = o.rigFrom
      ? { ...bonesFromSkeleton(pickSkeleton(await loadProject(config, cli, assertInputPath(o.rigFrom, [".spine", ".json"]))).doc, parts, scale), ik: [] }
      : suggestRig(parts, scale, { riders: o.riders });
    // Suggestions are in PSD pixels of the unscaled file.
    const unscale = (p: [number, number]): [number, number] => [+(p[0] / scale).toFixed(1), +(p[1] / scale).toFixed(1)];
    const bones = sug.bones.map((b) => ({ ...b, joint: unscale(b.joint), ...(b.tip ? { tip: unscale(b.tip) } : {}) }));
    return { mode: "suggestions", skeleton: name, suggestions: { bones, ik: sug.ik, notes: sug.notes }, png: drawRig(parts, sug.bones), notes: [...notes, "Nothing written. Pass bones (and ik) to build the rig; dry-run first, then apply. The image shows the suggested bones (joint dot, line to the tip) over the art."] };
  }
  const lifted = liftFromShutLids(o.bones, parts);
  if (lifted.moved.length) notes.push(`Moved to their lid's parent, because the lid is drawn shut and hidden and its bone is set up collapsed: ${lifted.moved.join(", ")}.`);
  const rig = buildRig(parts, { bones: lifted.bones, ik: o.ik, mesh: o.mesh, weights: o.weights, density: o.density, blend: o.blend, origin: o.origin, scale });
  const result: AutoRigResult = { mode: "dry-run", skeleton: name, bones: rig.bones, slots: rig.report, ik: rig.ik, notes };
  const fell = rig.report.filter((x) => x.fallback);
  if (fell.length) notes.push(`No traced mesh for: ${fell.map((x) => `${x.slot} (${x.fallback})`).join(", ")}; mesh these by hand in Spine.`);
  const straight = rig.ik.filter((k) => k.straight).map((k) => k.name);
  if (straight.length) notes.push(`Drawn straight, so the bend direction is a guess: ${straight.join(", ")} (pass bendPositive in ik to choose).`);
  const core = checkRig(rig.doc, rig.expected);
  if (!o.apply) {
    result.check = { ...core, validateWarnings: [], rigQaWarnings: [], setupMatch: null };
    notes.push(`apply: true writes ${rig.images.length} image(s) to ${imagesDir} and creates ${o.output} through the Spine CLI.`);
    return result;
  }
  const work = join(config.workDir, "autorig", `${name}-${Date.now()}`);
  pruneDir(join(config.workDir, "autorig"), 10);
  mkdirSync(work, { recursive: true });
  let created = false;
  try {
    for (const img of rig.images) writePng(join(imagesDir, `${img.path}.png`), img);
    const tmp = join(dirname(o.output), `.spine-mcp-import-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, `${name}.json`), JSON.stringify({ ...rig.doc, skeleton: { ...rig.doc.skeleton, images: "../images/" } }));
    let run: Awaited<ReturnType<SpineCli["run"]>>;
    try { run = await cli.run(["-i", join(tmp, `${name}.json`), "-o", o.output, "-r"]); } finally { removeQuiet(tmp); }
    if (cliFailed(run) || run.warnings.length || !existsSync(o.output)) throw new UserError(`Spine import failed: ${[...run.errors, ...run.warnings, ...run.lines.slice(-3)].slice(0, 5).join(" | ")}`);
    created = true;
    result.mode = "created";
    result.project = o.output;
    const doc = (await loadProject(config, cli, o.output, { refresh: true })).skeletons[0]!.doc;
    const after = checkRig(doc, rig.expected);
    const validateWarnings = validateSkeleton(doc).filter((i) => i.severity !== "info").map((i) => `${i.code}: ${i.message}`.slice(0, 160));
    const rigQaWarnings = rigQa(doc, { baseDir: dirname(o.output) }).findings.filter((f) => f.severity === "warning").map((f) => `${f.code}: ${f.message}`);
    // Spine draws the setup pose (on a temporary copy with a one-frame animation), compared with the art as placed.
    let setupMatch: RigCheck["setupMatch"] = null;
    try {
      const copy = join(work, `${name}.spine`);
      writeFileSync(copy, readFileSync(o.output));
      for (const img of rig.images) writePng(join(work, "images", `${img.path}.png`), img);
      await addAnimationLocked(config, cli, { project: copy, name: "spine-mcp-poses", animation: poseAnimation(testPoses(doc)) as never, apply: true, editor: "inPlace" }); // a private copy: never staged
      const r = await renderFrames(config, cli, copy, { skeleton: name, animation: "spine-mcp-poses", fps: 10, scale: 100, background: "7f7f7fff" });
      const comp = composite(parts.filter((p) => !p.shut));
      writePng(join(work, "psd.png"), comp);
      flattenOnGrey(join(work, "psd.png"), join(work, "psd-grey.png"));
      const c = compareFrames(join(work, "psd-grey.png"), r.frames[0]!, [127, 127, 127]);
      setupMatch = { iou: +c.iou.toFixed(4), colorDiff: +c.colorDiff.toFixed(4), ok: c.iou >= 0.97 && c.colorDiff <= 0.05 };
      result.png = c.diffPng();
      // Setup, pose A, pose B side by side: how the joints and weights deform.
      if (r.frames.length >= 3) result.posePng = contactSheet(r.frames.slice(0, 3), { columns: 3, maxFrames: 3, cell: 360, background: [127, 127, 127] }).png;
    } catch (e) {
      notes.push(`Setup pose render check skipped: ${(e as Error).message.split("\n")[0]}`);
    }
    result.check = { ...after, validateWarnings, rigQaWarnings, setupMatch };
    notes.push(
      `Created ${o.output}: ${rig.bones.length} bones, ${rig.report.filter((x) => x.mesh).length} meshes, ${rig.ik.length} IK chain(s). A starting rig: refine joints, mesh density and weights in Spine before production.`,
      ...(after.folds.length ? [`Triangles flip in the test poses (bones turned 30 degrees, IK targets moved): ${after.folds.map((f) => `${f.bone} (${f.triangles})`).join(", ")}; raise blend or density there, or adjust the joint.`] : []),
    );
    return result;
  } catch (e) {
    if (!created) { rmSync(o.output, { force: true }); for (const img of rig.images) rmSync(join(imagesDir, `${img.path}.png`), { force: true }); }
    throw e;
  } finally {
    removeQuiet(work);
  }
}

/** The art on grey with each bone drawn as a line from its joint to its tip and a dot at the joint (PNG). */
export function drawRig(parts: Part[], bones: RigBoneSpec[]): Buffer {
  const comp = composite(parts.filter((p) => !p.shut)), pad = 20;
  const minX = Math.floor(Math.min(...parts.map((p) => p.left))) - pad, minY = Math.floor(Math.min(...parts.map((p) => p.top))) - pad;
  const w = comp.width + 2 * pad, h = comp.height + 2 * pad, out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = x - pad, sy = y - pad, di = (y * w + x) * 4;
    const inside = sx >= 0 && sy >= 0 && sx < comp.width && sy < comp.height, si = (sy * comp.width + sx) * 4, a = inside ? comp.data[si + 3]! / 255 : 0;
    // The art faded so the bones stand out.
    for (let c = 0; c < 3; c++) out.data[di + c] = Math.round(0.45 * (inside ? a * comp.data[si + c]! + (1 - a) * 127 : 127) + 0.55 * 127);
    out.data[di + 3] = 255;
  }
  const dot = (cx: number, cy: number, r: number, rgb: number[]) => {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h || (x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      out.data.set(rgb, (y * w + x) * 4);
    }
  };
  const line = (a: Pt, b: Pt, r: number, rgb: number[]) => { const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])) + 1; for (let i = 0; i <= n; i++) dot(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, r, rgb); };
  const at = (q: [number, number]): Pt => [q[0] - minX, q[1] - minY];
  for (const b of bones) {
    const j = at(b.joint);
    if (b.parent) { const p = bones.find((x) => x.name === b.parent); if (p) line(at(p.joint), j, 0.6, [255, 255, 255]); }
    if (b.tip) line(j, at(b.tip), 2, [255, 140, 0]);
  }
  for (const b of bones) { const j = at(b.joint); dot(j[0], j[1], 4.5, [20, 20, 20]); dot(j[0], j[1], 3, b.parent ? [255, 220, 0] : [255, 60, 60]); }
  return PNG.sync.write(out);
}

