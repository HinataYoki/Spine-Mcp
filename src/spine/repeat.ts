import { BONE_CHANNELS, type Channels, fieldChannels, insertKeyCh, keyTime, slotChannels } from "./curves.js";
import { attachmentKind, deformKind, numericKind, shiftKeys, type TimelineKind } from "./derive.js";
import type { AnimationJson, Key, SkeletonJson, TimelineMap } from "./types.js";

const stripTime = ({ time: _t, curve: _c, ...rest }: Key) => JSON.stringify(rest);

/** Stepped values (draw order, inherit, sequence): a key copies the one active at that time. */
const steppedKind: TimelineKind = {
  insert: (keys, t) => {
    const existing = keys.findIndex((k) => Math.abs(keyTime(k) - t) < 1e-6);
    if (existing >= 0) return existing;
    const idx = keys.findIndex((k) => keyTime(k) > t);
    const ref = idx === 0 ? keys[0]! : idx < 0 ? keys[keys.length - 1]! : keys[idx - 1]!;
    const { curve: _c, ...copy } = ref;
    const k: Key = { ...copy, time: t };
    if (idx < 0) { keys.push(k); return keys.length - 1; }
    keys.splice(idx, 0, k);
    return idx;
  },
  same: (a, b) => stripTime(a) === stripTime(b),
};

/** Numeric channels with per-field defaults (and fallbacks such as mixY = mixX), plus discrete fields carried along. */
function constraintKind(fields: string[], defaults: Record<string, number | string>, discrete: string[] = []): TimelineKind {
  const value = (k: Key, f: string): number => {
    const v = k[f] ?? (typeof defaults[f] === "string" ? k[defaults[f] as string] ?? 1 : defaults[f]);
    return v as number;
  };
  const ch: Channels = {
    count: fields.length,
    get: (k) => fields.map((f) => value(k, f)),
    set: (k, v) => fields.forEach((f, i) => (k[f] = v[i])),
  };
  const base = numericKind(ch);
  return {
    insert: (keys, t) => {
      const i = insertKeyCh(keys, ch, t);
      const ref = keys[i > 0 ? i - 1 : Math.min(1, keys.length - 1)]!;
      for (const f of discrete) if (ref[f] !== undefined && keys[i]![f] === undefined) keys[i]![f] = ref[f];
      return i;
    },
    same: (a, b) => base.same(a, b) && discrete.every((f) => (a[f] ?? null) === (b[f] ?? null)),
  };
}

// Built on first use: derive.ts and this module import each other.
const IK = () => constraintKind(["mix", "softness"], { mix: 1, softness: 0 }, ["bendPositive", "compress", "stretch"]);
const TRANSFORM = () => constraintKind(["mixRotate", "mixX", "mixY", "mixScaleX", "mixScaleY", "mixShearY"], { mixRotate: 1, mixX: 1, mixY: "mixX", mixScaleX: 1, mixScaleY: "mixScaleX", mixShearY: 1 });
const PATH_MIX = () => constraintKind(["mixRotate", "mixX", "mixY"], { mixRotate: 1, mixX: 1, mixY: "mixX" });
const value = (neutral: number) => numericKind(fieldChannels(["value"], neutral));

/** Keys with only a time (events, physics reset): every cycle keeps all of them (a looping playback fires each one). */
function repeatInstants(keys: Key[], d: number, times: number): Key[] {
  const out: Key[] = [];
  for (let r = 0; r < times; r++) for (const k of keys) out.push({ ...k, time: keyTime(k) + r * d });
  return out;
}

/** Repeats one timeline `times` times over [0, d): equal values join, a jump at a seam becomes a 1 ms hold. */
export function repeatKeys(keys: Key[], kind: TimelineKind, d: number, times: number, setup?: Key): Key[] {
  if (!keys.length) return [];
  const work = structuredClone(keys).filter((k) => keyTime(k) <= d + 1e-9);
  // Before its first key a timeline applies the setup pose, then jumps to the key: a stepped setup key at 0.
  if (setup && keyTime(work[0]!) > 1e-9) work.unshift({ ...setup, time: 0, curve: "stepped" });
  kind.insert(work, 0);
  kind.insert(work, d);
  let out = shiftKeys(work, 0);
  for (let r = 1; r < times; r++) {
    const seg = shiftKeys(work, r * d);
    const last = out[out.length - 1]!, first = seg[0]!;
    if (kind.same(last, first)) {
      out.pop();
    } else {
      // Hold the previous cycle's end value until the seam, then jump (like a looping playback does).
      const eps = 0.001;
      const j = kind.insert(out, r * d - eps);
      out = out.slice(0, j + 1);
      out[j]!.curve = "stepped";
    }
    out = out.concat(seg);
  }
  return out;
}

/**
 * The animation played `times` times in a row as one animation (same motion as looping it), every timeline type:
 * bones, slots (colors, attachments), deform and sequence, constraints, draw order, events.
 */
