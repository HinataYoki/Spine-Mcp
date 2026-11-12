import { keyTime } from "./curves.js";
import { iterateTimelines } from "./inspect.js";
import type { AnimationJson, Key } from "./types.js";

export const DEFAULT_FPS = 30;

export type ValueKind = "angle" | "translate" | "scale" | "unit" | "deform" | "fine" | "precise";

export function projectFps(doc?: { skeleton?: { fps?: number } } | null): number {
  const fps = doc?.skeleton?.fps;
  return typeof fps === "number" && fps > 0 ? fps : DEFAULT_FPS;
}

export function roundHalfAway(v: number, decimals = 0): number {
  if (!Number.isFinite(v)) return v;
  const p = 10 ** decimals;
  const r = (Math.sign(v) * Math.round(Math.abs(v) * p + 1e-7)) / p;
  return r === 0 ? 0 : +r.toFixed(decimals);
}

export function snapTime(t: number, fps: number): number {
  const s = +(roundHalfAway(t * fps) / fps).toFixed(6);
  return s === 0 ? 0 : s;
}

export function framesOf(t: number, fps: number): number {
  return roundHalfAway(t * fps);
}

export function onFrame(t: number, fps: number): boolean {
  return Math.abs(t * fps - Math.round(t * fps)) < 1e-4;
}

const wholeOrHalf = (v: number) => (Math.abs(v) < 2 ? roundHalfAway(v * 2) / 2 : roundHalfAway(v));

export function roundValue(kind: ValueKind, v: number): number {
  switch (kind) {
    case "angle":
    case "translate":
      return wholeOrHalf(v);
    case "scale":
    case "unit":
    case "deform":
    case "fine":
      return roundHalfAway(v, 2);
    case "precise":
      return roundHalfAway(v, 3);
  }
}

export function roundingStep(kind: ValueKind): number {
  return kind === "angle" || kind === "translate" ? 1 : kind === "precise" ? 0.001 : 0.01;
}

export function boneValueKind(prop: string): ValueKind | null {
  if (prop === "rotate" || prop.startsWith("shear")) return "angle";
  if (prop.startsWith("translate")) return "translate";
  if (prop.startsWith("scale")) return "scale";
  return null;
}

const BONE_FIELDS: Record<string, string[]> = {
  rotate: ["value"], translate: ["x", "y"], translatex: ["value"], translatey: ["value"],
  scale: ["x", "y"], scalex: ["value"], scaley: ["value"], shear: ["x", "y"], shearx: ["value"], sheary: ["value"],
};

interface Field { field: string; kind: ValueKind }

function fieldsOf(kind: string): { fields: Field[]; vertices: boolean } {
  const [section, prop = ""] = kind.split(".");
  if (section === "bone") {
    const k = boneValueKind(prop);
    return { fields: k ? (BONE_FIELDS[prop] ?? []).map((field) => ({ field, kind: k })) : [], vertices: false };
  }
  if (kind === "slot.alpha") return { fields: [{ field: "value", kind: "unit" }], vertices: false };
  if (kind === "ik") return { fields: [{ field: "mix", kind: "unit" }, { field: "softness", kind: "translate" }], vertices: false };
  if (kind === "transform") return { fields: ["mixRotate", "mixX", "mixY", "mixScaleX", "mixScaleY", "mixShearY"].map((field) => ({ field, kind: "unit" as const })), vertices: false };
  if ((section === "physics" || section === "slider") && prop) return { fields: [{ field: "value", kind: "unit" }], vertices: false };
  if (kind === "attachment.deform") return { fields: [], vertices: true };
  return { fields: [], vertices: false };
}

export interface TidyOptions {
  times?: boolean;
  values?: boolean;
  keep?: number[];
  only?: (kind: string, owner: string) => boolean;
}

export interface TidyStats {
  keys: number;
  snapped: number;
  maxShiftFrames: number;
  merged: number;
  rounded: number;
}

const setTime = (k: Key, t: number) => {
  if (t === 0) delete k.time;
  else k.time = t;
};

