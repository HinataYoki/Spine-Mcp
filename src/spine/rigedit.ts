// Rig edits into a NEW project: Spine only takes bones, constraints, events and skins in through a full JSON import,
// which drops editor-only data, so the original is never touched and what the round trip lost is reported.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PNG } from "pngjs";
import type { Config } from "../config.js";
import { buildRig } from "./autorig.js";
import { cliFailed, type SpineCli } from "./cli.js";
import { compareAnimationAcrossDocs } from "./compare.js";
import { assertInputPath, loadProject, pickSkeleton, UserError } from "./project.js";
import { loadSkeletonData, spine } from "./runtime.js";
import type { SkeletonJson } from "./types.js";
import { folderImages } from "./gaps.js";
import { prepareForImport, sortAttachmentWeights } from "./intake.js";
import { validateSkeleton } from "./validate.js";
import { removeQuiet } from "../platform.js";

export type RigEdit =
  | { op: "addBone"; name: string; parent: string; x?: number; y?: number; rotation?: number; length?: number; scaleX?: number; scaleY?: number }
  /** Setup pose of an existing bone (animations are relative to it, so they change with it). */
  | { op: "setBone"; name: string; x?: number; y?: number; rotation?: number; length?: number; scaleX?: number; scaleY?: number; shearX?: number; shearY?: number }
  | { op: "addIk"; name: string; bones: string[]; target: string; bendPositive?: boolean; mix?: number; softness?: number; compress?: boolean; stretch?: boolean }
  | { op: "addPhysics"; name: string; bone: string; x?: number; y?: number; rotate?: number; scaleX?: number; shearX?: number; inertia?: number; strength?: number; damping?: number; mass?: number; wind?: number; gravity?: number; mix?: number }
  | { op: "addEvent"; name: string; int?: number; float?: number; string?: string; audio?: string; volume?: number; balance?: number }
  /** A new skin, empty or a copy of an existing one. */
  | { op: "addSkin"; name: string; from?: string }
  | { op: "removeConstraint"; name: string }
  /** A region traced into a mesh in place: same image, same place and size at setup, same bone. */
  | { op: "meshRegion"; slot: string; attachment?: string }
  /** A mesh copied from another skeleton whose bones it uses have the same setup pose here. */
  | { op: "copyMesh"; from: string; slot: string; attachment?: string };

export interface RigEditContext {
  image?: (path: string) => { width: number; height: number; data: Uint8ClampedArray } | null;
  source?: (path: string) => SkeletonJson | undefined;
}

type Att = Record<string, unknown> & { type?: string; path?: string; vertices?: number[]; uvs?: number[]; width?: number; height?: number };

function worldPose(doc: SkeletonJson): Map<string, { x: number; y: number; a: number; b: number; c: number; d: number }> {
  const sk = new spine.Skeleton(loadSkeletonData(structuredClone(doc)));
  sk.setupPose();
  sk.updateWorldTransform(spine.Physics.none);
  return new Map(sk.bones.map((b) => { const p = b.appliedPose; return [b.data.name, { x: p.worldX, y: p.worldY, a: p.a, b: p.b, c: p.c, d: p.d }]; }));
}

function shownAttachment(doc: SkeletonJson, slot: string, name?: string): { skin: Record<string, Att>; name: string; att: Att } {
  const slotDef = (doc.slots ?? []).find((s) => s.name === slot);
  if (!slotDef) throw new UserError(`Slot "${slot}" not found`);
  const skin = (doc.skins ?? []).find((s) => s.name === "default")?.attachments?.[slot] as Record<string, Att> | undefined;
  const n = name ?? (slotDef.attachment as string | undefined);
  if (!skin || !n || !skin[n]) throw new UserError(`Slot "${slot}" has no attachment "${n ?? "(none shown)"}" in the default skin`);
  return { skin, name: n, att: skin[n]! };
}

export interface RigEditOptions {
  project: string;
  /** The new .spine (never the original, never an existing file). */
  output: string;
  edits: RigEdit[];
  apply?: boolean;
}

