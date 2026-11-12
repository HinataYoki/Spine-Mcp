import { BONE_CHANNELS, fieldChannels, slotChannels, parseEasing, type Channels } from "./curves.js";
import { UserError } from "./project.js";
import type { AnimationJson, Key } from "./types.js";

// Merge and relative/absolute curve workflow adapted under MIT; see the
// animation-editing attribution in THIRD_PARTY_NOTICES.md.
export interface KeyframeEdit {
  op: "set" | "delete";
  path: string[];
  keys?: Key[];
  mode?: "upsert" | "append" | "replace";
  times?: number[];
  easing?: string | number[];
}
const time = (k: Key) => k.time ?? 0;
const stamp = (t: number) => Math.round(t * 1e6) / 1e6;
function checkedTime(n: unknown) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new UserError("Key times must be finite, non-negative seconds.");
  return stamp(n);
}
function validatePath(p: string[]) {
  if (p.some(s => ["__proto__", "prototype", "constructor"].includes(s))) throw new UserError("Unsafe timeline path.");
  const valid = (["bones", "slots", "path", "physics", "slider"].includes(p[0]!) && p.length === 3)
    || (["ik", "transform"].includes(p[0]!) && p.length === 2)
    || (["events", "drawOrder"].includes(p[0]!) && p.length === 1)
    || (p[0] === "attachments" && p.length === 5);
  if (!valid) throw new UserError("Use a timeline path such as ['bones','head','rotate'] or ['events'].");
}
function channels(p: string[]): Channels | null {
  const prop = p.at(-1)!;
  if (p[0] === "bones" && BONE_CHANNELS[prop]) {
    const c = BONE_CHANNELS[prop]!; return fieldChannels(c.fields, c.neutral);
  }
  if (p[0] === "slots") return slotChannels(prop);
  const fields = p[0] === "ik" ? ["mix", "softness"]
    : p[0] === "transform" ? ["mixRotate", "mixX", "mixY", "mixScaleX", "mixScaleY", "mixShearY"]
    : p[0] === "path" && prop === "mix" ? ["mixRotate", "mixX", "mixY"] : null;
  if (fields) return {
    count: fields.length,
    get: k => fields.map(f => (k[f] as number | undefined) ?? (f === "softness" ? 0 : f === "mixY" ? (k.mixX as number | undefined) ?? 1 : 1)),
    set: (k, v) => fields.forEach((f, i) => { k[f] = v[i]; }),
  };
  if ((p[0] === "path" && ["position", "spacing"].includes(prop)) || (p[0] === "physics" && prop !== "reset") || p[0] === "slider") {
    return fieldChannels(["value"], prop === "mix" ? 1 : 0);
  }
  return null;
}
type Relative = Map<Key, number[] | "stepped" | null>;
function relativize(keys: Key[], c: Channels | null): Relative {
  const curves: Relative = new Map();
  keys.forEach((k, i) => {
    if (!c || !Array.isArray(k.curve) || !keys[i + 1]) return;
    const next = keys[i + 1]!, dt = time(next) - time(k), a = c.get(k), b = c.get(next);
    if (dt <= 0 || k.curve.length !== c.count * 4) throw new UserError("Existing Bezier has invalid channels or key interval.");
    const absolute = k.curve;
    curves.set(k, absolute.map((v, j) => {
      const ch = Math.floor(j / 4), dv = b[ch]! - a[ch]!;
      return j % 2 === 0 ? (v - time(k)) / dt : Math.abs(dv) > 1e-6 ? (v - a[ch]!) / dv : (absolute[j - 1]! - time(k)) / dt;
    }));
  });
  return curves;
}
function easing(value: string | number[], c: Channels | null): number[] | "stepped" | null {
  const aliases: Record<string, string> = { "ease-in": "easeIn", "ease-out": "easeOut", "ease-in-out": "easeInOut", smooth: "cubic-bezier(0.25,0,0.75,1)" };
  const e = typeof value === "string" ? parseEasing(aliases[value] ?? value) : value;
  if (e === "linear") return null;
  if (e === "stepped") return e;
  if (!c) throw new UserError("Normalized Bezier is unsupported for this timeline; supply raw Spine keys instead.");
  if (![4, c.count * 4].includes(e.length) || e.some((v, i) => !Number.isFinite(v) || (i % 2 === 0 && (v < 0 || v > 1)))) throw new UserError("Normalized curves need 4 or 4 × channel-count values; time handles must be in [0,1].");
  return [...e];
}
function absolutize(keys: Key[], c: Channels | null, curves: Relative) {
  keys.forEach((k, i) => {
    if (!curves.has(k)) return;
    const curve = curves.get(k); delete k.curve;
    if (curve === "stepped") { k.curve = curve; return; }
    if (!curve || !c || !keys[i + 1]) return;
    const next = keys[i + 1]!, dt = time(next) - time(k), a = c.get(k), b = c.get(next);
    k.curve = Array.from({ length: c.count * 4 }, (_, j) => {
      const ch = Math.floor(j / 4), v = curve[curve.length === 4 ? j % 4 : j]!;
      return j % 2 === 0 ? time(k) + v * dt : a[ch]! + v * (b[ch]! - a[ch]!);
    });
  });
}

