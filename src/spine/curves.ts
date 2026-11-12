import type { Curve, Key } from "./types.js";

/** Value fields and neutral (default) value of numeric bone timelines. */
export const BONE_CHANNELS: Record<string, { fields: string[]; neutral: number }> = {
  rotate: { fields: ["value"], neutral: 0 },
  translate: { fields: ["x", "y"], neutral: 0 },
  translatex: { fields: ["value"], neutral: 0 },
  translatey: { fields: ["value"], neutral: 0 },
  scale: { fields: ["x", "y"], neutral: 1 },
  scalex: { fields: ["value"], neutral: 1 },
  scaley: { fields: ["value"], neutral: 1 },
  shear: { fields: ["x", "y"], neutral: 0 },
  shearx: { fields: ["value"], neutral: 0 },
  sheary: { fields: ["value"], neutral: 0 },
};

/**
 * Reads and writes the numeric channels of a key, in curve order. Bone timelines store numbers in fields
 * (`value`, `x`/`y`); 4.3 slot colors store hex strings (`color`, `light` + `dark`) whose components are 0..1.
 */
export interface Channels {
  count: number;
  get(k: Key): number[];
  set(k: Key, values: number[]): void;
}

export function fieldChannels(fields: string[], neutral: number): Channels {
  return {
    count: fields.length,
    get: (k) => fields.map((f) => (k[f] as number | undefined) ?? neutral),
    set: (k, v) => fields.forEach((f, i) => (k[f] = v[i])),
  };
}

const hexToRgba = (hex: string | undefined, n: number) =>
  Array.from({ length: n }, (_, i) => parseInt((hex ?? "ffffffff").slice(i * 2, i * 2 + 2) || "ff", 16) / 255);
const rgbaToHex = (v: number[]) =>
  v.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0")).join("");

/** Channels of a slot timeline (`rgba`, `rgb`, `alpha`, `rgba2`, `rgb2`); null for non-numeric ones (attachment, sequence). */
export function slotChannels(prop: string): Channels | null {
  switch (prop) {
    case "rgba":
      return { count: 4, get: (k) => hexToRgba(k.color as string, 4), set: (k, v) => (k.color = rgbaToHex(v)) };
    case "rgb":
      return { count: 3, get: (k) => hexToRgba(k.color as string, 3), set: (k, v) => (k.color = rgbaToHex(v)) };
    case "alpha":
      return fieldChannels(["value"], 1);
    case "rgba2":
      return {
        count: 7,
        get: (k) => [...hexToRgba(k.light as string, 4), ...hexToRgba(k.dark as string, 3)],
        set: (k, v) => ((k.light = rgbaToHex(v.slice(0, 4))), (k.dark = rgbaToHex(v.slice(4, 7)))),
      };
    case "rgb2":
      return {
        count: 6,
        get: (k) => [...hexToRgba(k.light as string, 3), ...hexToRgba(k.dark as string, 3)],
        set: (k, v) => ((k.light = rgbaToHex(v.slice(0, 3))), (k.dark = rgbaToHex(v.slice(3, 6)))),
      };
    default:
      return null;
  }
}

type P = [number, number];
const lerp = (a: P, b: P, u: number): P => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];

/** Parameter u where the bezier's time (x) reaches `x`; x(u) is monotonic for valid Spine curves. */
function solveU(x0: number, x1: number, x2: number, x3: number, x: number): number {
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const u = (lo + hi) / 2;
    const m = 1 - u;
    const xu = m * m * m * x0 + 3 * m * m * u * x1 + 3 * m * u * u * x2 + u * u * u * x3;
    if (xu < x) lo = u;
    else hi = u;
  }
  return (lo + hi) / 2;
}

export const keyTime = (k: Key) => k.time ?? 0;
export const keyValue = (k: Key, field: string, neutral: number) => (k[field] as number | undefined) ?? neutral;

/** Bezier handles of one channel of a key's curve: [cx1, cy1, cx2, cy2]. */
export function channelHandles(curve: Curve | undefined, channel: number): [number, number, number, number] | null {
  if (!Array.isArray(curve)) return null;
  const c = curve.slice(channel * 4, channel * 4 + 4);
  return c.length === 4 ? (c as [number, number, number, number]) : null;
}

/** Value of channel `channel` at `time`, following Spine's segment rules. */
export function valueAtCh(keys: Key[], ch: Channels, channel: number, time: number): number {
  if (!keys.length) return ch.get({})[channel]!;
  if (time <= keyTime(keys[0]!)) return ch.get(keys[0]!)[channel]!;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!, b = keys[i + 1]!;
    const ta = keyTime(a), tb = keyTime(b);
    if (time > tb) continue;
    const va = ch.get(a)[channel]!, vb = ch.get(b)[channel]!;
    if (a.curve === "stepped" || tb === ta) return time < tb ? va : vb;
    const h = channelHandles(a.curve, channel);
    if (!h) return va + (vb - va) * ((time - ta) / (tb - ta));
    const u = solveU(ta, h[0], h[2], tb, time);
    const m = 1 - u;
    return m * m * m * va + 3 * m * m * u * h[1] + 3 * m * u * u * h[3] + u * u * u * vb;
  }
  return ch.get(keys[keys.length - 1]!)[channel]!;
}