export function repeatAnimation(source: AnimationJson, duration: number, times: number, skeleton?: SkeletonJson): AnimationJson {
  if (!(times >= 2) || !Number.isInteger(times)) throw new Error("repeat.times must be an integer >= 2");
  if (!(duration > 0)) throw new Error("repeat needs an animation longer than 0 s");
  const d = duration;
  const out: AnimationJson = {};
  const rep = (keys: Key[] | undefined, kind: TimelineKind, setup?: Key) => (keys?.length ? repeatKeys(keys, kind, d, times, setup) : keys);
  const boneData = (n: string) => skeleton?.bones.find((b) => b.name === n);
  const constraint = (type: string, n: string) => (skeleton?.constraints ?? []).find((c) => c.type === type && c.name === n) as Record<string, unknown> | undefined;
  const num = (v: unknown, dflt: number) => (typeof v === "number" ? v : dflt);

  for (const [bone, tls] of Object.entries(source.bones ?? {})) {
    const o: TimelineMap = {};
    for (const [prop, keys] of Object.entries(tls)) {
      const spec = BONE_CHANNELS[prop];
      const setup: Key | undefined = spec ? Object.fromEntries(spec.fields.map((f) => [f, spec.neutral])) : prop === "inherit" ? { inherit: (boneData(bone)?.inherit as string | undefined) ?? "normal" } : undefined;
      o[prop] = rep(keys, spec ? numericKind(fieldChannels(spec.fields, spec.neutral)) : steppedKind, setup)!;
    }
    (out.bones ??= {})[bone] = o;
  }
  for (const [slot, tls] of Object.entries(source.slots ?? {})) {
    const setup = skeleton?.slots?.find((s) => s.name === slot);
    const o: TimelineMap = {};
    for (const [prop, keys] of Object.entries(tls)) {
      const ch = slotChannels(prop);
      const color = (setup?.color as string | undefined) ?? "ffffffff", dark = (setup?.dark as string | undefined) ?? "000000";
      const setupKey: Key | undefined = !skeleton ? undefined
        : prop === "attachment" ? { name: setup?.attachment ?? null }
        : prop === "rgba" ? { color } : prop === "rgb" ? { color: color.slice(0, 6) } : prop === "alpha" ? { value: parseInt(color.slice(6, 8) || "ff", 16) / 255 }
        : prop === "rgba2" ? { light: color, dark } : prop === "rgb2" ? { light: color.slice(0, 6), dark } : undefined;
      o[prop] = rep(keys, prop === "attachment" ? attachmentKind(skeleton ? (setup?.attachment ?? null) : undefined) : ch ? numericKind(ch) : steppedKind, setupKey)!;
    }
    (out.slots ??= {})[slot] = o;
  }
  for (const [skin, bySlot] of Object.entries(source.attachments ?? {})) {
    for (const [slot, atts] of Object.entries(bySlot)) {
      for (const [att, tls] of Object.entries(atts)) {
        const o: TimelineMap = {};
        for (const [prop, keys] of Object.entries(tls)) o[prop] = rep(keys, prop === "deform" ? deformKind : steppedKind, prop === "deform" ? {} : undefined)!;
        ((out.attachments ??= {})[skin] ??= {})[slot] ??= {};
        out.attachments[skin]![slot]![att] = o;
      }
    }
  }
  for (const [name, keys] of Object.entries(source.ik ?? {})) {
    const c = constraint("ik", name);
    (out.ik ??= {})[name] = rep(keys, IK(), c && { mix: num(c.mix, 1), softness: num(c.softness, 0), bendPositive: c.bendPositive ?? true, compress: c.compress ?? false, stretch: c.stretch ?? false })!;
  }
  for (const [name, keys] of Object.entries(source.transform ?? {})) {
    const c = constraint("transform", name);
    const setup = c && { mixRotate: num(c.mixRotate, 1), mixX: num(c.mixX, 1), mixY: num(c.mixY, num(c.mixX, 1)), mixScaleX: num(c.mixScaleX, 1), mixScaleY: num(c.mixScaleY, num(c.mixScaleX, 1)), mixShearY: num(c.mixShearY, 1) };
    (out.transform ??= {})[name] = rep(keys, TRANSFORM(), setup)!;
  }
  for (const [name, tls] of Object.entries(source.path ?? {})) {
    const o: TimelineMap = {};
    const c = constraint("path", name);
    for (const [prop, keys] of Object.entries(tls)) {
      const setup = !c ? undefined : prop === "mix" ? { mixRotate: num(c.mixRotate, 1), mixX: num(c.mixX, 1), mixY: num(c.mixY, num(c.mixX, 1)) } : { value: num(c[prop], 0) };
      o[prop] = rep(keys, prop === "mix" ? PATH_MIX() : value(0), setup)!;
    }
    (out.path ??= {})[name] = o;
  }
  for (const section of ["physics", "slider"] as const) {
    for (const [name, tls] of Object.entries(source[section] ?? {})) {
      if (Array.isArray(tls)) { ((out[section] ??= {}) as Record<string, unknown>)[name] = rep(tls, value(1)); continue; }
      const o: TimelineMap = {};
      const c = constraint(section, name);
      const PHYSICS_DEFAULTS: Record<string, number> = { inertia: 0.5, strength: 100, damping: 0.85, mass: 1, wind: 0, gravity: 0, mix: 1 };
      for (const [prop, keys] of Object.entries(tls)) {
        const setup = c && prop in PHYSICS_DEFAULTS ? { value: num(c[prop], PHYSICS_DEFAULTS[prop]!) } : undefined;
        o[prop] = prop === "reset" ? repeatInstants(keys, d, times) : rep(keys, value(prop === "mix" ? 1 : 0), section === "physics" ? setup : undefined)!;
      }
      ((out[section] ??= {}) as Record<string, unknown>)[name] = o;
    }
  }
  if (source.drawOrder?.length) out.drawOrder = rep(source.drawOrder, steppedKind, {});
  if (source.drawOrderFolder?.length) out.drawOrderFolder = source.drawOrderFolder.map((f) => ({ ...f, keys: rep(f.keys, steppedKind, {}) }));
  if (source.events?.length) out.events = repeatInstants(source.events, d, times);
  return out;
}
