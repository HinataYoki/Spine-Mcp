import type { ArtFinding } from "./artqa.js";
import type { Part } from "./autorig.js";

export interface SourceImage { left: number; top: number; width: number; height: number; data: Uint8ClampedArray }

export interface SeamReport { front: string; back: string; length: number; reachMedian: number; reachP10: number; room: number; bare: number; heightPct: number }

const SMOOTH = 6;
const OUTER = 4;

interface Frame { x0: number; y0: number; w: number; h: number }

function frameOf(parts: Part[], source?: SourceImage): Frame {
  const boxes = parts.map((p) => [Math.floor(p.left), Math.floor(p.top), Math.ceil(p.left + p.width), Math.ceil(p.top + p.height)]);
  if (source) boxes.push([source.left, source.top, source.left + source.width, source.top + source.height]);
  const x0 = Math.min(...boxes.map((b) => b[0]!)), y0 = Math.min(...boxes.map((b) => b[1]!));
  return { x0, y0, w: Math.max(...boxes.map((b) => b[2]!)) - x0, h: Math.max(...boxes.map((b) => b[3]!)) - y0 };
}

function alphaOn(f: Frame, p: { left: number; top: number; width: number; height: number; data: Uint8ClampedArray }, scale = 1): Float32Array {
  const out = new Float32Array(f.w * f.h);
  const ox = Math.round(p.left) - f.x0, oy = Math.round(p.top) - f.y0;
  for (let y = 0; y < p.height; y++) {
    const ty = oy + y;
    if (ty < 0 || ty >= f.h) continue;
    for (let x = 0; x < p.width; x++) {
      const tx = ox + x;
      if (tx < 0 || tx >= f.w) continue;
      out[ty * f.w + tx] = (p.data[(y * p.width + x) * 4 + 3]! / 255) * scale;
    }
  }
  return out;
}

function nearest(f: Frame, isSource: (i: number) => boolean): { dist: Float32Array; from: Int32Array } {
  const n = f.w * f.h, sx = new Int32Array(n).fill(-1), sy = new Int32Array(n).fill(-1), dist = new Float32Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) if (isSource(i)) { sx[i] = i % f.w; sy[i] = (i / f.w) | 0; dist[i] = 0; }
  const relax = (x: number, y: number, nx: number, ny: number) => {
    if (nx < 0 || ny < 0 || nx >= f.w || ny >= f.h) return;
    const j = ny * f.w + nx;
    if (sx[j]! < 0) return;
    const i = y * f.w + x, d = Math.hypot(x - sx[j]!, y - sy[j]!);
    if (d < dist[i]!) { dist[i] = d; sx[i] = sx[j]!; sy[i] = sy[j]!; }
  };
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) { relax(x, y, x - 1, y); relax(x, y, x - 1, y - 1); relax(x, y, x, y - 1); relax(x, y, x + 1, y - 1); }
    for (let x = f.w - 1; x >= 0; x--) relax(x, y, x + 1, y);
  }
  for (let y = f.h - 1; y >= 0; y--) {
    for (let x = f.w - 1; x >= 0; x--) { relax(x, y, x + 1, y); relax(x, y, x + 1, y + 1); relax(x, y, x, y + 1); relax(x, y, x - 1, y + 1); }
    for (let x = 0; x < f.w; x++) relax(x, y, x - 1, y);
  }
  const from = new Int32Array(n);
  for (let i = 0; i < n; i++) from[i] = sx[i]! < 0 ? -1 : sy[i]! * f.w + sx[i]!;
  return { dist, from };
}

function maxFilter(f: Frame, values: Float32Array, r: number): Float32Array {
  const tmp = new Float32Array(values.length), out = new Float32Array(values.length);
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
    let m = 0;
    for (let k = Math.max(0, x - r); k <= Math.min(f.w - 1, x + r); k++) m = Math.max(m, values[y * f.w + k]!);
    tmp[y * f.w + x] = m;
  }
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
    let m = 0;
    for (let k = Math.max(0, y - r); k <= Math.min(f.h - 1, y + r); k++) m = Math.max(m, tmp[k * f.w + x]!);
    out[y * f.w + x] = m;
  }
  return out;
}

const quantile = (v: number[], q: number) => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]!; };