function tidyKeys(keys: Key[], fps: number, spec: { fields: Field[]; vertices: boolean }, o: TidyOptions, stats: TidyStats, kept: (v: number) => number | null, keepAll = false) {
  if (!keys.length) return;
  stats.keys += keys.length;
  const old = keys.map(keyTime);
  const fresh = o.times === false ? old.slice() : old.map((t) => snapTime(t, fps));
  const survivors: number[] = [];
  for (let i = 0; i < keys.length; i++) {
    if (!keepAll && i + 1 < keys.length && Math.abs(fresh[i + 1]! - fresh[i]!) < 1e-9) {
      const before = survivors.length ? fresh[survivors[survivors.length - 1]!]! : -Infinity;
      const earlier = snapTime(fresh[i]! - 1 / fps, fps);
      if (keys[i]!.curve === "stepped" && earlier >= 0 && earlier > before + 1e-9) {
        fresh[i] = earlier;
        survivors.push(i);
        continue;
      }
      stats.merged++;
      continue;
    }
    survivors.push(i);
  }
  const absolute = spec.fields.length > 0;
  const valueOf = (k: Key, f: string) => (typeof k[f] === "number" ? (k[f] as number) : undefined);
  const out = survivors.map((i, n) => {
    const k: Key = structuredClone(keys[i]!);
    const t = fresh[i]!;
    if (Math.abs(t - old[i]!) > 1e-9) {
      stats.snapped++;
      stats.maxShiftFrames = Math.max(stats.maxShiftFrames, Math.abs(t - old[i]!) * fps);
      setTime(k, t);
    }
    const j = survivors[n + 1];
    if (Array.isArray(k.curve) && j !== undefined) {
      const t0 = old[i]!, t1 = old[i + 1]!, span = t1 - t0, spanNew = fresh[j]! - t;
      const curve = k.curve.map((c, idx) => (idx % 2 === 0 ? +(span > 1e-12 ? t + ((c - t0) * spanNew) / span : t + spanNew / 3).toFixed(6) : c));
      if (absolute && j !== i + 1) {
        spec.fields.forEach((f, c) => {
          const a = valueOf(keys[i + 1]!, f.field), b = valueOf(keys[j]!, f.field);
          if (a !== undefined && b !== undefined && curve[c * 4 + 3] !== undefined) curve[c * 4 + 3] = curve[c * 4 + 3]! + (b - a);
        });
      }
      k.curve = curve;
    }
    return k;
  });
  if (o.values !== false) {
    out.forEach((k, n) => {
      if (spec.vertices && Array.isArray(k.vertices)) {
        k.vertices = (k.vertices as number[]).map((v) => {
          const r = kept(v) ?? roundValue("deform", v);
          if (r !== v) stats.rounded++;
          return r;
        });
      }
      spec.fields.forEach((f, c) => {
        const v = valueOf(k, f.field);
        if (v === undefined) return;
        const r = kept(v) ?? roundValue(f.kind, v), d = r - v;
        k[f.field] = r;
        if (Math.abs(d) < 1e-12) return;
        stats.rounded++;
        if (Array.isArray(k.curve) && k.curve[c * 4 + 1] !== undefined) k.curve[c * 4 + 1] = +(k.curve[c * 4 + 1]! + d).toFixed(6);
        const prev = out[n - 1];
        if (prev && Array.isArray(prev.curve) && prev.curve[c * 4 + 3] !== undefined) prev.curve[c * 4 + 3] = +(prev.curve[c * 4 + 3]! + d).toFixed(6);
      });
    });
  }
  keys.splice(0, keys.length, ...out);
}

export function tidyAnimation(source: AnimationJson, fps: number, o: TidyOptions = {}): { animation: AnimationJson; note: string | null; stats: TidyStats } {
  const animation = structuredClone(source);
  const stats: TidyStats = { keys: 0, snapped: 0, maxShiftFrames: 0, merged: 0, rounded: 0 };
  const keep = (o.keep ?? []).filter((v) => Number.isFinite(v)).map(Math.abs);
  const kept = (v: number) => { const k = keep.find((x) => Math.abs(Math.abs(v) - x) < 1e-9); return k === undefined ? null : v < 0 ? -k : k; };
  for (const t of iterateTimelines(animation)) {
    if (o.only && !o.only(t.kind, t.owner)) continue;
    // Spine allows several events at one time: each one fires, so they are never merged.
    tidyKeys(t.keys, fps, fieldsOf(t.kind), o, stats, kept, t.kind === "events");
  }
  return { animation, note: tidyNote(stats, fps), stats };
}