export interface RigEditResult {
  mode: "dry-run" | "created";
  project: string;
  output: string;
  applied: string[];
  /** What the JSON round trip changed besides the edits (found by exporting both projects and comparing). */
  lost?: string[];
  sizes?: { original: number; created: number };
  validateErrors: string[];
  notes: string[];
}

export function shiftWeightedBoneIndices(doc: SkeletonJson, from: number): number {
  let shifted = 0;
  for (const skin of doc.skins ?? []) {
    for (const slot of Object.values(skin.attachments ?? {})) {
      for (const att of Object.values(slot)) {
        const v = att.vertices;
        if (!v) continue;
        const count = att.type === "mesh" ? (att.uvs?.length ?? 0) / 2 : (att.vertexCount ?? 0);
        if (!count || v.length <= count * 2) continue;
        for (let i = 0, n = 0; i < v.length && n < count; n++) {
          const bones = v[i++]!;
          for (let k = 0; k < bones; k++, i += 4) {
            if (v[i]! >= from) { v[i] = v[i]! + 1; shifted++; }
          }
        }
      }
    }
  }
  return shifted;
}

/** Applies the edits to a copy of the skeleton JSON; throws on names that clash or do not exist. */
export function applyRigEdits(doc: SkeletonJson, edits: RigEdit[], ctx: RigEditContext = {}): { doc: SkeletonJson; applied: string[]; touched: Set<string> } {
  const out = structuredClone(doc);
  const applied: string[] = [];
  const touched = new Set<string>();
  const bone = (n: string) => out.bones.find((b) => b.name === n);
  const constraints = (out.constraints ??= []);
  const constraintNames = () => new Set(constraints.map((c) => c.name));
  for (const e of edits) {
    switch (e.op) {
      case "addBone": {
        if (bone(e.name)) throw new UserError(`Bone "${e.name}" already exists`);
        if (!bone(e.parent)) throw new UserError(`addBone ${e.name}: parent "${e.parent}" not found`);
        // Bones are stored parents first: insert after the parent's last descendant.
        const { op: _op, ...b } = e;
        const idx = out.bones.findIndex((x) => x.name === e.parent);
        let at = idx + 1;
        const under = new Set([e.parent]);
        while (at < out.bones.length && under.has(out.bones[at]!.parent ?? "")) { under.add(out.bones[at]!.name); at++; }
        out.bones.splice(at, 0, b);
        shiftWeightedBoneIndices(out, at);
        touched.add(`bone ${e.name}`);
        applied.push(`bone ${e.name} under ${e.parent}`);
        break;
      }
      case "setBone": {
        const b = bone(e.name);
        if (!b) throw new UserError(`setBone: bone "${e.name}" not found`);
        const { op: _op, name: _n, ...fields } = e;
        Object.assign(b, fields);
        applied.push(`bone ${e.name} setup ${Object.keys(fields).join(", ")}`);
        break;
      }
      case "addIk": {
        if (constraintNames().has(e.name)) throw new UserError(`Constraint "${e.name}" already exists`);
        if (e.bones.length < 1 || e.bones.length > 2) throw new UserError("addIk: one or two bones");
        for (const n of [...e.bones, e.target]) if (!bone(n)) throw new UserError(`addIk ${e.name}: bone "${n}" not found`);
        if (e.bones.length === 2 && bone(e.bones[1]!)!.parent !== e.bones[0]) throw new UserError(`addIk ${e.name}: "${e.bones[1]}" must be a child of "${e.bones[0]}"`);
        const { op: _op, ...c } = e;
        constraints.push({ type: "ik", ...c } as never);
        touched.add(`constraint ${e.name}`);
        applied.push(`IK ${e.name} (${e.bones.join(" > ")} -> ${e.target})`);
        break;
      }
      case "addPhysics": {
        if (constraintNames().has(e.name)) throw new UserError(`Constraint "${e.name}" already exists`);
        if (!bone(e.bone)) throw new UserError(`addPhysics ${e.name}: bone "${e.bone}" not found`);
        const { op: _op, ...c } = e;
        constraints.push({ type: "physics", ...c } as never);
        touched.add(`constraint ${e.name}`);
        applied.push(`physics ${e.name} on ${e.bone}`);
        break;
      }
      case "addEvent": {
        out.events ??= {};
        if (out.events[e.name]) throw new UserError(`Event "${e.name}" already exists`);
        const { op: _op, name: _n, ...ev } = e;
        out.events[e.name] = ev;
        touched.add(`event ${e.name}`);
        applied.push(`event ${e.name}${e.audio ? ` (audio ${e.audio})` : ""}`);
        break;
      }
      case "addSkin": {
        out.skins ??= [];
        if (out.skins.some((s) => s.name === e.name)) throw new UserError(`Skin "${e.name}" already exists`);
        const src = e.from ? out.skins.find((s) => s.name === e.from) : undefined;
        if (e.from && !src) throw new UserError(`addSkin ${e.name}: skin "${e.from}" not found`);
        // Spine refuses a skin placeholder named like an attachment the default skin already has in that slot.
        if (e.from === "default") throw new UserError(`addSkin ${e.name}: the default skin cannot be copied (Spine rejects skin attachments named like default-skin attachments in the same slot). Copy another skin, or start empty and add attachments in Spine.`);
        out.skins.push(src ? { ...structuredClone(src), name: e.name } : { name: e.name, attachments: {} });
        touched.add(`skin ${e.name}`);
        applied.push(`skin ${e.name}${e.from ? ` (copy of ${e.from})` : ""}`);
        break;
      }
      case "removeConstraint": {
        const i = constraints.findIndex((c) => c.name === e.name);
        if (i < 0) throw new UserError(`Constraint "${e.name}" not found`);
        constraints.splice(i, 1);
        // Keys for it in animations go too (Spine would drop them with a warning).
        for (const a of Object.values(out.animations ?? {})) for (const k of ["ik", "transform", "path", "physics"] as const) if ((a[k] as Record<string, unknown> | undefined)?.[e.name]) delete (a[k] as Record<string, unknown>)[e.name];
        applied.push(`removed constraint ${e.name}`);
        break;
      }
      case "meshRegion": {
        const { skin, name, att } = shownAttachment(out, e.slot, e.attachment);
        if (att.type && att.type !== "region") throw new UserError(`meshRegion ${e.slot}/${name}: a ${att.type}, not a region`);
        const path = (att.path as string | undefined) ?? (att.name as string | undefined) ?? name, img = ctx.image?.(path);
        if (!img) throw new UserError(`meshRegion ${e.slot}/${name}: image ${path}.png not found next to the project`);
        const traced = buildRig([{ name: "m", path: "m", left: 0, top: 0, width: img.width, height: img.height, data: img.data, opacity: 1 }], { bones: [{ name: "m", joint: [0, 0], layers: ["m"] }], mesh: "sparse", weights: "rigid", scale: 1 });
        const m = (traced.doc.skins![0]!.attachments as Record<string, Record<string, Att>>).m!.m!;
        if (m.type !== "mesh") throw new UserError(`meshRegion ${e.slot}/${name}: the image's outline could not be traced`);
        const w = (att.width as number | undefined) ?? img.width, h = (att.height as number | undefined) ?? img.height;
        const sx = (att.scaleX as number | undefined) ?? 1, sy = (att.scaleY as number | undefined) ?? 1, r = (((att.rotation as number | undefined) ?? 0) * Math.PI) / 180;
        const ax = (att.x as number | undefined) ?? 0, ay = (att.y as number | undefined) ?? 0, uvs = m.uvs!, vertices: number[] = [];
        for (let i = 0; i < uvs.length; i += 2) {
          const px = (uvs[i]! - 0.5) * w * sx, py = (0.5 - uvs[i + 1]!) * h * sy;
          vertices.push(+(ax + Math.cos(r) * px - Math.sin(r) * py).toFixed(3), +(ay + Math.sin(r) * px + Math.cos(r) * py).toFixed(3));
        }
        skin[name] = { type: "mesh", ...(att.name ? { name: att.name } : {}), ...(att.path ? { path: att.path } : {}), ...(att.color ? { color: att.color } : {}), uvs, triangles: m.triangles, vertices, hull: m.hull, edges: m.edges, width: w, height: h };
        touched.add(`attachment ${e.slot}/${name}`);
        applied.push(`region ${e.slot}/${name} traced into a mesh (${uvs.length / 2} vertices)`);
        break;
      }
      case "copyMesh": {
        const src = ctx.source?.(e.from);
        if (!src) throw new UserError(`copyMesh ${e.slot}: ${e.from} not loaded`);
        const from = shownAttachment(src, e.slot, e.attachment);
        if (from.att.type !== "mesh") throw new UserError(`copyMesh ${e.slot}/${from.name}: a ${from.att.type ?? "region"} in ${basename(e.from)}, not a mesh`);
        const dstSlot = (out.slots ?? []).find((s) => s.name === e.slot);
        if (!dstSlot) throw new UserError(`copyMesh: slot "${e.slot}" not found in the project`);
        const srcSlot = (src.slots ?? []).find((s) => s.name === e.slot)!;
        const v = from.att.vertices!, n = from.att.uvs!.length / 2, weighted = v.length > n * 2;
        const srcNames = src.bones.map((b) => b.name), dstNames = out.bones.map((b) => b.name), used = new Set<string>();
        if (weighted) for (let i = 0, k = 0; k < n; k++) { const c = v[i++]!; for (let j = 0; j < c; j++, i += 4) used.add(srcNames[v[i]!]!); }
        else {
          if (srcSlot.bone !== dstSlot.bone) throw new UserError(`copyMesh ${e.slot}: the mesh is on bone "${srcSlot.bone}" there and the slot is on "${dstSlot.bone}" here`);
          used.add(srcSlot.bone);
        }
        const missing = [...used].filter((b) => !dstNames.includes(b));
        if (missing.length) throw new UserError(`copyMesh ${e.slot}: bones not in the project: ${missing.join(", ")} (add them first with addBone)`);
        const a = worldPose(src), b = worldPose(out);
        const off = [...used].filter((name) => { const p = a.get(name)!, q = b.get(name)!; return Math.hypot(p.x - q.x, p.y - q.y) > 0.05 || Math.abs(p.a - q.a) + Math.abs(p.b - q.b) + Math.abs(p.c - q.c) + Math.abs(p.d - q.d) > 1e-3; });
        if (off.length) throw new UserError(`copyMesh ${e.slot}: bones set up differently here, so the mesh would move: ${off.join(", ")} (match their setup pose first)`);
        const copy = structuredClone(from.att);
        if (weighted) { const cv = copy.vertices!; for (let i = 0, k = 0; k < n; k++) { const c = cv[i++]!; for (let j = 0; j < c; j++, i += 4) cv[i] = dstNames.indexOf(srcNames[cv[i]!]!); } sortAttachmentWeights(copy); }
        const dst = (((out.skins ??= []).find((s) => s.name === "default") ?? (out.skins.push({ name: "default", attachments: {} }), out.skins.at(-1)!)).attachments ??= {}) as Record<string, Record<string, Att>>;
        (dst[e.slot] ??= {})[from.name] = copy;
        if (dstSlot.attachment !== from.name) dstSlot.attachment = from.name;
        touched.add(`attachment ${e.slot}/${from.name}`);
        applied.push(`mesh ${e.slot}/${from.name} copied from ${basename(e.from)} (${n} vertices, on ${[...used].join(", ")})`);
        break;
      }
    }
  }
  if (!constraints.length) delete out.constraints;
  return { doc: out, applied, touched };
}