/** Clone first: failed edits never mutate the source. Empty edits duplicate it. */
export function editAnimation(source: AnimationJson, edits: KeyframeEdit[]): AnimationJson {
  const result = structuredClone(source);
  for (const edit of edits) {
    validatePath(edit.path);
    let node: Record<string, unknown> = result;
    const parents: { node: Record<string, unknown>; key: string }[] = [];
    for (const part of edit.path.slice(0, -1)) {
      if (!Object.hasOwn(node, part)) node[part] = {};
      const child = node[part];
      if (!child || typeof child !== "object" || Array.isArray(child)) throw new UserError("Timeline path crosses a non-object.");
      parents.push({ node, key: part }); node = child as Record<string, unknown>;
    }
    const prop = edit.path.at(-1)!;
    const existing = Object.hasOwn(node, prop) ? node[prop] : [];
    if (!Array.isArray(existing)) throw new UserError("Timeline path must address a key array.");
    let keys = existing as Key[];
    const c = channels(edit.path), curves = relativize(keys, c);
    if (edit.op === "delete") {
      if (!keys.length) throw new UserError("Timeline has no keys to delete.");
      const times = edit.times?.map(checkedTime);
      const kept = times ? keys.filter(k => !times.includes(stamp(time(k)))) : [];
      if (kept.length === keys.length) throw new UserError("No keys match the requested times.");
      keys = kept;
    } else {
      if (!edit.keys?.length) throw new UserError("set needs at least one key.");
      const incoming = structuredClone(edit.keys);
      for (const k of incoming) {
        k.time = checkedTime(k.time ?? 0);
        if (edit.easing !== undefined) {
          if (k.curve !== undefined) throw new UserError("Use either easing or raw key.curve, not both.");
          curves.set(k, easing(edit.easing, c));
        }
      }
      const identity = (k: Key) => `${stamp(time(k))}:${edit.path[0] === "events" ? String(k.name ?? "") : ""}`;
      const merged = new Map((edit.mode === "replace" ? [] : keys).map(k => [identity(k), k]));
      for (const k of incoming) {
        const id = identity(k);
        if (edit.mode === "append" && merged.has(id)) throw new UserError(`Key already exists at ${time(k)}; use upsert to overwrite.`);
        merged.set(id, k);
      }
      keys = [...merged.values()].sort((a, b) => time(a) - time(b));
    }
    absolutize(keys, c, curves);
    if (keys.length) node[prop] = keys;
    else {
      delete node[prop];
      for (const parent of parents.reverse()) {
        if (Object.keys(parent.node[parent.key] as object).length) break;
        delete parent.node[parent.key];
      }
    }
  }
  return result;
}