export function tidyNote(s: TidyStats, fps: number): string | null {
  const parts: string[] = [];
  if (s.snapped) parts.push(`${s.snapped} key(s) moved onto the ${fps} fps frame grid (up to ${roundHalfAway(s.maxShiftFrames, 2)} frame)`);
  if (s.merged) parts.push(`${s.merged} key(s) that landed on the same frame merged`);
  if (s.rounded) parts.push(`${s.rounded} value(s) rounded (angles and translation whole, halves under 2; scale, alpha, mix and deform 2 decimals)`);
  return parts.length ? `Tidy: ${parts.join("; ")}.` : null;
}

export function tidyGenerated<T extends { animation: AnimationJson; notes: string[] }>(r: T, fps: number, keep: (number | undefined)[] = [], scope: { only?: (kind: string, owner: string) => boolean; values?: (kind: string, owner: string) => boolean } = {}): T {
  const given = keep.filter((v): v is number => typeof v === "number");
  const only = scope.only;
  let animation = tidyAnimation(r.animation, fps, { values: false, ...(only ? { only } : {}) }).animation;
  const rounding = (kind: string, owner: string) => (!only || only(kind, owner)) && (!scope.values || scope.values(kind, owner));
  animation = tidyAnimation(animation, fps, { times: false, keep: given, only: rounding }).animation;
  return { ...r, animation, notes: [...r.notes, `Keys on whole frames at ${fps} fps; values rounded (whole degrees and units, scale and alpha 2 decimals)${given.length ? ", the numbers you gave kept as given" : ""}.`] };
}

export const toFourDecimals = (n: number) => +n.toFixed(4);

export interface FitChannel {
  values: number[];
  tol: number;
  kind?: ValueKind;
}

export interface FitResult {
  keys: number[];
  values: number[][];
  curves: number[][];
}

function slopes(times: number[], v: number[], loop: boolean): number[] {
  const n = v.length - 1;
  return v.map((_, i) => {
    if (n < 1) return 0;
    if (i === 0 || i === n) {
      if (loop && n >= 2) {
        const span = times[n]! - times[n - 1]! + times[1]! - times[0]!;
        // Steps on both sides of the seam: ends a whole turn apart (a spin) still have the spin's slope.
        return span > 0 ? (v[1]! - v[0]! + v[n]! - v[n - 1]!) / span : 0;
      }
      return i === 0 ? (v[1]! - v[0]!) / (times[1]! - times[0]! || 1) : (v[n]! - v[n - 1]!) / (times[n]! - times[n - 1]! || 1);
    }
    return (v[i + 1]! - v[i - 1]!) / (times[i + 1]! - times[i - 1]! || 1);
  });
}

function turningPoints(v: number[], tol: number): number[] {
  const n = v.length - 1, ext: number[] = [];
  const sign = (d: number) => (Math.abs(d) < 1e-12 ? 0 : d > 0 ? 1 : -1);
  for (let i = 1; i < n; i++) {
    const a = sign(v[i]! - v[i - 1]!), b = sign(v[i + 1]! - v[i]!);
    if (a !== b && !(a === 0 && b === 0)) ext.push(i);
  }
  const marks = [0, ...ext, n];
  let changed = true;
  while (changed) {
    changed = false;
    for (let k = 1; k + 1 < marks.length; k++) {
      const p = v[marks[k - 1]!]!, c = v[marks[k]!]!;
      if (Math.abs(c - p) <= tol) { marks.splice(k, 1); changed = true; break; }
    }
  }
  return marks.slice(1, -1);
}