/** JSON with sorted keys and empty objects dropped: the same data written in another order compares equal. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => {
  if (!x || typeof x !== "object" || Array.isArray(x)) return x;
  const o = Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([, y]) => !(y && typeof y === "object" && !Array.isArray(y) && !Object.keys(y).length)).sort(([a], [b]) => (a < b ? -1 : 1)));
  return o;
});

/**
 * Differences between two exports of a skeleton (the round trip's losses). Items the edits added are compared too but
 * reported apart (`touched`: Spine filling in its defaults for new bones, constraints and skins is not a loss).
 */
export function roundTripLosses(planned: SkeletonJson, created: SkeletonJson, touched: Set<string> = new Set()): string[] {
  const lost: string[] = [];
  const keyed = <T extends { name: string }>(list: T[] | undefined) => new Map((list ?? []).map((x) => [x.name, canon(x)]));
  const cmp = (label: string, a: Map<string, string>, b: Map<string, string>) => {
    for (const [n, v] of a) {
      if (touched.has(`${label} ${n}`)) continue;
      if (!b.has(n)) lost.push(`${label} ${n}: missing`); else if (b.get(n) !== v) lost.push(`${label} ${n}: ${diffFields(JSON.parse(v), JSON.parse(b.get(n)!))}`);
    }
    for (const n of b.keys()) if (!a.has(n) && !touched.has(`${label} ${n}`)) lost.push(`${label} ${n}: added`);
  };
  cmp("bone", keyed(planned.bones), keyed(created.bones));
  cmp("slot", keyed(planned.slots), keyed(created.slots));
  cmp("constraint", keyed(planned.constraints), keyed(created.constraints));
  cmp("skin", keyed(planned.skins as { name: string }[]), keyed(created.skins as { name: string }[]));
  const ev = (d: SkeletonJson) => new Map(Object.entries(d.events ?? {}).map(([k, v]) => [k, canon(v)]));
  cmp("event", ev(planned), ev(created));
  for (const [k, v] of Object.entries(planned.skeleton)) if (k !== "hash" && k !== "spine" && k !== "images" && k !== "audio" && JSON.stringify(created.skeleton[k]) !== JSON.stringify(v)) lost.push(`skeleton.${k}: ${JSON.stringify(v)} -> ${JSON.stringify(created.skeleton[k])}`);
  for (const name of Object.keys(planned.animations ?? {})) {
    if (!created.animations?.[name]) { lost.push(`animation ${name}: missing`); continue; }
    const d = compareAnimationAcrossDocs(planned, created, name);
    if (!d.equal) lost.push(`animation ${name}: ${d.differences.slice(0, 2).join("; ")}`);
  }
  return lost;
}

