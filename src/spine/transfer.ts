import { decodeDrawOrder, encodeDrawOrder, meshVertexCount } from "./mirror.js";
import { projectFps, tidyAnimation } from "./tidy.js";
import type { AnimationJson, Key, SkeletonJson, TimelineMap } from "./types.js";

const CONSTRAINT_SECTIONS = ["ik", "transform", "path", "physics", "slider"] as const;
type Section = (typeof CONSTRAINT_SECTIONS)[number];

export interface TransferMap {
  bones?: Record<string, string>;
  slots?: Record<string, string>;
  /** Constraint names (any type). */
  constraints?: Record<string, string>;
  events?: Record<string, string>;
  skins?: Record<string, string>;
  /** Attachment names, keyed "sourceSlot/attachment" or just "attachment". */
  attachments?: Record<string, string>;
}

export interface TransferOptions {
  /** Explicit renames, used before automatic matching. */
  map?: TransferMap;
  /** Match names that differ only in case and separators ("Upper_Arm" = "upper-arm"), when unambiguous (default true). */
  normalize?: boolean;
  /**
   * Adapt translation keys to the target's size: "skeleton" scales them by the ratio of the matched bones' total
   * length, "parent" by each bone's parent length ratio, or a number. Rotations, scales and deform stay as they are.
   */
  retarget?: { translate?: "none" | "skeleton" | "parent" | number };
}

export interface Unmatched {
  kind: string;
  name: string;
  keys: number;
}

export interface TransferReport {
  matched: { exact: number; mapped: number; normalized: number };
  /** Names matched by normalization: source -> target. */
  renamed: Record<string, string>;
  unmatched: Unmatched[];
  /** Keys that could not move (unknown attachments, events, deform on a different mesh). */
  dropped: string[];
  keysIn: number;
  keysOut: number;
  /** Translation scaling applied (absent when none). */
  retarget?: { mode: string; factor?: number; perBone?: Record<string, number> };
  /** Matched bones whose setup pose differs: the same keys move them differently. */
  setupDifferences: { bone: string; length?: [number, number]; rotation?: [number, number] }[];
  notes: string[];
}

const norm = (n: string) => n.toLowerCase().replace(/[\s_\-./]+/g, "");
const countKeys = (v: unknown): number => (Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.values(v).reduce((a: number, x) => a + countKeys(x), 0) : 0);

/** Name resolution within one name space: exact, explicit map, then a unique normalized match. */
class Resolver {
  private byNorm = new Map<string, string[]>();
  constructor(private targets: Set<string>, private map: Record<string, string> | undefined, private normalize: boolean, private report: TransferReport, private kind: string) {
    for (const t of targets) this.byNorm.set(norm(t), [...(this.byNorm.get(norm(t)) ?? []), t]);
  }
  private cache = new Map<string, string | null>();
  resolve(name: string): string | null {
    if (!this.cache.has(name)) this.cache.set(name, this.lookup(name));
    return this.cache.get(name)!;
  }
  private lookup(name: string): string | null {
    const mapped = this.map?.[name];
    if (mapped !== undefined) {
      if (this.targets.has(mapped)) { this.report.matched.mapped++; return mapped; }
      this.report.notes.push(`map: ${this.kind} "${mapped}" (for "${name}") does not exist in the target`);
      return null;
    }
    if (this.targets.has(name)) { this.report.matched.exact++; return name; }
    if (this.normalize) {
      const c = this.byNorm.get(norm(name));
      if (c?.length === 1) { this.report.matched.normalized++; this.report.renamed[`${this.kind} ${name}`] = c[0]!; return c[0]!; }
      if (c && c.length > 1) this.report.notes.push(`${this.kind} "${name}" matches several target names (${c.join(", ")}); pass map`);
    }
    return null;
  }
}

/**
 * Moves an animation from one skeleton to another by name: bones, slots, constraints, events, skins and attachments
 * are matched (exact, explicit map, then case/separator-insensitive), draw order is re-encoded for the target's slot
 * order, deform keys move only onto meshes with the same vertex count. Everything that cannot move is reported.
 * Keys keep their values (relative to each skeleton's setup pose), as Spine's own animation import does.
 */