export function fitBezier(times: number[], channels: FitChannel[], o: { loop?: boolean; roundKey?: (index: number, raw: number[]) => number[]; measure?: (index: number, fitted: number[], raw: number[]) => number } = {}): FitResult {
  const n = times.length - 1;
  if (n < 1) return { keys: [0], values: [channels.map((c) => c.kind ? roundValue(c.kind, c.values[0]!) : c.values[0]!)], curves: [] };
  const loop = !!o.loop;
  const m = channels.map((c) => slopes(times, c.values, loop));
  const flat = channels.map((c) => {
    const s = new Set(turningPoints(c.values, 0));
    const v = c.values;
    if (loop && n >= 2 && (v[1]! - v[0]!) * (v[n]! - v[n - 1]!) <= 0) { s.add(0); s.add(n); }
    return s;
  });
  const rounded = new Map<number, number[]>();
  const keyVal = (c: number, i: number) => {
    if (o.roundKey) {
      let r = rounded.get(i);
      if (!r) { r = o.roundKey(i, channels.map((ch) => ch.values[i]!)); rounded.set(i, r); }
      return r[c]!;
    }
    const ch = channels[c]!;
    return ch.kind ? roundValue(ch.kind, ch.values[i]!) : ch.values[i]!;
  };
  const tangent = (c: number, i: number) => (flat[c]!.has(i) ? 0 : m[c]![i]!);
  const tolEff = channels.map((c) => c.tol + (c.kind && !o.roundKey ? roundingStep(c.kind) / 2 : 0));
  const hermite = (c: number, a: number, b: number, t: number) => {
    const t0 = times[a]!, t1 = times[b]!, h = t1 - t0, u = (t - t0) / h;
    const v0 = keyVal(c, a), v1 = keyVal(c, b), m0 = tangent(c, a), m1 = tangent(c, b);
    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * v0 + (u3 - 2 * u2 + u) * h * m0 + (-2 * u3 + 3 * u2) * v1 + (u3 - u2) * h * m1;
  };
  const worst = (a: number, b: number): [number, number] => {
    let at = -1, err = 1;
    for (let k = a + 1; k < b; k++) {
      let e = 0;
      if (o.measure) e = o.measure(k, channels.map((_, c) => hermite(c, a, b, times[k]!)), channels.map((ch) => ch.values[k]!));
      else channels.forEach((ch, c) => { e = Math.max(e, Math.abs(hermite(c, a, b, times[k]!) - ch.values[k]!) / (tolEff[c]! || 1e-9)); });
      if (e > err) { err = e; at = k; }
    }
    return [at, err];
  };
  const keys = new Set<number>([0, n]);
  channels.forEach((ch, c) => { for (const i of turningPoints(ch.values, tolEff[c]!)) keys.add(i); });
  let sorted = [...keys].sort((a, b) => a - b);
  for (let pass = 0; pass <= n; pass++) {
    let added = false;
    for (let s = 0; s + 1 < sorted.length; s++) {
      const [at] = worst(sorted[s]!, sorted[s + 1]!);
      if (at >= 0) { keys.add(at); added = true; }
    }
    if (!added) break;
    sorted = [...keys].sort((a, b) => a - b);
  }
  for (let s = 1; s + 1 < sorted.length; s++) {
    const a = sorted[s - 1]!, k = sorted[s]!, b = sorted[s + 1]!;
    const fitted = channels.map((_, c) => hermite(c, a, b, times[k]!)), raw = channels.map((ch) => ch.values[k]!);
    const within = o.measure ? o.measure(k, fitted, raw) <= 1 : channels.every((_, c) => Math.abs(fitted[c]! - raw[c]!) <= tolEff[c]!);
    if (within && worst(a, b)[0] < 0) { sorted.splice(s, 1); s--; }
  }
  const values = sorted.map((i) => channels.map((_, c) => keyVal(c, i)));
  const curves = sorted.slice(0, -1).map((a, s) => {
    const b = sorted[s + 1]!, t0 = times[a]!, t1 = times[b]!, d = t1 - t0;
    return channels.flatMap((_, c) => [+(t0 + d / 3).toFixed(6), +(keyVal(c, a) + (tangent(c, a) * d) / 3).toFixed(4), +(t1 - d / 3).toFixed(6), +(keyVal(c, b) - (tangent(c, b) * d) / 3).toFixed(4)]);
  });
  return { keys: sorted, values, curves };
}