/** The first few leaf paths that differ between two JSON values, with both values. */
function diffFields(a: unknown, b: unknown, path = "", out: string[] = []): string {
  if (out.length >= 4) return out.join(", ");
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])]) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffFields(a[k], b[k], path ? `${path}.${k}` : k, out);
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push(`${path || "value"} ${JSON.stringify(a)?.slice(0, 40) ?? "(none)"} -> ${JSON.stringify(b)?.slice(0, 40) ?? "(none)"}`);
  }
  return out.slice(0, 4).join(", ");
}

/**
 * Rig edits (bones, setup pose, IK and physics constraints, events, skins) written into a new project through
 * Spine's JSON import, then both projects exported and compared: everything that differs besides the edits is listed.
 */
export async function rigEdit(config: Config, cli: SpineCli, o: RigEditOptions): Promise<RigEditResult> {
  if (!isAbsolute(o.project) || extname(o.project).toLowerCase() !== ".spine" || !existsSync(o.project)) throw new UserError(`project must be an absolute path to an existing .spine: ${o.project}`);
  if (!isAbsolute(o.output) || extname(o.output).toLowerCase() !== ".spine") throw new UserError(`output must be an absolute path ending in .spine: ${o.output}`);
  if (resolve(o.output) === resolve(o.project)) throw new UserError("output must be a new file: rig edits never overwrite the original (a full re-import drops editor-only data)");
  if (existsSync(o.output)) throw new UserError(`${o.output} already exists; choose a new file`);
  if (!existsSync(dirname(o.output))) throw new UserError(`Folder does not exist: ${dirname(o.output)}`);
  if (!o.edits.length) throw new UserError("No edits");
  const loaded = await loadProject(config, cli, o.project);
  if (loaded.skeletons.length !== 1) throw new UserError(`The project has ${loaded.skeletons.length} skeletons; rig edits handle one-skeleton projects (the others would not be carried over).`);
  const sk = loaded.skeletons[0]!;
  const imagesDir = resolve(dirname(o.project), (sk.doc.skeleton.images as string | undefined) ?? "./images/");
  const sources = new Map<string, SkeletonJson>();
  for (const e of o.edits) if (e.op === "copyMesh" && !sources.has(e.from)) sources.set(e.from, pickSkeleton(await loadProject(config, cli, assertInputPath(e.from, [".spine", ".json"]))).doc);
  const ctx: RigEditContext = {
    image: (path) => { const file = join(imagesDir, `${path}.png`); if (!existsSync(file)) return null; const png = PNG.sync.read(readFileSync(file)); return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) }; },
    source: (path) => sources.get(path),
  };
  const { doc, applied, touched } = applyRigEdits(sk.doc, o.edits, ctx);
  const intake = prepareForImport(doc, folderImages(imagesDir));
  const validateErrors = validateSkeleton(doc).filter((i) => i.severity === "error").map((i) => `${i.code}: ${i.message}`.slice(0, 160));
  const result: RigEditResult = { mode: "dry-run", project: o.project, output: o.output, applied, validateErrors, notes: [...intake] };
  if (validateErrors.length) { result.notes.push("Fix the validation errors first; nothing is written while they remain."); if (o.apply) throw new UserError(`Not writing: ${validateErrors.slice(0, 3).join("; ")}`); return result; }
  if (!o.apply) {
    result.notes.push(`apply: true creates ${o.output} (the original stays as it is) and reports everything the full JSON round trip changes besides these edits.`);
    return result;
  }
  // The skeleton takes the JSON file's name; images and audio stay where the original points.
  const tmp = join(dirname(o.output), `.spine-mcp-rig-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const relDir = (p: string | undefined) => (p ? `${relative(tmp, resolve(dirname(o.project), p)).split(sep).join("/")}/` : undefined);
  const json = join(tmp, `${sk.name}.json`);
  writeFileSync(json, JSON.stringify({ ...doc, skeleton: { ...doc.skeleton, ...(doc.skeleton.images ? { images: relDir(doc.skeleton.images) } : {}), ...(doc.skeleton.audio ? { audio: relDir(doc.skeleton.audio as string) } : {}) } }));
  let run: Awaited<ReturnType<SpineCli["run"]>>;
  try { run = await cli.run(["-i", json, "-o", o.output, "-r"]); } finally { removeQuiet(tmp); }
  if (cliFailed(run) || run.warnings.length || !existsSync(o.output)) { rmSync(o.output, { force: true }); throw new UserError(`Spine import failed: ${[...run.errors, ...run.warnings, ...run.lines.slice(-3)].slice(0, 5).join(" | ")}`); }
  result.mode = "created";
  const created = (await loadProject(config, cli, o.output, { refresh: true })).skeletons[0]!.doc;
  result.lost = roundTripLosses(doc, created, touched);
  const filled = roundTripLosses(doc, created).filter((l) => !result.lost!.includes(l));
  if (filled.length) result.notes.push(`Spine filled in its defaults on the new items: ${filled.slice(0, 6).join("; ")}.`);
  result.sizes = { original: statSync(o.project).size, created: statSync(o.output).size };
  result.notes.push(
    `Created ${basename(o.output)} with: ${applied.join("; ")}. ${result.lost.length ? `${result.lost.length} difference(s) besides the edits (listed in lost).` : "Its export matches the edited skeleton exactly."}`,
    `Editor-only state that Spine's JSON does not carry (view and dopesheet settings, and similar) is not in the new project; the file is ${result.sizes.created} bytes against ${result.sizes.original}. Review it in Spine before replacing the original by hand.`,
  );
  return result;
}