/** Field-based wrapper of {@link valueAtCh} (bone timelines). */
export function valueAt(keys: Key[], field: string, channel: number, neutral: number, time: number): number {
  // Only `channel` is read: its value comes from `field`, its handles from the curve's channel slot.
  const get = (k: Key) => {
    const v = new Array<number>(channel + 1).fill(0);
    v[channel] = keyValue(k, field, neutral);
    return v;
  };
  return valueAtCh(keys, { count: channel + 1, get, set: () => undefined }, channel, time);
}

/**
 * Inserts a key at `time` inside the segment that contains it without changing the motion: bezier channels are split
 * exactly (de Casteljau), linear stays linear, stepped stays stepped. Returns the index of the key at `time`.
 */
export function insertKeyCh(keys: Key[], ch: Channels, time: number): number {
  const eps = 1e-6;
  const existing = keys.findIndex((k) => Math.abs(keyTime(k) - time) < eps);
  if (existing >= 0) return existing;
  const idx = keys.findIndex((k) => keyTime(k) > time);
  if (idx === 0 || idx < 0) {
    // Before the first or after the last key the value holds: a constant (linear) key keeps it.
    const ref = idx === 0 ? keys[0]! : keys[keys.length - 1]!;
    const k: Key = { time };
    ch.set(k, ch.get(ref));
    if (idx < 0) {
      delete ref.curve; // the old last key's curve now spans a constant segment
      keys.push(k);
      return keys.length - 1;
    }
    keys.unshift(k);
    return 0;
  }
  const a = keys[idx - 1]!, b = keys[idx]!;
  const ta = keyTime(a), tb = keyTime(b);
  const va = ch.get(a), vb = ch.get(b);
  const k: Key = { time };
  if (a.curve === "stepped") {
    ch.set(k, va);
    k.curve = "stepped";
  } else if (!Array.isArray(a.curve)) {
    const u = (time - ta) / (tb - ta);
    ch.set(k, va.map((v, i) => v + (vb[i]! - v) * u));
  } else {
    const left: number[] = [], right: number[] = [], mid: number[] = [];
    for (let c = 0; c < ch.count; c++) {
      const h = channelHandles(a.curve, c)!;
      const p0: P = [ta, va[c]!], p1: P = [h[0], h[1]], p2: P = [h[2], h[3]], p3: P = [tb, vb[c]!];
      const u = solveU(p0[0], p1[0], p2[0], p3[0], time);
      const p01 = lerp(p0, p1, u), p12 = lerp(p1, p2, u), p23 = lerp(p2, p3, u);
      const p012 = lerp(p01, p12, u), p123 = lerp(p12, p23, u);
      mid.push(lerp(p012, p123, u)[1]);
      left.push(p01[0], p01[1], p012[0], p012[1]);
      right.push(p123[0], p123[1], p23[0], p23[1]);
    }
    ch.set(k, mid);
    a.curve = left;
    k.curve = right;
  }
  keys.splice(idx, 0, k);
  return idx;
}

/** Field-based wrapper of {@link insertKeyCh} (bone timelines). */
export function insertKey(keys: Key[], fields: string[], neutral: number, time: number): number {
  return insertKeyCh(keys, fieldChannels(fields, neutral), time);
}

/** Named easings as CSS cubic-bezier control points (x1, y1, x2, y2). */
export const EASINGS: Record<string, [number, number, number, number]> = {
  ease: [0.25, 0.1, 0.25, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
  easeInSine: [0.12, 0, 0.39, 0],
  easeOutSine: [0.61, 1, 0.88, 1],
  easeInOutSine: [0.37, 0, 0.63, 1],
  easeInCubic: [0.32, 0, 0.67, 0],
  easeOutCubic: [0.33, 1, 0.68, 1],
  easeInOutCubic: [0.65, 0, 0.35, 1],
  easeOutBack: [0.34, 1.56, 0.64, 1],
  easeInBack: [0.36, 0, 0.66, -0.56],
};

/** Spine curve for a segment from key a to key b using a CSS-style cubic bezier. */
export function easedCurveCh(a: Key, b: Key, ch: Channels, bez: [number, number, number, number]): number[] {
  const ta = keyTime(a), dt = keyTime(b) - ta;
  const va = ch.get(a), vb = ch.get(b);
  const out: number[] = [];
  for (let c = 0; c < ch.count; c++) {
    const dv = vb[c]! - va[c]!;
    out.push(ta + bez[0] * dt, va[c]! + bez[1] * dv, ta + bez[2] * dt, va[c]! + bez[3] * dv);
  }
  return out;
}

/** Field-based wrapper of {@link easedCurveCh}. */
export function easedCurve(a: Key, b: Key, fields: string[], neutral: number, bez: [number, number, number, number]): number[] {
  return easedCurveCh(a, b, fieldChannels(fields, neutral), bez);
}

export function parseEasing(name: string): [number, number, number, number] | "linear" | "stepped" {
  if (name === "linear" || name === "stepped") return name;
  const m = name.match(/^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/);
  if (m) {
    const v = m.slice(1).map(Number) as [number, number, number, number];
    if (v[0] < 0 || v[0] > 1 || v[2] < 0 || v[2] > 1) throw new Error("cubic-bezier x values must be within [0, 1]");
    return v;
  }
  const e = EASINGS[name];
  if (!e) throw new Error(`Unknown easing "${name}". Use linear, stepped, ${Object.keys(EASINGS).join(", ")} or cubic-bezier(x1,y1,x2,y2)`);
  return e;
}