export function jointSeams(parts: Part[], joints: [string, string][], f: Frame = frameOf(parts)): SeamReport[] {
  const alphas = parts.map((p) => alphaOn(f, p, p.opacity));
  const n = f.w * f.h, owner = new Int32Array(n).fill(-1);
  alphas.forEach((a, k) => { for (let i = 0; i < n; i++) if (a[i]! >= 0.5) owner[i] = k; });
  const outside = nearest(f, (i) => owner[i]! < 0).dist;
  const index = new Map(parts.map((p, k) => [p.name, k]));
  const out: SeamReport[] = [];
  for (const [a, b] of joints) {
    const ia = index.get(a), ib = index.get(b);
    if (ia === undefined || ib === undefined) continue;
    const [fi, bi] = ia > ib ? [ia, ib] : [ib, ia];
    const seam: number[] = [];
    for (let i = 0; i < n; i++) {
      if (owner[i] !== bi || outside[i]! <= OUTER) continue;
      const x = i % f.w, y = (i / f.w) | 0;
      let touches = false;
      for (let dy = -1; dy <= 1 && !touches; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < f.w && ny < f.h && owner[ny * f.w + nx] === fi) { touches = true; break; }
      }
      if (touches) seam.push(i);
    }
    if (seam.length < 15) continue;
    let top = f.h, bottom = -1;
    for (let i = 0; i < n; i++) if (alphas[fi]![i]! >= 0.5 || alphas[bi]![i]! >= 0.5) { const y = (i / f.w) | 0; if (y < top) top = y; if (y > bottom) bottom = y; }
    const height = Math.max(1, bottom - top + 1);
    const { dist, from } = nearest(f, (i) => owner[i] === bi);
    const reach = new Float32Array(n), room = new Float32Array(n), back = alphas[bi]!;
    for (let i = 0; i < n; i++) {
      if (owner[i] !== fi || from[i]! < 0) continue;
      const s = from[i]!;
      if (dist[i]! > room[s]!) room[s] = dist[i]!;
      if (back[i]! >= 0.5 && dist[i]! > reach[s]!) reach[s] = dist[i]!;
    }
    const sparseReach = new Float32Array(n), sparseRoom = new Float32Array(n);
    for (const i of seam) { sparseReach[i] = reach[i]!; sparseRoom[i] = room[i]!; }
    const r = maxFilter(f, sparseReach, SMOOTH), m = maxFilter(f, sparseRoom, SMOOTH);
    const rv = seam.map((i) => r[i]!), mv = seam.map((i) => m[i]!);
    const median = quantile(rv, 0.5);
    out.push({ front: parts[fi]!.name, back: parts[bi]!.name, length: seam.length, reachMedian: +median.toFixed(1), reachP10: +quantile(rv, 0.1).toFixed(1), room: +quantile(mv, 0.5).toFixed(1), bare: +(rv.filter((v) => v < 1).length / rv.length).toFixed(3), heightPct: +((100 * median) / height).toFixed(2) });
  }
  return out;
}