export function transferAnimation(source: AnimationJson, from: SkeletonJson, to: SkeletonJson, o: TransferOptions = {}): { animation: AnimationJson; report: TransferReport } {
  const normalize = o.normalize ?? true;
  const report: TransferReport = { matched: { exact: 0, mapped: 0, normalized: 0 }, renamed: {}, unmatched: [], dropped: [], keysIn: countKeys(source), keysOut: 0, setupDifferences: [], notes: [] };
  const lose = (kind: string, name: string, v: unknown) => report.unmatched.push({ kind, name, keys: countKeys(v) });
  const bones = new Resolver(new Set(to.bones.map((b) => b.name)), o.map?.bones, normalize, report, "bone");
  const slots = new Resolver(new Set((to.slots ?? []).map((s) => s.name)), o.map?.slots, normalize, report, "slot");
  const constraints = Object.fromEntries(CONSTRAINT_SECTIONS.map((sec) => [sec, new Resolver(new Set((to.constraints ?? []).filter((c) => c.type === sec).map((c) => c.name)), o.map?.constraints, normalize, report, `${sec} constraint`)])) as Record<Section, Resolver>;
  const events = new Resolver(new Set(Object.keys(to.events ?? {})), o.map?.events, normalize, report, "event");
  const skins = new Resolver(new Set((to.skins ?? []).map((s) => s.name)), o.map?.skins, normalize, report, "skin");
  const attachmentsOf = (slot: string, skin?: string) => new Set((to.skins ?? []).filter((s) => !skin || s.name === skin).flatMap((s) => Object.keys(s.attachments?.[slot] ?? {})));
  const attResolvers = new Map<string, Resolver>();
  const attachment = (srcSlot: string, dstSlot: string, name: string, skin?: string): string | null => {
    const key = `${srcSlot}|${dstSlot}|${skin ?? ""}`;
    if (!attResolvers.has(key)) {
      // Explicit renames: "sourceSlot/attachment" first, then "attachment".
      const explicit = Object.fromEntries(Object.entries(o.map?.attachments ?? {}).flatMap(([k, v]) => (k.startsWith(`${srcSlot}/`) ? [[k.slice(srcSlot.length + 1), v]] : k.includes("/") ? [] : [[k, v]])));
      attResolvers.set(key, new Resolver(attachmentsOf(dstSlot, skin), explicit, normalize, report, `attachment in ${dstSlot}`));
    }
    return attResolvers.get(key)!.resolve(name);
  };

  const out: AnimationJson = {};
  // Bones.
  for (const [name, tl] of Object.entries(source.bones ?? {})) {
    const t = bones.resolve(name);
    if (!t) { lose("bone", name, tl); continue; }
    (out.bones ??= {})[t] = structuredClone(tl);
    const a = from.bones.find((b) => b.name === name)!, b = to.bones.find((x) => x.name === t)!;
    const len: [number, number] = [a?.length ?? 0, b.length ?? 0], rot: [number, number] = [a?.rotation ?? 0, b.rotation ?? 0];
    const d: TransferReport["setupDifferences"][number] = { bone: t };
    if (Math.abs(len[0] - len[1]) > Math.max(1, 0.1 * Math.max(len[0], len[1]))) d.length = len;
    if (Math.abs(rot[0] - rot[1]) > 1) d.rotation = rot;
    if (d.length || d.rotation) report.setupDifferences.push(d);
  }
  // Slots (attachment keys renamed to the target slot's attachments).
  for (const [name, tl] of Object.entries(source.slots ?? {})) {
    const t = slots.resolve(name);
    if (!t) { lose("slot", name, tl); continue; }
    const copy: TimelineMap = structuredClone(tl);
    if (copy.attachment) {
      copy.attachment = copy.attachment.filter((k: Key) => {
        if (!k.name) return true;
        const a = attachment(name, t, k.name as string);
        if (!a) { report.dropped.push(`attachment key "${k.name}" in slot ${t} (no such attachment)`); return false; }
        k.name = a;
        return true;
      });
      if (!copy.attachment.length) delete copy.attachment;
    }
    if (Object.keys(copy).length) (out.slots ??= {})[t] = copy;
  }
  // Constraints.
  for (const sec of CONSTRAINT_SECTIONS) {
    for (const [name, tl] of Object.entries((source[sec] as Record<string, unknown> | undefined) ?? {})) {
      const t = name === "" && sec === "physics" ? "" : constraints[sec].resolve(name);
      if (t === null) { lose(`${sec} constraint`, name, tl); continue; }
      ((out as Record<string, Record<string, unknown>>)[sec] ??= {})[t] = structuredClone(tl);
    }
  }
  // Deform / sequence timelines: skin, slot and attachment matched; deform needs the same vertex count.
  for (const [skin, bySlot] of Object.entries(source.attachments ?? {})) {
    const ts = skins.resolve(skin);
    if (!ts) { lose("skin", skin, bySlot); continue; }
    for (const [slot, atts] of Object.entries(bySlot)) {
      const tslot = slots.resolve(slot);
      if (!tslot) { lose("slot", slot, atts); continue; }
      for (const [att, tl] of Object.entries(atts)) {
        const tatt = attachment(slot, tslot, att, ts);
        if (!tatt) { report.dropped.push(`deform/sequence of "${att}" (no attachment in ${ts}/${tslot})`); continue; }
        if (tl.deform && meshVertexCount(from, skin, slot, att) !== meshVertexCount(to, ts, tslot, tatt)) {
          report.dropped.push(`deform of "${att}" → "${tatt}": different mesh (${meshVertexCount(from, skin, slot, att)} vs ${meshVertexCount(to, ts, tslot, tatt)} vertices)`);
          const { deform: _d, ...rest } = tl;
          if (!Object.keys(rest).length) continue;
          (((out.attachments ??= {})[ts] ??= {})[tslot] ??= {})[tatt] = structuredClone(rest);
          continue;
        }
        (((out.attachments ??= {})[ts] ??= {})[tslot] ??= {})[tatt] = structuredClone(tl);
      }
    }
  }
  // Events: only events the target defines.
  if (source.events?.length) {
    const kept = source.events.flatMap((k) => {
      const t = events.resolve(k.name as string);
      if (!t) { report.dropped.push(`event "${k.name}" at ${k.time ?? 0}s (not defined in the target)`); return []; }
      return [{ ...k, name: t }];
    });
    if (kept.length) out.events = kept;
  }
  // Draw order: decode in the source's slot order, rename, encode in the target's.
  if (source.drawOrder?.length) {
    const srcBase = (from.slots ?? []).map((s) => s.name), dstBase = (to.slots ?? []).map((s) => s.name);
    const keys: Key[] = [];
    for (const k of source.drawOrder) {
      const offsets = k.offsets as { slot: string; offset: number }[] | undefined;
      if (!offsets) { keys.push({ ...k }); continue; }
      const order = decodeDrawOrder(srcBase, offsets);
      if (!order) { report.dropped.push(`draw order key at ${k.time ?? 0}s (could not decode)`); continue; }
      // Target slots in the source's relative order; target slots the source lacks keep their setup position.
      const moved = order.map((n) => slots.resolve(n)).filter((n): n is string => !!n && dstBase.includes(n));
      const movedSet = new Set(moved);
      const result: string[] = [];
      let m = 0;
      for (const n of dstBase) result.push(movedSet.has(n) ? moved[m++]! : n);
      keys.push({ ...k, offsets: encodeDrawOrder(dstBase, result) });
    }
    if (keys.length) out.drawOrder = keys;
  }
  if (source.drawOrderFolder?.length) report.dropped.push(`${source.drawOrderFolder.length} draw order folder timeline(s) (folders are per skeleton)`);

  // Retarget: scale translation keys (and their curve value handles) to the target's proportions.
  const mode = o.retarget?.translate ?? "none";
  if (mode !== "none" && out.bones) {
    const lengthOf = (doc: SkeletonJson, n: string) => doc.bones.find((b) => b.name === n)?.length ?? 0;
    const pairs = Object.keys(source.bones ?? {}).map((n) => [n, bones.resolve(n)] as const).filter((p): p is readonly [string, string] => !!p[1]);
    const allPairs = from.bones.map((b) => [b.name, bones.resolve(b.name)] as const).filter((p): p is readonly [string, string] => !!p[1]);
    let srcLen = 0, dstLen = 0;
    for (const [a, b] of allPairs) { const la = lengthOf(from, a), lb = lengthOf(to, b); if (la > 0 && lb > 0) { srcLen += la; dstLen += lb; } }
    const global = typeof mode === "number" ? mode : srcLen > 0 ? dstLen / srcLen : 1;
    const perBone: Record<string, number> = {};
    for (const [srcName, dstName] of pairs) {
      let f = global;
      if (mode === "parent") {
        const sp = from.bones.find((b) => b.name === srcName)?.parent, dp = to.bones.find((b) => b.name === dstName)?.parent;
        const ls = sp ? lengthOf(from, sp) : 0, ld = dp ? lengthOf(to, dp) : 0;
        if (ls > 0 && ld > 0) f = ld / ls;
      }
      const tl = out.bones[dstName];
      if (!tl || Math.abs(f - 1) < 1e-9) continue;
      for (const prop of ["translate", "translatex", "translatey"]) {
        for (const k of tl[prop] ?? []) {
          for (const fld of ["x", "y", "value"]) if (typeof k[fld] === "number") k[fld] = (k[fld] as number) * f;
          if (Array.isArray(k.curve)) k.curve = k.curve.map((c, i) => (i % 2 === 1 ? c * f : c));
        }
      }
      if (tl.translate || tl.translatex || tl.translatey) perBone[dstName] = +f.toFixed(4);
    }
    const scaled = new Set(Object.keys(perBone));
    out.bones = tidyAnimation({ bones: out.bones }, projectFps(to), { times: false, only: (kind, owner) => kind.startsWith("bone.translate") && scaled.has(owner) }).animation.bones;
    report.retarget = mode === "parent" ? { mode, perBone } : { mode: typeof mode === "number" ? "factor" : mode, factor: +global.toFixed(4) };
    if (srcLen === 0 && typeof mode !== "number") report.notes.push("retarget: no matched bones with a length on both sides; translation kept (factor 1)");
  }
  report.keysOut = countKeys(out);
  // Resolver counts include repeated lookups (attachments, deform slots); keep the headline to distinct names.
  report.unmatched = Object.values(Object.fromEntries(report.unmatched.map((u) => [`${u.kind}:${u.name}`, u])));
  if (report.setupDifferences.length) report.notes.push(`${report.setupDifferences.length} matched bone(s) have a different setup pose: keys are relative to each skeleton's setup, so they move differently; compare renders`);
  return { animation: out, report };
}