export function cutQa(parts: Part[], o: { joints?: [string, string][]; source?: SourceImage } = {}): { findings: ArtFinding[]; seams: SeamReport[] } {
  const findings: ArtFinding[] = [];
  if (!parts.length) return { findings, seams: [] };
  const f = frameOf(parts, o.source);
  const n = f.w * f.h;
  const alphas = parts.map((p) => alphaOn(f, p, p.opacity));
  const comp = new Float32Array(n), peak = new Float32Array(n), soft = new Uint8Array(n), solid = new Uint8Array(n);
  const topSoft = new Int32Array(n).fill(-1);
  alphas.forEach((a, k) => {
    for (let i = 0; i < n; i++) {
      const v = a[i]!;
      if (v <= 0) continue;
      comp[i] = v + comp[i]! * (1 - v);
      if (v > peak[i]!) peak[i] = v;
      if (v >= 0.98) solid[i] = 1;
      else if (v > 0.02) { soft[i]!++; topSoft[i] = k; }
    }
  });

  const doubled = new Map<string, number>();
  let doubledPx = 0;
  for (let i = 0; i < n; i++) {
    if (soft[i]! < 2 || solid[i] || comp[i]! - peak[i]! <= 10 / 255) continue;
    doubledPx++;
    const names = alphas.map((a, k) => (a[i]! > 0.02 ? parts[k]!.name : "")).filter(Boolean).slice(-2).join(" + ");
    doubled.set(names, (doubled.get(names) ?? 0) + 1);
  }
  if (doubledPx >= 40) findings.push({ severity: "warning", code: "double-alpha", message: `${doubledPx} px of soft edge are drawn by two parts at once, so they come out more opaque than either: a harder, darker outline. Keep each edge pixel in one part (the front one), or lower the back part's alpha there.`, parts: [...doubled].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} (${v} px)`) });

  if (o.source) {
    const src = alphaOn(f, o.source);
    const raised = new Map<string, { px: number; by: number }>();
    for (let i = 0; i < n; i++) {
      if (src[i]! >= 0.98 || comp[i]! <= src[i]! + 10 / 255) continue;
      const k = topSoft[i]! >= 0 ? topSoft[i]! : alphas.findLastIndex((a) => a[i]! > 0);
      if (k < 0) continue;
      const r = raised.get(parts[k]!.name) ?? { px: 0, by: 0 };
      r.px++; r.by += comp[i]! - src[i]!;
      raised.set(parts[k]!.name, r);
    }
    const total = [...raised.values()].reduce((s, r) => s + r.px, 0);
    if (total >= 40) findings.push({ severity: "warning", code: "edge-alpha-raised", message: `${total} px of the outer edge are more opaque than the painting the parts were cut from: a soft edge was hardened (pasted twice, or painted over). Edge alpha may only go down.`, parts: [...raised].sort((a, b) => b[1].px - a[1].px).slice(0, 6).map(([k, r]) => `${k} (${r.px} px, +${Math.round((255 * r.by) / r.px)})`) });
  }

  const strays: string[] = [];
  for (const p of parts) {
    const w = p.width, h = p.height, seen = new Int32Array(w * h).fill(-1), comps: { px: number; peak: number; x: number; y: number }[] = [];
    for (let s = 0; s < w * h; s++) {
      if (seen[s]! >= 0 || p.data[s * 4 + 3]! <= 12) continue;
      const stack = [s], c = { px: 0, peak: 0, x: 0, y: 0 };
      seen[s] = comps.length;
      while (stack.length) {
        const i = stack.pop()!, x = i % w, y = (i / w) | 0;
        c.px++; c.x += x; c.y += y; c.peak = Math.max(c.peak, p.data[i * 4 + 3]! / 255);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy, j = ny * w + nx;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && seen[j]! < 0 && p.data[j * 4 + 3]! > 12) { seen[j] = comps.length; stack.push(j); }
        }
      }
      comps.push(c);
    }
    if (comps.length < 2) continue;
    const main = comps.reduce((m, c) => (c.px > m.px ? c : m));
    for (const c of comps) if (c !== main && c.px <= 30 && c.peak >= 0.3) strays.push(`${p.name} at (${Math.round(p.left + c.x / c.px)}, ${Math.round(p.top + c.y / c.px)})`);
  }
  if (strays.length) findings.push({ severity: "warning", code: "stray-pixels", message: "Small islands of paint apart from their part (30 px or less, alpha 0.3 or more): stray strokes from the cut. They ride along with the part and show when it moves.", parts: strays.slice(0, 12) });

  const seams = o.joints?.length ? jointSeams(parts, o.joints, f) : [];
  const bare = seams.filter((s) => s.bare > 0.1);
  if (bare.length) findings.push({ severity: "warning", code: "joint-bare", message: "Joints where the back part has no paint under the front part along part of the seam: the first turn opens a gap there. Paint the back part on under the front one.", parts: bare.map((s) => `${s.front} over ${s.back}: ${Math.round(100 * s.bare)} % of ${s.length} px`) });
  const shallow = seams.filter((s) => s.bare <= 0.1 && s.heightPct < 4 && s.reachMedian < s.room);
  if (shallow.length) findings.push({ severity: "info", code: "joint-shallow", message: "Hidden paint under the front part at each joint (median along the seam): fine for small turns; production rigs often paint 4-7 % of the character's height at joints. Check with a bend before rigging.", parts: shallow.map((s) => `${s.front} over ${s.back}: ${s.reachMedian} px (${s.heightPct} % of the two parts' height)`) });
  return { findings, seams };
}
